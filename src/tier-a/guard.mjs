#!/usr/bin/env node
/**
 * Tier A adapter — process hook. Serves Claude Code and Codex, unmodified.
 *
 * Contract: read a JSON payload on stdin, decide, exit.
 *
 *   exit 0            allow
 *   exit 2 + stderr   BLOCK, with the reason on stderr
 *
 * Blocking uses the exit code rather than `permissionDecision` JSON on purpose.
 * Both harnesses honour exit 2 identically, whereas Codex reserves
 * `permissionDecision: "allow"` for responses that also carry `updatedInput`
 * and will reject a bare allow. One code path, two harnesses, no branching.
 *
 * JSON on stdout is used only for context injection, where the shapes agree.
 */

import { readFileSync } from 'node:fs';
import { checkTool, buildContext } from '../core/index.mjs';
import { logCrash } from '../core/log.mjs';

const EXIT_ALLOW = 0;
const EXIT_BLOCK = 2;

// Both events only ever inject context, never block, so they share one
// branch below. Which phase each gets is the whole point of the split in
// context.mjs: SessionStart fires once per session and carries the
// invariant guardrail-hook paragraph; UserPromptSubmit fires every turn and
// — see context.mjs's header — has nothing to say today.
//
// dev-link.sh wires SessionStart only now — UserPromptSubmit was dropped
// from the default wiring because a hook whose only correct output is
// silence is indistinguishable from a broken one (see its comment at the
// removed call site). UserPromptSubmit is kept here anyway: a machine still
// carrying the previous commit's entry, or anyone who hand-wires it for a
// real per-turn signal later, gets the same harmless allow-and-maybe-inject
// behaviour instead of falling through to a different code path below. This
// does not reopen defect #1 (context injection never running on Claude
// Code) — that stays closed via SessionStart regardless of what this map
// does with an event nothing sends by default.
const CONTEXT_PHASE = { SessionStart: 'session', UserPromptSubmit: 'turn' };

// A closed or empty stdin — the harness ran the hook with nothing to send, or
// stdin is a non-blocking TTY with no data queued — surfaces as one of these
// two codes and is expected and documented. Anything else (EIO, EBADF, a
// permission error) means the fd genuinely couldn't be read: a broken
// integration on the harness's side, not a quiet day, and exactly the kind of
// half-absence defect #4 was raised to make visible. It must still fail open
// (invariant #4 is non-negotiable — never exit non-zero on an internal
// error), but it must not be swallowed silently like the expected case.
const EXPECTED_NO_STDIN_CODES = new Set(['EAGAIN', 'ENXIO']);

async function main() {
  let payload = {};
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8').trim();
  } catch (error) {
    if (!EXPECTED_NO_STDIN_CODES.has(error?.code)) {
      logCrash('tier-a/guard: stdin unreadable', error);
    }
    return EXIT_ALLOW;
  }

  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      // `null` and `[]` are valid JSON but carry no tool call. Normalise them to
      // an empty object so the rest of the function needs no null guards, and so
      // an empty payload never registers as a crash.
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed;
    } catch (error) {
      // Non-empty stdin that isn't valid JSON — a broken harness integration,
      // not the documented "no stdin" case. Still allow (fail-open is
      // invariant #4) but this must be visible: it used to be silently
      // swallowed by a bare `catch {}` that treated it the same as empty
      // stdin, so a wedged hook looked identical to a quiet day. Defect #4.
      logCrash('tier-a/guard: malformed stdin JSON', error);
      return EXIT_ALLOW;
    }
  }

  const event = payload.hook_event_name ?? payload.hookEventName ?? payload.event ?? 'PreToolUse';

  if (event in CONTEXT_PHASE) {
    const additionalContext = buildContext({ cwd: payload.cwd, phase: CONTEXT_PHASE[event] });
    if (additionalContext) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: event, additionalContext },
      }));
    }
    return EXIT_ALLOW;
  }

  if (event !== 'PreToolUse') return EXIT_ALLOW;

  const verdict = checkTool(payload);
  if (verdict.blocked) {
    process.stderr.write(verdict.reason + '\n');
    return EXIT_BLOCK;
  }
  return EXIT_ALLOW;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    // Fail open. A crashed guardrail must never block a session.
    logCrash('tier-a/guard', error);
    process.exit(EXIT_ALLOW);
  });
