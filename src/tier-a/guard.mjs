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

async function main() {
  let payload = {};
  try {
    const raw = readFileSync(0, 'utf8').trim();
    if (raw) {
      const parsed = JSON.parse(raw);
      // `null` and `[]` are valid JSON but carry no tool call. Normalise them to
      // an empty object so the rest of the function needs no null guards, and so
      // an empty payload never registers as a crash.
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed;
    }
  } catch {
    // No stdin, or malformed JSON. Nothing to judge — allow.
    return EXIT_ALLOW;
  }

  const event = payload.hook_event_name ?? payload.hookEventName ?? payload.event ?? 'PreToolUse';

  if (event === 'UserPromptSubmit') {
    const additionalContext = buildContext({ cwd: payload.cwd });
    if (additionalContext) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext },
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
