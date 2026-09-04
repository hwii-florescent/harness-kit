#!/usr/bin/env node
/**
 * Tier A adapter — process hook. Serves Claude Code and Codex.
 *
 * Contract: read a JSON payload on stdin, decide, translate the verdict for
 * the explicitly selected harness, and exit.
 *
 *   exit 0            allow
 *   exit 2 + stderr   BLOCK for Codex, or for Claude modes without prompting
 *   stdout JSON       Claude's one-shot PreToolUse approval request
 *
 * The core decision is shared. Claude Code can own an interactive prompt via
 * `permissionDecision: "ask"`; Codex does not support that response and stays
 * on the strict exit-2 path.
 */

import { readFileSync } from 'node:fs';
import { checkTool, buildContext } from '../core/index.mjs';
import { logCrash } from '../core/log.mjs';

const EXIT_ALLOW = 0;
const EXIT_BLOCK = 2;
const HARNESS_MODES = new Set(['claude', 'codex']);

function parseHarnessMode(argv) {
  if (argv.length !== 2 || argv[0] !== '--harness' || !HARNESS_MODES.has(argv[1])) return null;
  return argv[1];
}

async function main() {
  const harness = parseHarnessMode(process.argv.slice(2));
  if (!harness) {
    process.stderr.write('harness-kit: expected exactly --harness claude or --harness codex\n');
    return EXIT_BLOCK;
  }

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
    const nonPrompting = payload.permission_mode === 'dontAsk'
      || payload.permission_mode === 'bypassPermissions';
    if (harness === 'claude' && !nonPrompting) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: verdict.reason,
        },
      }));
      return EXIT_ALLOW;
    }
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
