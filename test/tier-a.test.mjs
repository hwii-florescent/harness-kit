/**
 * Tier A adapter — the real process contract.
 *
 * Spawns `guard.mjs` exactly as Claude Code and Codex would: JSON on stdin,
 * verdict in the exit code. Asserting on the spawned process rather than on an
 * imported function is the point — the exit code *is* the contract, and both
 * harnesses read it identically.
 *
 * Stays inside the repo: the subprocess is our own file, cwd is a fixture path
 * that is never written to, and HK_LOG_DIR is always redirected — to a shared
 * dir under test/ for cases that don't inspect it, or a private mkdtemp'd dir
 * per case for the ones that do (never the kit's real `.local/crash.jsonl`).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, openSync, closeSync, mkdtempSync, constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CWD, CASES, everyHarness, claude, codex } from './payloads.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.resolve(HERE, '../src/tier-a/guard.mjs');

const ALLOW = 0;
const BLOCK = 2;

// Default log dir for tests that don't inspect the crash log — they still
// must not write into the real `<kit>/.local/crash.jsonl`. Cases that DO
// assert on crash-log contents (the "fails open" describe block) get their
// own mkdtemp'd dir per case instead of sharing this one: a shared dir plus
// node:test's sequential default is an invisible coupling — concurrency, or
// a second file pointed at the same dir, would silently break the exact-
// count assertions there. Isolation costs nothing and removes the coupling.
const LOG_DIR = path.join(HERE, '.tmp-logs');
rmSync(LOG_DIR, { recursive: true, force: true });

/** Every crash-log entry on disk under `dir`, parsed. */
function crashLogEntriesFrom(dir) {
  const file = path.join(dir, 'crash.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/** A fresh, private crash-log dir for one case — see the LOG_DIR comment above. */
function withIsolatedLogDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hk-tier-a-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run the hook the way a harness does. */
function run(payload, { logDir = LOG_DIR } = {}) {
  const result = spawnSync(process.execPath, [GUARD], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      HK_NO_GLOBAL_CONFIG: '1',
      HK_LOG_DIR: logDir,
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
function runWithUnreadableStdin(logDir = LOG_DIR) {
  const fd = openSync(HERE, 'r');
  try {
    const result = spawnSync(process.execPath, [GUARD], {
      stdio: [fd, 'pipe', 'pipe'],
      encoding: 'utf8',
      env: {
        ...process.env,
        HK_NO_GLOBAL_CONFIG: '1',
        HK_LOG_DIR: logDir,
      },
    });
    return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } finally {
    closeSync(fd);
  }
}

/** True when both tools `runWithEagainStdin` needs are on PATH. */
function hasEagainTooling() {
  const check = spawnSync('sh', ['-c', 'command -v python3 >/dev/null 2>&1 && command -v mkfifo >/dev/null 2>&1']);
  return check.status === 0;
}

/**
 * Run the hook with an fd 0 that genuinely returns EAGAIN on read — the
 * sibling of EISDIR above, but the *expected*, silent half of "no stdin"
 * (ENXIO is its sibling code; see EXPECTED_NO_STDIN_CODES in guard.mjs).
 * That needs an O_NONBLOCK fd on a FIFO that has a writer open but nothing
 * queued.
 *
 * The `stdio: [fd, ...]` trick above cannot deliver it: passing an integer
 * fd through spawnSync's `stdio` array forces the underlying open file
 * description back to blocking mode as a side effect of Node's own
 * child_process handling — confirmed empirically here by reading the
 * *parent's* copy of the very same fd again after one such spawnSync call:
 * it now blocks too, though nothing else touched it. That's Node protecting
 * children from an unexpectedly non-blocking stdin/stdout, and there is no
 * supported way to opt out of it.
 *
 * So the fd has to reach guard.mjs by a route spawnSync's stdio array never
 * touches: a `python3` helper, spawned normally, opens the FIFO itself
 * (os.open with O_NONBLOCK) and execs guard.mjs in its own place — os.dup2 +
 * execvp are plain OS calls that don't go through libuv's stdio handling, so
 * the flag survives into the process that actually calls readFileSync(0).
 * This is also a closer match to production than the trick above: it is a
 * genuinely separate, non-Node process handing guard.mjs its stdin, which is
 * exactly what Claude Code/Codex do.
 */
function runWithEagainStdin(logDir) {
  const fifoPath = path.join(os.tmpdir(), `hk-tier-a-eagain-${process.pid}-${Date.now()}`);
  spawnSync('mkfifo', [fifoPath]);
  // Order matters: opening the write side non-blocking with no reader yet
  // throws ENXIO, so open a reader (ours) first — then the writer that has
  // to stay open with nothing written, so guard.mjs's own read sees EAGAIN
  // rather than EOF.
  const parentReadFd = openSync(fifoPath, constants.O_RDONLY | constants.O_NONBLOCK);
  const writerFd = openSync(fifoPath, constants.O_WRONLY | constants.O_NONBLOCK);
  const pyHelper = [
    'import os, sys',
    `fd = os.open(${JSON.stringify(fifoPath)}, os.O_RDONLY | os.O_NONBLOCK)`,
    'os.dup2(fd, 0)',
    'if fd != 0: os.close(fd)',
    'os.execvp(sys.argv[1], sys.argv[1:])',
  ].join('\n');
  try {
    const result = spawnSync('python3', ['-c', pyHelper, process.execPath, GUARD], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HK_NO_GLOBAL_CONFIG: '1',
        HK_LOG_DIR: logDir,
      },
      timeout: 5000,
    });
    return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } finally {
    closeSync(parentReadFd);
    closeSync(writerFd);
    rmSync(fifoPath, { force: true });
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
    // Unconditional on purpose: the previous commit is what made context
    // injection actually run in production, and a test that only checks the
    // shape *when* stdout is non-empty cannot tell "wired and working" from
    // "wired and mute" — buildContext() returning '' would still pass it.
    // Default guardrail config always yields non-empty context (at least the
    // "don't pre-empt a block" line — see context.mjs), so this is safe to
    // assert unconditionally rather than pinning context.mjs's exact prose.
    const r = run(claude('', {}, 'UserPromptSubmit'));
    assert.equal(r.code, ALLOW);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.equal(typeof parsed.hookSpecificOutput.additionalContext, 'string');
    assert.notEqual(parsed.hookSpecificOutput.additionalContext, '', 'context injection must not be silently mute');
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
  // defect #4: guard.mjs distinguishes three stdin-read outcomes, all of
  // which fail open, but only two of them are supposed to leave a trace:
  //   1. read throws EAGAIN/ENXIO (no stdin queued)      -> allow, silent
  //   2. read throws anything else (EIO, EBADF, EISDIR…) -> allow, logs
  //   3. non-empty stdin that fails JSON.parse             -> allow, logs
  // A bare `catch {}` collapsing all three back into one silent case would
  // still pass a test that only checks the exit code, so each case below
  // pins both halves: the exit code AND whether a crash entry landed.
  //
  // Case 1 needs a fd that genuinely *throws* EAGAIN/ENXIO from
  // readFileSync(0) — '' and '   ' (below) are a successful read of the
  // empty string and never reach that catch block at all, so they do not
  // exercise this branch on their own; see runWithEagainStdin() above for
  // the fixture that does.

  test('stdin that reads as empty (never reaches the catch block): allow, no crash-log entry', async (t) => {
    for (const input of ['', '   ']) {
      await t.test(`input ${JSON.stringify(input)}`, () => {
        withIsolatedLogDir((dir) => {
          const r = run(input, { logDir: dir });
          assert.equal(r.code, ALLOW, `expected ALLOW for stdin ${JSON.stringify(input)}`);
          assert.deepEqual(crashLogEntriesFrom(dir), [], `empty stdin ${JSON.stringify(input)} must not log a crash`);
        });
      });
    }
  });

  test('stdin that parses but carries no tool call: allow, and no crash-log entry', async (t) => {
    // 'null' and '[]' are valid JSON but not a payload object; guard.mjs
    // normalises them (and '{}') to an empty call rather than treating a
    // successful parse as a parse failure.
    for (const input of ['null', '[]', '{}']) {
      await t.test(`input ${input}`, () => {
        withIsolatedLogDir((dir) => {
          const r = run(input, { logDir: dir });
          assert.equal(r.code, ALLOW, `expected ALLOW for valid JSON ${input}`);
          assert.deepEqual(crashLogEntriesFrom(dir), [], `valid JSON ${input} must not log a crash`);
        });
      });
    }
  });

  test('non-empty stdin that fails JSON.parse: allow, AND a crash-log entry', async (t) => {
    for (const input of ['not json', '{"broken":']) {
      await t.test(`input ${JSON.stringify(input)}`, () => {
        withIsolatedLogDir((dir) => {
          const r = run(input, { logDir: dir });
          assert.equal(r.code, ALLOW, `expected ALLOW for malformed JSON ${JSON.stringify(input)}`);
          const entries = crashLogEntriesFrom(dir);
          assert.equal(entries.length, 1, `malformed JSON ${JSON.stringify(input)} must log exactly one crash entry`);
          assert.match(entries[0].where, /malformed stdin JSON/);
        });
      });
    }
  });

  test('an fd that throws EISDIR (case 2, not EAGAIN/ENXIO): allow, AND a crash-log entry', () => {
    withIsolatedLogDir((dir) => {
      const r = runWithUnreadableStdin(dir);
      assert.equal(r.code, ALLOW);
      const entries = crashLogEntriesFrom(dir);
      assert.equal(entries.length, 1, 'an unreadable fd must log exactly one crash entry');
      assert.match(entries[0].where, /stdin unreadable/);
      assert.match(entries[0].error, /EISDIR/, 'this fixture specifically produces EISDIR');
    });
  });

  test('an fd that returns EAGAIN (case 1): allow, and no crash-log entry', (t) => {
    if (!hasEagainTooling()) {
      t.skip('python3/mkfifo not on PATH — cannot construct a genuinely non-blocking fd 0 to exercise this branch');
      return;
    }
    withIsolatedLogDir((dir) => {
      const r = runWithEagainStdin(dir);
      assert.equal(r.code, ALLOW);
      assert.deepEqual(crashLogEntriesFrom(dir), [], 'EAGAIN is the documented no-stdin case and must stay silent');
    });
  });

  test('a Codex-shaped secret read still blocks', () => {
    assert.equal(run(codex('read', { path: '.env.production' })).code, BLOCK, 'Codex-shaped secret read must block');
  });
});
