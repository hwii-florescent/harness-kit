/**
 * Tier B adapter — the in-process extension contract.
 *
 * Drives the adapter through a fake ExtensionAPI shaped like Pi's and omp's:
 * `pi.on(event, handler)`, handlers returning `{ block: true, reason }` to stop
 * a tool call. No harness binary is launched — the contract under test is the
 * handler's return value.
 */

process.env.HK_NO_GLOBAL_CONFIG = '1';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import piExtension from '../src/tier-b/pi.mjs';
import ompExtension from '../src/tier-b/omp.mjs';
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
    emit(event, payload, ctx = { cwd: CWD }) {
      for (const handler of handlers.get(event) ?? []) {
        const result = handler(payload, ctx);
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

for (const [name, extension] of [['pi', piExtension], ['omp', ompExtension]]) {
  describe(`tier B: ${name}`, () => {
    test('subscribes to the events it needs and nothing else', () => {
      const api = mount(extension);
      assert.deepEqual(api.events().sort(), ['before_agent_start', 'tool_call']);
    });

    test('blocks a secret read', () => {
      const api = mount(extension);
      const result = api.emit('tool_call', piPayload('read', { path: '.env' }));
      assert.equal(result?.block, true);
      assert.match(result.reason, /secrets file/);
    });

    test('allows an ordinary read by returning undefined', () => {
      const api = mount(extension);
      assert.equal(api.emit('tool_call', piPayload('read', { path: 'src/a.ts' })), undefined);
    });

    test('blocks heavy-directory exploration', () => {
      const api = mount(extension);
      assert.equal(api.emit('tool_call', piPayload('bash', { command: 'ls node_modules' }))?.block, true);
    });

    test('does not block the build', () => {
      const api = mount(extension);
      assert.equal(api.emit('tool_call', piPayload('bash', { command: 'npm run build' })), undefined);
    });

    test('injects context on before_agent_start', () => {
      const api = mount(extension);
      const result = api.emit('before_agent_start', { prompt: 'hi' });
      if (result) {
        assert.equal(result.message.customType, 'harness-kit');
        assert.equal(typeof result.message.content, 'string');
      }
    });

    test('fails open on a malformed event', () => {
      const api = mount(extension);
      assert.equal(api.emit('tool_call', { toolName: 'read', input: null }), undefined);
      assert.equal(api.emit('tool_call', {}), undefined);
    });

    test('falls back to ctx.cwd when the event carries none', () => {
      const api = mount(extension);
      const result = api.emit('tool_call', piPayload('glob', { pattern: '**/*.ts', path: '.' }), { cwd: CWD });
      assert.equal(result?.block, true);
    });
  });
}

describe('tier B: matches tier A', () => {
  // Same six canonical cases as the core suite, through the extension surface.
  const expectations = {
    readSecret: true, readSafeExample: false,
    listHeavyDir: true, buildCommand: false,
    broadGlob: true, scopedGlob: false,
  };

  for (const [caseName, shouldBlock] of Object.entries(expectations)) {
    test(caseName, () => {
      const api = mount(piExtension);
      const [, payload] = everyHarness(CASES[caseName]).find(([l]) => l === 'pi');
      const result = api.emit('tool_call', payload);
      assert.equal(result?.block === true, shouldBlock);
    });
  }
});
