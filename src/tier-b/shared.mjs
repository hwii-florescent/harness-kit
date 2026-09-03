/**
 * Tier B adapter — in-process extension. Serves Pi and omp.
 *
 * Pi and omp expose the same extension API (omp runs Pi-authored extensions
 * through a compatibility shim), so one implementation covers both. `pi.mjs`
 * and `omp.mjs` are thin re-exports; if the APIs ever diverge, they are where
 * the divergence goes.
 *
 * Written as .mjs rather than .ts: both harnesses load .ts/.js/.mjs/.cjs, and
 * plain ESM means no build step and no type packages during Phase 0.
 */

import { checkTool, buildContext } from '../core/index.mjs';
import { logCrash } from '../core/log.mjs';

/**
 * @param {object} pi     ExtensionAPI, from Pi or omp.
 * @param {object} [opts]
 * @param {string} [opts.harness]  Label used in crash logs.
 */
export function install(pi, { harness = 'pi' } = {}) {
  // Guardrails. `{ block: true }` is Tier B's equivalent of Tier A's exit 2.
  pi.on('tool_call', (event, ctx) => {
    try {
      const verdict = checkTool(
        { toolName: event.toolName, input: event.input },
        { cwd: ctx?.cwd },
      );
      if (verdict.blocked) return { block: true, reason: verdict.reason };
    } catch (error) {
      logCrash(`tier-b/${harness}/tool_call`, error, { tool: event?.toolName });
    }
    return undefined; // allow
  });

  // Context injection. Pi's analogue of Claude Code's UserPromptSubmit.
  pi.on('before_agent_start', (event, ctx) => {
    try {
      const content = buildContext({ cwd: ctx?.cwd });
      if (content) {
        return { message: { customType: 'harness-kit', content, display: false } };
      }
    } catch (error) {
      logCrash(`tier-b/${harness}/before_agent_start`, error);
    }
    return undefined;
  });
}
