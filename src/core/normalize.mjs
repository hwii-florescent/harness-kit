/**
 * Payload normalisation.
 *
 * Each harness names its tools differently and nests its arguments differently.
 * Everything downstream of this file sees one shape, which is what lets a single
 * `checkTool()` serve Claude Code, Codex, Pi and omp without branching.
 *
 *   Claude Code  { hook_event_name, tool_name: "Bash",  tool_input: {...}, cwd }
 *   Codex        { hook_event_name, tool_name: "shell", tool_input: {...}, cwd }
 *   Pi / omp     { toolName: "bash", input: {...} }            (+ ctx.cwd)
 */

/** Canonical tool kinds. Everything else normalises to `other`. */
export const KIND = {
  SHELL: 'shell',
  READ: 'read',
  WRITE: 'write',
  EDIT: 'edit',
  GLOB: 'glob',
  GREP: 'grep',
  OTHER: 'other',
};

const TOOL_KINDS = new Map(Object.entries({
  // shell
  bash: KIND.SHELL, shell: KIND.SHELL, exec: KIND.SHELL,
  exec_command: KIND.SHELL, run_command: KIND.SHELL, terminal: KIND.SHELL,
  // read
  read: KIND.READ, view: KIND.READ, read_file: KIND.READ, cat: KIND.READ,
  // write
  write: KIND.WRITE, write_file: KIND.WRITE, create_file: KIND.WRITE,
  // edit
  edit: KIND.EDIT, multiedit: KIND.EDIT, apply_patch: KIND.EDIT,
  str_replace: KIND.EDIT, str_replace_editor: KIND.EDIT, notebookedit: KIND.EDIT,
  // discovery
  glob: KIND.GLOB, find: KIND.GLOB, list_files: KIND.GLOB, ls: KIND.GLOB, list: KIND.GLOB,
  grep: KIND.GREP, search: KIND.GREP, ripgrep: KIND.GREP, search_files: KIND.GREP,
}));

const first = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '');

/** Fields that carry a single filesystem path across the four harnesses. */
const PATH_FIELDS = [
  'file_path', 'filePath', 'path', 'notebook_path', 'notebookPath',
  'target_file', 'targetFile', 'filename', 'file',
];

/** On discovery tools these name a directory to search, not a file to touch. */
const DISCOVERY_DIR_FIELDS = new Set(['path', 'dir', 'directory']);

/**
 * Fields that can carry a whole patch as one string.
 *
 * Not every editor takes a `file_path`. omp's hashline editor sends the entire
 * edit as one `input` blob with the target named inside it, so a guardrail
 * looking only at path fields sees nothing at all — including for `.env`.
 *
 * `content` and `text` are deliberately absent: on a Write they hold the whole
 * file, and a document that merely quotes a diff would name paths nobody is
 * touching. A patch arrives in one of these four.
 */
const PATCH_FIELDS = ['input', 'patch', 'diff', 'edits'];

