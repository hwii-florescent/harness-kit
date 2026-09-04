/**
 * Tier A adapter — the real process contract.
 *
 * Spawns `guard.mjs` exactly as Claude Code and Codex would: JSON on stdin,
 * translated verdict on stdout/stderr and in the exit code. The explicit
 * harness argument is part of the contract so an old mode-less wiring cannot
 * silently allow a blocked call.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkTool } from '../src/core/index.mjs';
import { CWD, claude, codex } from './payloads.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.resolve(HERE, '../src/tier-a/guard.mjs');

const ALLOW = 0;
const BLOCK = 2;

function modeArgs(mode) {
  return ['--harness', mode];
}

/** Run the hook the way a harness does. */
function run(payload, args = modeArgs('claude')) {
  const result = spawnSync(process.execPath, [GUARD, ...args], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      HK_NO_GLOBAL_CONFIG: '1',
      HK_LOG_DIR: path.join(HERE, '.tmp-logs'),
    },
  });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('tier A: Claude approval translation', () => {
  test('requests one native approval for an interactive blocked call', () => {
    const payload = { ...claude('Read', { file_path: '.env' }), permission_mode: 'default' };
    const r = run(payload, modeArgs('claude'));
    assert.equal(r.code, ALLOW);
    assert.equal(r.stderr, '');
    assert.deepEqual(JSON.parse(r.stdout), {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: checkTool(payload).reason,
      },
    });
  });

  for (const permission_mode of ['dontAsk', 'bypassPermissions']) {
    test(`keeps ${permission_mode} blocked without prompting`, () => {
      const payload = { ...claude('Read', { file_path: '.env' }), permission_mode };
      const r = run(payload, modeArgs('claude'));
      assert.equal(r.code, BLOCK);
      assert.match(r.stderr, /secrets file/);
      assert.equal(r.stdout, '');
    });
  }
});

describe('tier A: Codex strict translation', () => {
  test('blocks with exit 2 and a reason on stderr', () => {
    const r = run(codex('read', { path: '.env' }), modeArgs('codex'));
    assert.equal(r.code, BLOCK);
    assert.match(r.stderr, /secrets file/);
    assert.equal(r.stdout, '');
  });

  test('the reason is actionable, not just a refusal', () => {
    const payload = { ...claude('Bash', { command: 'ls node_modules' }), permission_mode: 'dontAsk' };
    const r = run(payload, modeArgs('claude'));
    assert.equal(r.code, BLOCK);
    assert.match(r.stderr, /harness-kit/);
    assert.match(r.stderr, /\.harness-kit\.json/, 'should say how to allow it');
  });
});

describe('tier A: allowed calls and event routing', () => {
  for (const mode of ['claude', 'codex']) {
    test(`${mode} allows a safe call with no output`, () => {
      const payload = mode === 'claude'
        ? claude('Read', { file_path: 'src/index.ts' })
        : codex('read', { path: 'src/index.ts' });
      const r = run(payload, modeArgs(mode));
      assert.equal(r.code, ALLOW);
      assert.equal(r.stderr, '');
      assert.equal(r.stdout, '');
    });
  }

  test('UserPromptSubmit returns context JSON and allows', () => {
    const r = run(claude('', {}, 'UserPromptSubmit'), modeArgs('claude'));
    assert.equal(r.code, ALLOW);
    if (r.stdout) {
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
      assert.equal(typeof parsed.hookSpecificOutput.additionalContext, 'string');
    }
  });

  test('ignores events it does not handle', () => {
    const r = run(claude('Read', { file_path: '.env' }, 'PostToolUse'), modeArgs('claude'));
    assert.equal(r.code, ALLOW, 'PostToolUse must not block');
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
  });

  test('defaults to PreToolUse when the event is absent', () => {
    const payload = { cwd: CWD, tool_name: 'Read', tool_input: { file_path: '.env' } };
    const r = run(payload, modeArgs('claude'));
    assert.equal(r.code, ALLOW);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'ask');
  });
});

describe('tier A: invocation mode and fail-open behavior', () => {
  const invalidModes = [
    ['missing mode', []],
    ['incomplete mode', ['--harness']],
    ['extra argument', ['--harness', 'claude', 'extra']],
    ['unknown mode', ['--harness', 'unknown']],
  ];
  for (const [label, args] of invalidModes) {
    test(`${label} remains strict`, () => {
      const r = run(claude('Read', { file_path: '.env' }), args);
      assert.equal(r.code, BLOCK);
      assert.match(r.stderr, /expected exactly --harness claude or --harness codex/);
      assert.equal(r.stdout, '');
    });
  }

  test('invalid mode stays strict even for a safe call', () => {
    const r = run(claude('Read', { file_path: 'src/index.ts' }), []);
    assert.equal(r.code, BLOCK);
    assert.match(r.stderr, /expected exactly --harness claude or --harness codex/);
    assert.equal(r.stdout, '');
  });

  const junk = ['', '   ', 'not json', '{"broken":', 'null', '[]', '{}'];
  for (const input of junk) {
    test(`allows on malformed stdin: ${JSON.stringify(input)}`, () => {
      assert.equal(run(input, modeArgs('claude')).code, ALLOW);
    });
  }
});
