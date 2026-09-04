/**
 * The tool names the kit has an opinion about, and the Claude Code `matcher`
 * built from them.
 *
 * Defect #9b: this list used to be typed out twice — once as `dev-link.sh`'s
 * `MATCHER` (the regex Claude Code's PreToolUse dispatches on) and again as
 * `replay.mjs`'s `IN_SCOPE` (which transcript calls replay measures) — with
 * nothing tying them together. Adding a tool to one and not the other drifts
 * silently, and in the worst direction: replay only reports "not exercised by
 * this corpus" for tools in IN_SCOPE, so a tool missing from the matcher but
 * present here reads as measured-and-clean while no hook ever dispatches on it.
 *
 * WHY src/tier-a/ AND NOT src/core/: every name here is Claude Code's
 * PascalCase spelling, and buildMatcher() produces a Claude Code `matcher`
 * field. Codex sends `shell`/`read`; Pi and omp send lowercase. So this is
 * harness-specific data even though it imports nothing, and invariant #1 is
 * about what the core knows, not merely about its import graph — "adapters
 * translate, the core decides". It lived in src/core/ briefly on the strength
 * of having no imports; that read the invariant mechanically. Its two
 * consumers are scripts/replay.mjs (which reads ~/.claude/projects, a Claude
 * Code corpus) and scripts/dev-link.sh.
 *
 * IMPORTANT — this is not "the tools this install emits":
 *
 *   - This Claude Code build has no `Glob` or `Grep` tool at all — search goes
 *     through `Bash` here. They stay because stock Claude Code does ship them
 *     (ARCHITECTURE.md §6, "Shapes actually observed"), and the kit is meant
 *     to run on other people's stock installs. Do not add detection of the
 *     local toolset to prune this list: a name here is a static claim ("the
 *     kit has an opinion about this tool if it ever appears"), not a runtime
 *     observation, and pruning is how a tool stops being measured anywhere.
 *   - `MultiEdit` and `NotebookEdit` likewise never appear in this corpus.
 *     Kept for the same reason — harmless if unused, and the kit targets
 *     several Claude Code versions, one of which may retire or restore either.
 *
 * Per AGENTS.md trap #5, a clean replay rate for a tool the corpus never
 * exercised means nothing; replay's "not exercised" line is how that gets
 * caught, and it can only name tools that are in this list.
 *
 * Adding a tool here is NOT sufficient on its own. src/core/normalize.mjs's
 * TOOL_KINDS is what decides whether a guardrail can see the tool at all, and
 * a name in this list that normalize() maps to KIND.OTHER is inspected by
 * nothing while replay counts it in scope — the same hole one hop over.
 * test/tools.test.mjs asserts the two agree.
 */

/** @type {readonly string[]} */
export const IN_SCOPE_TOOLS = Object.freeze([
  'Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep',
]);

/**
 * Build the `|`-joined matcher string Claude Code's PreToolUse `matcher` field
 * expects (`dev-link.sh`'s `MATCHER`). A function rather than a precomputed
 * constant so the shell side and any future consumer derive it from the same
 * array instead of copying a second string.
 *
 * dev-link.sh validates the result against its own regex before writing it.
 * That regex constrains what a tool name may contain, so it is asserted
 * against this function in test/tools.test.mjs rather than left as an
 * untested claim on the shell side.
 *
 * @param {readonly string[]} [tools]
 * @returns {string}
 */
export function buildMatcher(tools = IN_SCOPE_TOOLS) {
  return tools.join('|');
}
