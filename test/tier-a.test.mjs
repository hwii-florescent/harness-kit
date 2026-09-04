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
import { existsSync, readFileSync, rmSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CWD, CASES, everyHarness, claude, codex } from './payloads.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.resolve(HERE, '../src/tier-a/guard.mjs');

const ALLOW = 0;
const BLOCK = 2;

const LOG_DIR = path.join(HERE, '.tmp-logs');
const CRASH_LOG = path.join(LOG_DIR, 'crash.jsonl');

// The "fails open" cases below log to CRASH_LOG by design (defect #4 is that
// two of the three stdin cases must). Left alone that file grows by a couple
// of lines every `npm test` run, forever — gitignored, but still real disk
// with nothing to prune it. Clear it up front so each run starts clean, and
// again before each case below so line counts are attributable to the case
// that just ran rather than to whatever ran before it in this same process.
function clearCrashLog() {
  rmSync(LOG_DIR, { recursive: true, force: true });
}
clearCrashLog();

/** Every crash-log entry currently on disk, parsed. */
function crashLogEntries() {
  if (!existsSync(CRASH_LOG)) return [];
  return readFileSync(CRASH_LOG, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/** Run the hook the way a harness does. */
function run(payload) {
  const result = spawnSync(process.execPath, [GUARD], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      HK_NO_GLOBAL_CONFIG: '1',
      HK_LOG_DIR: LOG_DIR,
    },
  });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * Run the hook with an fd 0 that genuinely cannot be read — not empty, not a
 * closed non-blocking TTY (EAGAIN/ENXIO, the documented "no stdin" case), but
 * something readFileSync(0) throws on. A directory fd does this portably:
 * reading it is EISDIR on both Linux and macOS, and EISDIR is neither of the
 * two codes guard.mjs treats as expected-empty. This is the "unreadable fd"
 * case defect #4 describes — a broken harness integration, not a quiet day.
 */
function runWithUnreadableStdin() {
  const fd = openSync(HERE, 'r');
  try {
    const result = spawnSync(process.execPath, [GUARD], {
      stdio: [fd, 'pipe', 'pipe'],
      encoding: 'utf8',
      env: {
        ...process.env,
        HK_NO_GLOBAL_CONFIG: '1',
        HK_LOG_DIR: LOG_DIR,
      },
    });
    return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } finally {
    closeSync(fd);
  }
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
  // defect #4: guard.mjs distinguishes three stdin cases that all fail open,
  // but only two of them are supposed to leave a trace. Nothing pinned that
  // distinction — a bare `catch {}` collapsing all three back into one
  // silent case would still pass a test that only checks the exit code.

  test('empty stdin: allow, and no crash-log entry (the expected, documented case)', () => {
    for (const input of ['', '   ']) {
      clearCrashLog();
      const r = run(input);
      assert.equal(r.code, ALLOW);
      assert.deepEqual(crashLogEntries(), [], `empty stdin ${JSON.stringify(input)} must not log a crash`);
    }
  });

  test('stdin that parses but carries no tool call: allow, and no crash-log entry', () => {
    // 'null' and '[]' are valid JSON but not a payload object; guard.mjs
    // normalises them (and '{}') to an empty call rather than treating a
    // successful parse as a parse failure.
    for (const input of ['null', '[]', '{}']) {
      clearCrashLog();
      const r = run(input);
      assert.equal(r.code, ALLOW);
      assert.deepEqual(crashLogEntries(), [], `valid JSON ${input} must not log a crash`);
    }
  });

  test('non-empty stdin that fails JSON.parse: allow, AND a crash-log entry', () => {
    for (const input of ['not json', '{"broken":']) {
      clearCrashLog();
      const r = run(input);
      assert.equal(r.code, ALLOW);
      const entries = crashLogEntries();
      assert.equal(entries.length, 1, `malformed JSON ${JSON.stringify(input)} must log exactly one crash entry`);
      assert.match(entries[0].where, /malformed stdin JSON/);
    }
  });

  test('an unreadable fd (not EAGAIN/ENXIO): allow, AND a crash-log entry', () => {
    clearCrashLog();
    const r = runWithUnreadableStdin();
    assert.equal(r.code, ALLOW);
    const entries = crashLogEntries();
    assert.equal(entries.length, 1, 'an unreadable fd must log exactly one crash entry');
    assert.match(entries[0].where, /stdin unreadable/);
    assert.ok(
      !/EAGAIN|ENXIO/.test(entries[0].error),
      'EAGAIN/ENXIO are the documented no-stdin case and must not reach this path',
    );
  });

  test('a Codex-shaped secret read still blocks', () => {
    assert.equal(run(codex('read', { path: '.env.production' })).code, BLOCK);
  });
});
