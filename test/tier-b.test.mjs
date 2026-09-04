/**
 * Tier B adapter — the in-process extension contract.
 *
 * Drives the adapter through a fake ExtensionAPI shaped like Pi's and omp's:
 * `pi.on(event, handler)`, handlers returning `{ block: true, reason }` to stop
 * a tool call. The fake event bus awaits handlers because approval dialogs are
 * asynchronous on both documented surfaces.
 */

process.env.HK_NO_GLOBAL_CONFIG = '1';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import piExtension from '../src/tier-b/pi.mjs';
import ompExtension from '../src/tier-b/omp.mjs';
import { checkTool } from '../src/core/index.mjs';
import { CWD, CASES, everyHarness, pi as piPayload } from './payloads.mjs';

/** Minimal stand-in for Pi/omp's ExtensionAPI. */
function fakePi() {
  const handlers = new Map();
  return {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    /** Invoke every handler for an event, returning the first non-undefined result. */
    async emit(event, payload, ctx = { cwd: CWD }) {
      for (const handler of handlers.get(event) ?? []) {
        const result = await handler(payload, ctx);
        if (result !== undefined) return result;
      }
      return undefined;
    },
    events: () => [...handlers.keys()],
  };
}

function mount(extension) {
  const api = fakePi();
  extension(api);
  return api;
}

function secretReason() {
  return checkTool(piPayload('read', { path: '.env' }), { cwd: CWD }).reason;
}

for (const [name, extension] of [['pi', piExtension], ['omp', ompExtension]]) {
  describe(`tier B: ${name}`, () => {
    test('subscribes to the events it needs and nothing else', () => {
      const api = mount(extension);
      assert.deepEqual(api.events().sort(), ['before_agent_start', 'tool_call']);
    });

    test('blocks a secret read without UI', async () => {
      const api = mount(extension);
      const result = await api.emit('tool_call', piPayload('read', { path: '.env' }));
      assert.equal(result?.block, true);
      assert.match(result.reason, /secrets file/);
    });

    test('approves one blocked call through the UI', async () => {
      const api = mount(extension);
      const confirmations = [];
      const result = await api.emit(
        'tool_call',
        piPayload('read', { path: '.env' }),
        {
          cwd: CWD,
          hasUI: true,
          ui: { confirm: async (...args) => { confirmations.push(args); return true; } },
        },
      );

      assert.equal(result, undefined);
      assert.deepEqual(confirmations, [[
        'harness-kit: blocked tool call',
        `${secretReason()}${String.fromCharCode(10, 10)}Allow this exact tool call once?`,
      ]]);
    });

    test('returns the original block when approval is denied', async () => {
      const api = mount(extension);
      const result = await api.emit(
        'tool_call',
        piPayload('read', { path: '.env' }),
        { cwd: CWD, hasUI: true, ui: { confirm: async () => false } },
      );
      assert.deepEqual(result, { block: true, reason: secretReason() });
    });

    test('does not prompt when UI is unavailable', async () => {
      const api = mount(extension);
      let prompts = 0;
      const result = await api.emit(
        'tool_call',
        piPayload('read', { path: '.env' }),
        {
          cwd: CWD,
          hasUI: false,
          ui: { confirm: async () => { prompts++; return true; } },
        },
      );
      assert.equal(result?.block, true);
      assert.equal(prompts, 0);
    });

    test('allows an ordinary read without prompting', async () => {
      const api = mount(extension);
      let prompts = 0;
      const result = await api.emit(
        'tool_call',
        piPayload('read', { path: 'src/a.ts' }),
        { cwd: CWD, hasUI: true, ui: { confirm: async () => { prompts++; return true; } } },
      );
      assert.equal(result, undefined);
      assert.equal(prompts, 0);
    });

    test('fails open and logs a rejected confirmation', async (t) => {
      const logDir = fs.mkdtempSync(path.join(os.tmpdir(), `harness-kit-${name}-logs-`));
      t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
      const previous = process.env.HK_LOG_DIR;
      process.env.HK_LOG_DIR = logDir;
      try {
        const api = mount(extension);
        const result = await api.emit(
          'tool_call',
          piPayload('read', { path: '.env' }),
          { cwd: CWD, hasUI: true, ui: { confirm: async () => { throw new Error('dialog failed'); } } },
        );
        assert.equal(result, undefined);
        const log = fs.readFileSync(path.join(logDir, 'crash.jsonl'), 'utf8');
        assert.match(log, new RegExp(`tier-b/${name}/tool_call`));
        assert.match(log, /dialog failed/);
      } finally {
        if (previous === undefined) delete process.env.HK_LOG_DIR;
        else process.env.HK_LOG_DIR = previous;
      }
    });

    test('blocks heavy-directory exploration without UI', async () => {
      const api = mount(extension);
      assert.equal(
        (await api.emit('tool_call', piPayload('bash', { command: 'ls node_modules' })))?.block,
        true,
      );
    });

    test('does not block the build', async () => {
      const api = mount(extension);
      assert.equal(await api.emit('tool_call', piPayload('bash', { command: 'npm run build' })), undefined);
    });

    test('injects context on before_agent_start', async () => {
      const api = mount(extension);
      const result = await api.emit('before_agent_start', { prompt: 'hi' });
      if (result) {
        assert.equal(result.message.customType, 'harness-kit');
        assert.equal(typeof result.message.content, 'string');
      }
    });

    test('fails open on a malformed event', async () => {
      const api = mount(extension);
      assert.equal(await api.emit('tool_call', { toolName: 'read', input: null }), undefined);
      assert.equal(await api.emit('tool_call', {}), undefined);
    });

    test('falls back to ctx.cwd when the event carries none', async () => {
      const api = mount(extension);
      const result = await api.emit(
        'tool_call',
        piPayload('glob', { pattern: '**/*.ts', path: '.' }),
        { cwd: CWD },
      );
      assert.equal(result?.block, true);
    });
  });
}
describe('tier B: matches tier A', () => {
  // Same six canonical cases as the core suite, through both extension surfaces.
  const expectations = {
    readSecret: true, readSafeExample: false,
    listHeavyDir: true, buildCommand: false,
    broadGlob: true, scopedGlob: false,
  };

  for (const [name, extension] of [['pi', piExtension], ['omp', ompExtension]]) {
    for (const [caseName, shouldBlock] of Object.entries(expectations)) {
      test(`${name}: ${caseName}`, async () => {
        const api = mount(extension);
        const [, payload] = everyHarness(CASES[caseName]).find(([l]) => l === 'pi');
        const result = await api.emit('tool_call', payload, { cwd: CWD, hasUI: false });
        assert.equal(result?.block === true, shouldBlock);
      });
    }
  }
});
