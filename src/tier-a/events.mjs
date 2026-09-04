/**
 * Which context phase each Tier A hook event maps to.
 *
 * Lives in its own module, not inline in guard.mjs, for one reason: guard.mjs
 * calls main() at import time, so a test cannot import it to inspect this map
 * without running the guard. Splitting it out is what makes the mapping
 * directly assertable — see test/tier-a.test.mjs.
 *
 * It is deliberately NOT in src/core/. These are Claude Code / Codex event
 * names, and invariant #1 is that src/core/ imports nothing harness-specific.
 *
 * Both events only ever inject context, never block. SessionStart fires once
 * per session and carries the invariant guardrail-hook paragraph.
 * UserPromptSubmit fires every turn and has nothing to say today, so
 * dev-link.sh no longer wires it — a hook whose only correct output is silence
 * is indistinguishable from a broken one. It is still mapped here on purpose:
 * a machine carrying an older entry, or anyone hand-wiring a real per-turn
 * signal later, gets the same allow-and-maybe-inject behaviour rather than
 * falling through to the generic unhandled-event branch, which behaves
 * differently the moment buildContext() gains turn-phase content.
 */
export const CONTEXT_PHASE = Object.freeze({
  SessionStart: 'session',
  UserPromptSubmit: 'turn',
});
