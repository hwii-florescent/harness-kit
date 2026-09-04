/**
 * Tier A wiring — migration, preservation, and doctor detection.
 *
 * The harness binaries are fakes so these tests never inspect or mutate the
 * developer's real settings. jq remains the implementation under test.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const LINK = path.join(REPO, 'scripts/dev-link.sh');
const DOCTOR = path.join(REPO, 'scripts/doctor.mjs');
const GUARD = `node "${path.join(REPO, 'src/tier-a/guard.mjs')}"`;
const LEGACY = GUARD;
const ANSI = /\x1b\[[0-9;]*m/g;
const CLAUDE = `${GUARD} --harness claude`;
const CODEX = `${GUARD} --harness codex`;

function makeSandbox(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(root, '.codex'), { recursive: true });
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['claude', 'codex', 'pi', 'omp']) {
    const file = path.join(bin, name);
    fs.writeFileSync(file, '#!/bin/sh\nprintf "fake harness\\n"\n');
    fs.chmodSync(file, 0o755);
  }
  return { root, bin };
}

function envFor(sandbox) {
  return {
    ...process.env,
    HOME: sandbox.root,
    PATH: `${sandbox.bin}${path.delimiter}${process.env.PATH}`,
    HK_LOG_DIR: path.join(sandbox.root, 'logs'),
  };
}

function runLink(sandbox, args) {
  return spawnSync('bash', [LINK, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    env: envFor(sandbox),
  });
}

function runDoctor(sandbox) {
  return spawnSync(process.execPath, [DOCTOR], {
    cwd: REPO,
    encoding: 'utf8',
    env: envFor(sandbox),
  });
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function backupNames(file) {
  return fs.readdirSync(path.dirname(file))
    .filter((name) => name.startsWith(`${path.basename(file)}.harness-kit-bak.`));
}

function canonicalGroup(command) {
  return { matcher: 'all tools', hooks: [{ type: 'command', command }] };
}

function directGroup(command) {
  return { matcher: 'legacy matcher', command, timeout: 7, retained: true };
}

function complexFixture() {
  return {
    unrelatedTopLevel: { retained: true },
    hooks: {
      PreToolUse: [
        {
          matcher: 'owned matcher',
          groupMeta: 'preserve',
          hooks: [
            { type: 'command', command: LEGACY, timeout: 7, retained: true },
            { type: 'command', command: 'node unrelated-one', timeout: 3 },
          ],
        },
        {
          matcher: 'duplicate matcher',
          hooks: [
            { type: 'command', command: CLAUDE, timeout: 12 },
            { type: 'command', command: CODEX, timeout: 13 },
          ],
        },
        { matcher: 'direct duplicate', command: LEGACY, timeout: 15 },
        {
          matcher: 'unrelated matcher',
          hooks: [{ type: 'command', command: 'node unrelated-two' }],
        },
      ],
    },
  };
}

function allCommands(config) {
  const groups = config?.hooks?.PreToolUse ?? [];
  return {
    nested: groups.flatMap((group) => Array.isArray(group?.hooks) ? group.hooks : [])
      .map((handler) => handler?.command)
      .filter(Boolean),
    direct: groups.map((group) => group?.command).filter(Boolean),
  };
}

describe('dev-link Tier A migration', () => {
  for (const [harness, expected] of [['claude', CLAUDE], ['codex', CODEX]]) {
    test(`${harness} normalizes duplicates and preserves unrelated hooks`, (t) => {
      const sandbox = makeSandbox(t, `harness-kit-${harness}-migration`);
      const file = path.join(sandbox.root, harness === 'claude' ? '.claude/settings.json' : '.codex/hooks.json');
      writeJson(file, complexFixture());

      const first = runLink(sandbox, ['--apply', '--only', harness]);
      assert.equal(first.status, 0, first.stderr);
      const migrated = readJson(file);
      const groups = migrated.hooks.PreToolUse;
      assert.deepEqual(migrated.unrelatedTopLevel, { retained: true });
      assert.equal(groups.length, 2, 'duplicate owned groups should be removed');
      assert.deepEqual(groups[0].hooks[0], {
        type: 'command', command: expected, timeout: 7, retained: true,
      });
      assert.deepEqual(groups[0].hooks[1], {
        type: 'command', command: 'node unrelated-one', timeout: 3,
      });
      assert.deepEqual(groups[1], {
        matcher: 'unrelated matcher',
        hooks: [{ type: 'command', command: 'node unrelated-two' }],
      });
      const commands = allCommands(migrated);
      assert.deepEqual(commands.nested.filter((command) => [LEGACY, CLAUDE, CODEX].includes(command)), [expected]);
      assert.deepEqual(commands.direct, []);
      assert.equal(backupNames(file).length, 1, 'an actual migration gets one backup');

      const second = runLink(sandbox, ['--apply', '--only', harness]);
      assert.equal(second.status, 0, second.stderr);
      assert.match(second.stdout, new RegExp(`${harness === 'claude' ? 'Claude Code' : 'Codex'} .*already wired`));
      assert.equal(backupNames(file).length, 1, 'an idempotent rerun does not add a backup');
    });
  }

  for (const [harness, expected] of [['claude', CLAUDE], ['codex', CODEX]]) {
    test(`${harness} converts a legacy direct command in place`, (t) => {
      const sandbox = makeSandbox(t, `harness-kit-${harness}-direct`);
      const file = path.join(sandbox.root, harness === 'claude' ? '.claude/settings.json' : '.codex/hooks.json');
      writeJson(file, {
        hooks: {
          PreToolUse: [
            directGroup(LEGACY),
            { matcher: 'unrelated', hooks: [{ type: 'command', command: 'node keep' }] },
          ],
        },
      });

      const result = runLink(sandbox, ['--apply', '--only', harness]);
      assert.equal(result.status, 0, result.stderr);
      const migrated = readJson(file);
      assert.equal(migrated.hooks.PreToolUse.length, 2);
      const group = migrated.hooks.PreToolUse[0];
      assert.equal(group.command, undefined);
      assert.equal(group.matcher, 'legacy matcher');
      assert.equal(group.retained, true);
      assert.deepEqual(group.hooks[0], {
        type: 'command',
        command: expected,
        ...(harness === 'codex' ? { timeout: 10 } : {}),
      });
      assert.deepEqual(migrated.hooks.PreToolUse[1], {
        matcher: 'unrelated',
        hooks: [{ type: 'command', command: 'node keep' }],
      });
    });
  }
  for (const [harness, expected] of [['claude', CLAUDE], ['codex', CODEX]]) {
    test(`${harness} creates a canonical hook when absent`, (t) => {
      const sandbox = makeSandbox(t, `harness-kit-${harness}-fresh`);
      const file = path.join(sandbox.root, harness === 'claude' ? '.claude/settings.json' : '.codex/hooks.json');

      const result = runLink(sandbox, ['--apply', '--only', harness]);
      assert.equal(result.status, 0, result.stderr);
      const config = readJson(file);
      assert.equal(config.hooks.PreToolUse.length, 1);
      assert.deepEqual(config.hooks.PreToolUse[0].hooks[0], {
        type: 'command',
        command: expected,
        ...(harness === 'codex' ? { timeout: 10 } : {}),
      });
      assert.equal(backupNames(file).length, 0, 'a new settings file has no backup');
    });
  }


  test('dry run leaves noncanonical settings and backups untouched', (t) => {
    const sandbox = makeSandbox(t, 'harness-kit-dry-run');
    const file = path.join(sandbox.root, '.claude/settings.json');
    writeJson(file, { hooks: { PreToolUse: [directGroup(LEGACY)] } });
    const before = fs.readFileSync(file);

    const result = runLink(sandbox, ['--only', 'claude']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /would:/);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.deepEqual(backupNames(file), []);
  });

  test('invalid JSON is reported and left immutable', (t) => {
    const sandbox = makeSandbox(t, 'harness-kit-invalid-json');
    const file = path.join(sandbox.root, '.codex/hooks.json');
    const before = '{ not json';
    fs.writeFileSync(file, before);

    const result = runLink(sandbox, ['--apply', '--only', 'codex']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /not valid JSON, left untouched/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.deepEqual(backupNames(file), []);
  });
});

describe('doctor Tier A wiring detection', () => {
  const fixtures = [
    ['migrated', (harness) => ({ hooks: { PreToolUse: [canonicalGroup(harness === 'claude' ? CLAUDE : CODEX)] } }), true],
    ['legacy direct', () => ({ hooks: { PreToolUse: [directGroup(LEGACY)] } }), false],
    ['wrong harness mode', (harness) => ({ hooks: { PreToolUse: [canonicalGroup(harness === 'claude' ? CODEX : CLAUDE)] } }), false],
    ['duplicate', (harness) => ({
      hooks: {
        PreToolUse: [
          canonicalGroup(harness === 'claude' ? CLAUDE : CODEX),
          canonicalGroup(harness === 'claude' ? CLAUDE : CODEX),
        ],
      },
    }), false],
    ['malformed', () => null, false],
  ];

  for (const [harness, expectedCommand] of [['claude', CLAUDE], ['codex', CODEX]]) {
    for (const [label, build, wired] of fixtures) {
      test(`${harness} reports ${label} as ${wired ? 'wired' : 'not wired'}`, (t) => {
        const sandbox = makeSandbox(t, `harness-kit-doctor-${harness}`);
        const file = path.join(sandbox.root, harness === 'claude' ? '.claude/settings.json' : '.codex/hooks.json');
        const fixture = build(harness);
        if (fixture === null) fs.writeFileSync(file, '{ malformed');
        else writeJson(file, fixture);
        if (label === 'migrated') assert.equal(fixture.hooks.PreToolUse[0].hooks[0].command, expectedCommand);

        const result = runDoctor(sandbox);
        assert.equal(result.status, 0, result.stderr);
        const line = result.stdout.split('\n').find((entry) => entry.includes(harness === 'claude' ? 'Claude Code' : 'Codex'));
        assert.ok(line, result.stdout);
        const plain = line.replace(ANSI, '');
        assert.equal(plain.trim().endsWith(wired ? 'wired' : 'not wired'), true, line);
      });
    }
  }

  test('does not inspect Claude settings.local.json', (t) => {
    const sandbox = makeSandbox(t, 'harness-kit-doctor-local-settings');
    writeJson(path.join(sandbox.root, '.claude/settings.local.json'), canonicalGroup(CLAUDE));
    const result = runDoctor(sandbox);
    assert.equal(result.status, 0, result.stderr);
    const line = result.stdout.split('\n').find((entry) => entry.includes('Claude Code'));
    assert.ok(line);
    assert.match(line.replace(ANSI, ''), /not wired$/);
  });
});