/** `[src/app.ts#F613]` — omp hashline. */
const HASHLINE_TARGET = /\[([^\]\s#]+)#[A-Za-z]?\d+[^\]]*\]/g;

/** `*** Update File: src/app.ts` — apply_patch, used by Codex and others. */
const APPLY_PATCH_TARGET = /^\*\*\*\s+(?:Update|Add|Delete|Move)\s+File:\s*(.+?)\s*$/gm;

/** `+++ b/src/app.ts` — unified diff. */
const UNIFIED_DIFF_TARGET = /^\+\+\+\s+(?:b\/)?([^\s].*?)\s*$/gm;

/** Pull edit targets out of a patch body. */
function patchPaths(input) {
  const out = [];
  for (const field of PATCH_FIELDS) {
    const body = input[field];
    if (typeof body !== 'string' || !body) continue;
    for (const re of [HASHLINE_TARGET, APPLY_PATCH_TARGET, UNIFIED_DIFF_TARGET]) {
      re.lastIndex = 0;
      for (const m of body.matchAll(re)) {
        if (m[1] && m[1] !== '/dev/null') out.push(m[1]);
      }
    }
  }
  return out;
}

/**
 * @param {object} payload  Raw hook/event payload from any harness.
 * @param {object} [extra]  Fallbacks, e.g. `{ cwd }` from a Tier B context.
 * @returns {{
 *   kind: string, rawTool: string, event: string|null,
 *   command: string|null, pattern: string|null, searchRegex: string|null,
 *   searchPath: string|null, boundedRead: boolean,
 *   paths: string[], cwd: string, input: object
 * }}
 */
export function normalize(payload = {}, extra = {}) {
  const rawTool = String(first(payload.tool_name, payload.toolName, payload.tool, '') ?? '');
  const input = first(payload.tool_input, payload.toolInput, payload.input, payload.args) ?? {};

  // str_replace_editor's `command` field selects among
  // view | create | str_replace | insert | undo_edit — only `view` is a read
  // (of a file, or of a whole directory if `path` names one); the other four
  // are genuine writes. The tool is *named* an editor, but a `view` call's
  // *role* is a read — the same spelling-vs-role distinction the rest of
  // normalize.mjs draws for a Grep's `pattern` (defect #5). Misclassifying it
  // as KIND.EDIT let heavy-path's WRITE/EDIT early return (defect #6) past an
  // unbounded directory read it should still catch. No wired harness in
  // ARCHITECTURE.md's observed-shapes table has been captured sending this
  // tool, so the hole is unverified live, but it is real in code as written:
  // `str_replace_editor` is Anthropic's documented text-editor tool shape.
  const kind = rawTool.toLowerCase() === 'str_replace_editor' && input.command === 'view'
    ? KIND.READ
    : TOOL_KINDS.get(rawTool.toLowerCase()) ?? KIND.OTHER;

  const command = first(input.command, input.cmd, input.script) ?? null;

  // A grep tool's `pattern` is a regex, never a glob or a path — treating it
  // as one is defect #5 (ARCHITECTURE.md §7). It is uniform across all four
  // harnesses (Claude Code, Pi and omp all send `{pattern, glob}`; Codex has
  // no native grep) so no branching is needed: for KIND.GREP, `pattern` on
  // the normalised call comes from `input.glob` — the file-name filter —
  // only, and the regex is carried separately as `searchRegex` so no
  // guardrail can mistake a search term for something that names a file.
  const searchRegex = kind === KIND.GREP ? (first(input.pattern) ?? null) : null;
  const pattern = kind === KIND.GREP
    ? (first(input.glob, input.globPattern) ?? null)
    : (first(input.pattern, input.glob, input.globPattern) ?? null);

  // Claude Code's Read takes a `limit`, which makes it bounded by
  // construction — the structured-tool equivalent of `sed -n '30,60p'` in
  // bash.mjs's `isBoundedRead`. But "the field is present" is not "the read
  // is bounded": `limit: false`, `limit: {}` and `limit: -1` are not bounds
  // in any sense, and `limit: 999999` is a bound in name only. `offset` alone
  // (no `limit`) reads to EOF, so it no longer counts by itself — assuming a
  // harness applies some default page size on top of a bare offset would bake
  // an assumption about harness internals into src/core/, which invariant #1
  // and traps #3/#5 exist to forbid. 1000 is an arbitrary but generous
  // ceiling: comfortably above every real Read call seen in replay (the
  // largest is `limit: 40`) and far below the abuse shapes this guardrail
  // exists to catch (999999). An unbounded read of the same path is still in
  // scope; only the volume judgement changes.
  const limit = input.limit;
  const boundedRead = kind === KIND.READ
    && typeof limit === 'number' && Number.isFinite(limit) && limit > 0 && limit <= 1000;

  // For discovery tools `path` is the directory being searched, not a target
  // file — broad-glob needs it separately to judge how wide the search is, and
  // it must not also appear as a target path or the two would double-count.
  const isDiscovery = kind === KIND.GLOB || kind === KIND.GREP;
  let searchPath = isDiscovery
    ? (first(input.path, input.dir, input.directory) ?? null)
    : null;
  let globPattern = pattern;

  // omp's glob tool has no `pattern` field: the whole expression arrives in
  // `path` (`{ path: "**/*.ts" }`). Split it at the first wildcard segment so
  // the guardrail sees the same pattern/searchPath pair every other harness
  // sends — without this, broadGlob simply never fires on omp.
  if (kind === KIND.GLOB && !globPattern && typeof searchPath === 'string' && /[*?[{]/.test(searchPath)) {
    const segs = searchPath.split('/');
    const wild = segs.findIndex((seg) => /[*?[{]/.test(seg));
    globPattern = segs.slice(wild).join('/');
    searchPath = wild > 0 ? segs.slice(0, wild).join('/') : null;
  }

  const paths = [];
  for (const field of PATH_FIELDS) {
    if (isDiscovery && DISCOVERY_DIR_FIELDS.has(field)) continue;
    if (typeof input[field] === 'string' && input[field]) paths.push(input[field]);
  }
  if (Array.isArray(input.paths)) paths.push(...input.paths.filter((p) => typeof p === 'string'));
  if (Array.isArray(input.files)) paths.push(...input.files.filter((p) => typeof p === 'string'));
  if (kind === KIND.EDIT || kind === KIND.WRITE) paths.push(...patchPaths(input));

  return {
    kind,
    rawTool,
    event: first(payload.hook_event_name, payload.hookEventName, payload.event) ?? null,
    command,
    pattern: globPattern,
    searchRegex,
    searchPath,
    boundedRead,
    paths,
    cwd: first(payload.cwd, extra.cwd, process.cwd()),
    input,
  };
}
