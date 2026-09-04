/**
 * Tier A unlink safety — remove only harness-kit handlers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const UNLINK = path.join(REPO, 'scripts/dev-unlink.sh');
const GUARD = `node "${path.join(REPO, 'src/tier-a/guard.mjs')}" --harness claude`;

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-kit-unlink-'));
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeSettings(root, value) {
  const file = path.join(root, '.claude/settings.json');
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function runUnlink(root, args = ['--apply', '--only', 'claude']) {
  return spawnSync('bash', [UNLINK, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, HOME: root },
  });
}

function readSettings(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('removes owned nested handlers but keeps unrelated siblings and groups', (t) => {
  const root = sandbox(t);
  const file = writeSettings(root, {
    unrelatedTopLevel: { keep: true },
    hooks: {
      PreToolUse: [
        {
          matcher: 'mixed nested',
          groupMeta: 'keep',
          hooks: [
            { type: 'command', command: GUARD },
            { type: 'command', command: 'node user-nested' },
          ],
        },
        {
          matcher: 'owned only',
          hooks: [{ type: 'command', command: GUARD }],
        },
        {
          matcher: 'unrelated',
          hooks: [{ type: 'command', command: 'node unrelated' }],
        },
      ],
    },
  });

  const result = runUnlink(root);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readSettings(file), {
    unrelatedTopLevel: { keep: true },
    hooks: {
      PreToolUse: [
        {
          matcher: 'mixed nested',
          groupMeta: 'keep',
          hooks: [{ type: 'command', command: 'node user-nested' }],
        },
        {
          matcher: 'owned only',
        },
        {
          matcher: 'unrelated',
          hooks: [{ type: 'command', command: 'node unrelated' }],
        },
      ],
    },
  });
  const after = fs.readFileSync(file);
  const backups = fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.harness-kit-bak.'));
  assert.equal(backups.length, 1);
  const again = runUnlink(root);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(fs.readFileSync(file), after);
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.harness-kit-bak.')),
    backups,
  );
});

test('removes an owned direct command without deleting nested siblings', (t) => {
  const root = sandbox(t);
  const file = writeSettings(root, {
    hooks: {
      PreToolUse: [{
        matcher: 'direct mixed',
        timeout: 7,
        command: GUARD,
        hooks: [{ type: 'command', command: 'node user-nested' }],
      }],
    },
  });

  const result = runUnlink(root);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readSettings(file), {
    hooks: {
      PreToolUse: [{
        matcher: 'direct mixed',
        timeout: 7,
        hooks: [{ type: 'command', command: 'node user-nested' }],
      }],
    },
  });
});

test('dry run does not modify or back up settings', (t) => {
  const root = sandbox(t);
  const file = writeSettings(root, {
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: GUARD }] }] },
  });
  const before = fs.readFileSync(file);

  const result = runUnlink(root, ['--only', 'claude']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.harness-kit-bak.')),
    [],
  );
});

test('preserves malformed hook children and groups', (t) => {
  const root = sandbox(t);
  const file = writeSettings(root, {
    hooks: {
      PreToolUse: [
        {
          matcher: 'malformed child',
          hooks: [
            'keep scalar child',
            { type: 'command', command: GUARD },
            { type: 'command', command: 'node user-nested' },
          ],
        },
        {
          matcher: 'malformed group',
          groupMeta: 'keep',
          command: GUARD,
          hooks: 'keep malformed hooks',
        },
      ],
    },
  });

  const result = runUnlink(root);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readSettings(file), {
    hooks: {
      PreToolUse: [
        {
          matcher: 'malformed child',
          hooks: [
            'keep scalar child',
            { type: 'command', command: 'node user-nested' },
          ],
        },
        {
          matcher: 'malformed group',
          groupMeta: 'keep',
          command: GUARD,
          hooks: 'keep malformed hooks',
        },
      ],
    },
  });
});

test('ignores checkout mentions outside owned handlers', (t) => {
  const root = sandbox(t);
  const file = writeSettings(root, {
    note: `documentation mentions ${REPO}`,
    hooks: {
      PreToolUse: [{
        matcher: 'unrelated',
        hooks: [{ type: 'command', command: 'node user-nested' }],
      }],
    },
  });
  const before = fs.readFileSync(file);

  const result = runUnlink(root);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.harness-kit-bak.')),
    [],
  );
});
