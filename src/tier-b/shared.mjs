/**
 * Tier B adapter — in-process extension. Serves Pi and omp.
 *
 * This implementation intentionally uses only the documented common subset:
 * `pi.on`, `tool_call`, `before_agent_start`, `ctx.cwd`, `ctx.hasUI`, and
 * `ctx.ui.confirm`. omp runs Pi-authored extensions through a compatibility
 * shim, so one implementation covers both.
 *
 * The `.mjs` entry points are loaded through explicit package-manifest
 * entries (`pi install <repo>`, `omp install <repo>`, or `omp plugin install
 * <repo>`), or ad hoc with `-e`; do not rely on loose ambient `.mjs` links.
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
  pi.on('tool_call', async (event, ctx) => {
    try {
      const verdict = checkTool(
        { toolName: event.toolName, input: event.input },
        { cwd: ctx?.cwd },
      );
      if (verdict.blocked) {
        const blocked = { block: true, reason: verdict.reason };
        if (ctx?.hasUI !== true) return blocked;

        const approved = await ctx.ui.confirm(
          'harness-kit: blocked tool call',
          `${verdict.reason}\n\nAllow this exact tool call once?`,
        );
        return approved === true ? undefined : blocked;
      }
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
