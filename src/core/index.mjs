/**
 * harness-kit core — the only place guardrail logic lives.
 *
 * No harness imports, no process.exit, no stdout. Adapters normalise a payload
 * in and translate the verdict out; everything between is here and is identical
 * on Claude Code, Codex, Pi and omp.
 */

import { loadConfig } from './config.mjs';
import { normalize } from './normalize.mjs';
import { logCrash } from './log.mjs';
import { buildContext } from './context.mjs';

import * as secret from './guardrails/secret.mjs';
import * as heavyPath from './guardrails/heavy-path.mjs';
import * as broadGlob from './guardrails/broad-glob.mjs';

/** Order matters: the most serious verdict should be the one the user sees. */
const GUARDRAILS = [secret, heavyPath, broadGlob];

const ALLOW = Object.freeze({ blocked: false });

/**
 * Decide whether a tool call may proceed.
 *
 * Always fails open: any internal error allows the call and leaves a crash log
 * entry. A guardrail that bricks a session gets uninstalled and never returns.
 *
 * @param {object} payload  Raw hook/event payload from any harness.
 * @param {object} [opts]
 * @param {string} [opts.cwd]        Fallback when the payload omits it.
 * @param {object} [opts.config]     Pre-loaded config; skips disk reads.
 * @param {object} [opts.overrides]  Config overrides, used by tests.
 * @returns {{ blocked: boolean, guardrail?: string, rule?: string, target?: string, reason?: string }}
 */
export function checkTool(payload, opts = {}) {
  // A non-object payload carries no tool call to judge. This is an expected
  // condition, not a fault — handle it before the try/catch so it does not
  // register as a crash and drown real faults in the log.
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ALLOW;

  try {
    const call = normalize(payload, opts);
    const config = opts.config ?? loadConfig({ cwd: call.cwd, overrides: opts.overrides });

    for (const guardrail of GUARDRAILS) {
      const verdict = guardrail.check(call, config);
      if (verdict?.blocked) return verdict;
    }
    return ALLOW;
  } catch (error) {
    logCrash('checkTool', error, { tool: payload?.tool_name ?? payload?.toolName });
    return ALLOW;
  }
}

export { buildContext, loadConfig, normalize };
export { KIND } from './normalize.mjs';
