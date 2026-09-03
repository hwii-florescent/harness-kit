/**
 * Tier A adapter — the real process contract.
 *
 * Spawns `guard.mjs` exactly as Claude Code and Codex would: JSON on stdin,
 * verdict in the exit code. Asserting on the spawned process rather than on an
 * imported function is the point — the exit code *is* the contract, and both
 * harnesses read it identically.
 *
 * Stays inside the repo: the subprocess is our own file, cwd is a fixture path
 * that is never written to, and HK_LOG_DIR is redirected under test/.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CWD, CASES, everyHarness, claude, codex } from './payloads.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.resolve(HERE, '../src/tier-a/guard.mjs');

const ALLOW = 0;
const BLOCK = 2;

/** Run the hook the way a harness does. */
function run(payload) {
  const result = spawnSync(process.execPath, [GUARD], {
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

describe('tier A: exit-code contract', () => {
  test('blocks with exit 2 and a reason on stderr', () => {
    const r = run(claude('Read', { file_path: '.env' }));
    assert.equal(r.code, BLOCK);
    assert.match(r.stderr, /secrets file/);
    assert.equal(r.stdout, '', 'must not print JSON when blocking via exit code');
  });

  test('allows with exit 0 and no output', () => {
    const r = run(claude('Read', { file_path: 'src/index.ts' }));
    assert.equal(r.code, ALLOW);
    assert.equal(r.stderr, '');
    assert.equal(r.stdout, '');
  });

  test('the reason is actionable, not just a refusal', () => {
    const r = run(claude('Bash', { command: 'ls node_modules' }));
    assert.equal(r.code, BLOCK);
    assert.match(r.stderr, /harness-kit/);
    assert.match(r.stderr, /\.harness-kit\.json/, 'should say how to allow it');
  });
});

describe('tier A: Claude Code and Codex agree', () => {
  for (const [name, spec] of Object.entries(CASES)) {
    test(`${name}`, () => {
      const claudePayload = everyHarness(spec).find(([l]) => l === 'claude')[1];
      const codexPayload = everyHarness(spec).find(([l]) => l === 'codex')[1];
      assert.equal(
        run(claudePayload).code,
        run(codexPayload).code,
        'Claude Code and Codex must reach the same exit code',
      );
    });
  }
});

describe('tier A: event routing', () => {
  test('UserPromptSubmit returns context JSON and allows', () => {
    const r = run(claude('', {}, 'UserPromptSubmit'));
    assert.equal(r.code, ALLOW);
    if (r.stdout) {
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
      assert.equal(typeof parsed.hookSpecificOutput.additionalContext, 'string');
    }
  });

  test('ignores events it does not handle', () => {
    const r = run(claude('Read', { file_path: '.env' }, 'PostToolUse'));
    assert.equal(r.code, ALLOW, 'PostToolUse must not block');
  });

  test('defaults to PreToolUse when the event is absent', () => {
    const r = run({ cwd: CWD, tool_name: 'Read', tool_input: { file_path: '.env' } });
    assert.equal(r.code, BLOCK);
  });
});

describe('tier A: fails open', () => {
  const junk = ['', '   ', 'not json', '{"broken":', 'null', '[]', '{}'];
  for (const input of junk) {
    test(`allows on malformed stdin: ${JSON.stringify(input)}`, () => {
      assert.equal(run(input).code, ALLOW);
    });
  }

  test('a Codex-shaped secret read still blocks', () => {
    assert.equal(run(codex('read', { path: '.env.production' })).code, BLOCK);
  });
});
