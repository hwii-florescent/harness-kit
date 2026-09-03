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
  glob: KIND.GLOB, find: KIND.GLOB, list_files: KIND.GLOB, ls: KIND.GLOB,
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
 * @param {object} payload  Raw hook/event payload from any harness.
 * @param {object} [extra]  Fallbacks, e.g. `{ cwd }` from a Tier B context.
 * @returns {{
 *   kind: string, rawTool: string, event: string|null,
 *   command: string|null, pattern: string|null, searchPath: string|null,
 *   paths: string[], cwd: string, input: object
 * }}
 */
export function normalize(payload = {}, extra = {}) {
  const rawTool = String(first(payload.tool_name, payload.toolName, payload.tool, '') ?? '');
  const input = first(payload.tool_input, payload.toolInput, payload.input, payload.args) ?? {};
  const kind = TOOL_KINDS.get(rawTool.toLowerCase()) ?? KIND.OTHER;

  const command = first(input.command, input.cmd, input.script) ?? null;
  const pattern = first(input.pattern, input.glob, input.globPattern) ?? null;

  // For discovery tools `path` is the directory being searched, not a target
  // file — broad-glob needs it separately to judge how wide the search is, and
  // it must not also appear as a target path or the two would double-count.
  const isDiscovery = kind === KIND.GLOB || kind === KIND.GREP;
  const searchPath = isDiscovery
    ? (first(input.path, input.dir, input.directory) ?? null)
    : null;

  const paths = [];
  for (const field of PATH_FIELDS) {
    if (isDiscovery && DISCOVERY_DIR_FIELDS.has(field)) continue;
    if (typeof input[field] === 'string' && input[field]) paths.push(input[field]);
  }
  if (Array.isArray(input.paths)) paths.push(...input.paths.filter((p) => typeof p === 'string'));
  if (Array.isArray(input.files)) paths.push(...input.files.filter((p) => typeof p === 'string'));

  return {
    kind,
    rawTool,
    event: first(payload.hook_event_name, payload.hookEventName, payload.event) ?? null,
    command,
    pattern,
    searchPath,
    paths,
    cwd: first(payload.cwd, extra.cwd, process.cwd()),
    input,
  };
}
