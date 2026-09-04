/**
 * The tool names the kit has an opinion about.
 *
 * Defect #9b: this list used to be typed out twice — once as `dev-link.sh`'s
 * `MATCHER` (the regex Claude Code's PreToolUse dispatches on) and again as
 * `replay.mjs`'s `IN_SCOPE` (which transcript calls replay measures) — with
 * nothing tying them together. Adding a tool to one and not the other drifts
 * silently, and the drift is invisible in exactly the place you'd want it
 * caught: replay only reports "not exercised by this corpus" for tools in
 * IN_SCOPE, so a tool missing from that set never shows up as a blind spot —
 * it just quietly never gets measured. One list, two consumers.
 *
 * IMPORTANT — this is not "the tools this install emits":
 *
 *   - This Claude Code build has no `Glob` or `Grep` tool at all — search
 *     goes through `Bash` here. `Glob`/`Grep` stay in the list anyway because
 *     stock Claude Code (and the harness-kit is meant to run on other
 *     people's stock installs) does ship them, per ARCHITECTURE.md §2's shape
 *     table. Do not drop them, and do not add detection of the local
 *     toolset to prune this list automatically — a name here is a static
 *     claim ("the kit has an opinion about this tool if it ever appears"),
 *     not a runtime observation.
 *   - `MultiEdit` similarly does not appear in the corpus and may be retired
 *     in current Claude Code. Kept for the same reason: harmless if unused,
 *     and the kit targets multiple Claude Code versions.
 *
 * Per AGENTS.md trap #5: a clean replay rate for a tool never exercised by
 * the corpus means nothing. Reading `replay.mjs`'s "not exercised" line is
 * how that trap gets caught — not by pruning this list to match one corpus.
 */

/** @type {readonly string[]} */
export const IN_SCOPE_TOOLS = Object.freeze([
  'Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep',
]);

/**
 * Build the `|`-joined matcher string Claude Code's PreToolUse `matcher`
 * field expects (`dev-link.sh`'s `MATCHER`). A plain function rather than a
 * precomputed constant so the shell side and any future consumer both derive
 * it from the same array instead of copying a second string.
 *
 * @param {readonly string[]} [tools]
 * @returns {string}
 */
export function buildMatcher(tools = IN_SCOPE_TOOLS) {
  return tools.join('|');
}
