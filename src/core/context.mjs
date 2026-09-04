/**
 * Context injection — the non-blocking half of "hooks".
 *
 * Two phases, paid for on different schedules:
 *
 *   'session' — SessionStart (Claude Code, Codex), before_agent_start (Pi,
 *     omp — already fires once per session start, not per turn). The
 *     invariant guardrail-hook paragraph. It never changes within a session,
 *     so it is built once and never again.
 *
 *   'turn' — UserPromptSubmit (Claude Code, Codex). Only what can change
 *     between turns of the SAME session. See below for why that's nothing
 *     today.
 *
 * The split exists because injected context accumulates in the transcript —
 * a real two-turn session was observed holding two copies of the old
 * combined block, so the cost was ~72 (invariant) + ~10 (project line)
 * tokens times every turn, forever. Paying the invariant paragraph once
 * instead of on every turn is the entire point; see ARCHITECTURE.md §11.
 *
 * The project/lockfile line ("- Project: node · npm (lockfile)") that used
 * to ride along on every turn is gone, not relocated to 'session'. It never
 * actually earned the bar stated below — a lockfile is one `ls` away — and
 * moving its cost from "every turn" to "once per session" doesn't fix that;
 * it just makes the violation smaller. So `buildContext` called with phase
 * 'turn' returns '' today. That is a legitimate outcome under this
 * function's existing contract, not a bug — but it does mean the
 * UserPromptSubmit hook has nothing to say on every single invocation it
 * fires. Whether that hook is still worth the process spawn is a design
 * question this file doesn't resolve on its own — it was resolved in
 * dev-link.sh, which no longer wires the event by default; see its comment
 * for the reasoning. guard.mjs still handles UserPromptSubmit if it arrives.
 *
 * Kept deliberately small. Injected context is paid for on every turn it
 * fires on, so anything here must earn its tokens — state the agent cannot
 * cheaply discover for itself, and nothing more. Project conventions belong
 * in AGENTS.md, not here.
 */

import { loadConfig } from './config.mjs';
import { logCrash } from './log.mjs';

// Deliberately does NOT name the active guardrails.
//
// An earlier version listed them ("Guardrails active: secret, heavyPath,
// broadGlob"). Live testing showed agents then *simulated* the rules instead
// of relying on them: asked to run `grep -rn "build" src`, the model saw the
// word "build", decided heavy-path would object, and refused — a call the
// guardrail allows. That failure is worse than a false block, because
// nothing is logged and no reason is shown; the work simply does not happen.
// So: say a hook exists, say what a block looks like, and tell the agent not
// to anticipate it. See ARCHITECTURE.md §11 / AGENTS.md trap 2.
const GUARDRAIL_HOOK_LINE =
  '- A guardrail hook may block a tool call and return a reason. ' +
  'Do not try to predict it and do not refuse pre-emptively — make the ' +
  'call you would normally make. If it is blocked you will get an ' +
  'explanation and a suggested alternative; act on that rather than ' +
  'retrying the same call.';

function anyGuardrailEnabled(config) {
  return Object.values(config.guardrails ?? {}).some((v) => v?.enabled !== false);
}

/**
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {'session'|'turn'} [opts.phase]  Which slice of context to build.
 *   Defaults to 'turn' — the higher-frequency, currently-empty case — so a
 *   call site that forgets to pass phase fails toward injecting nothing
 *   rather than toward silently re-injecting the guardrail paragraph on
 *   every turn.
 * @returns {string} Markdown block, or '' when there is nothing worth saying.
 */
export function buildContext({ cwd = process.cwd(), phase = 'turn' } = {}) {
  try {
    // 'turn' has nothing to inject — see the file header for why that's
    // intentional rather than an oversight.
    if (phase !== 'session') return '';

    const config = loadConfig({ cwd });
    if (!anyGuardrailEnabled(config)) return '';

    return ['## harness-kit', GUARDRAIL_HOOK_LINE].join('\n');
  } catch (error) {
    logCrash('buildContext', error);
    return '';
  }
}
