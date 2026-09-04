/**
 * Configuration loader — live layered reads.
 *
 * These tests deliberately exercise filesystem changes between calls. The
 * regular core suite passes in-memory overrides and therefore cannot catch a
 * stale module-level configuration cache.
 */

process.env.HK_NO_GLOBAL_CONFIG = '1';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { checkTool, loadConfig } from '../src/core/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function secretRead(cwd) {
  return checkTool({
    hook_event_name: 'PreToolUse',
    cwd,
    tool_name: 'Read',
    tool_input: { file_path: '.env' },
  });
}
function heavyDirectoryRead(cwd) {
  return checkTool({
    hook_event_name: 'PreToolUse',
    cwd,
    tool_name: 'Bash',
    tool_input: { command: 'ls node_modules' },
  });
}

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value));
}

describe('live layered configuration', () => {
  test('project config changes apply on the next call', (t) => {
    const cwd = tempDir(t, 'harness-kit-config');
    const configFile = path.join(cwd, '.harness-kit.json');

    assert.equal(secretRead(cwd).blocked, true, 'defaults must block a secret read');

    writeJson(configFile, { guardrails: { secret: { enabled: false } } });
    assert.equal(secretRead(cwd).blocked, false, 'creating config must allow the next call');

    writeJson(configFile, { guardrails: { secret: { enabled: true } } });
    assert.equal(secretRead(cwd).blocked, true, 'rewriting config must apply immediately');

    fs.writeFileSync(configFile, '{ malformed');
    assert.equal(secretRead(cwd).blocked, true, 'malformed config must fall back to defaults');

    fs.unlinkSync(configFile);
    assert.equal(secretRead(cwd).blocked, true, 'deleting config must restore defaults');
  });

  test('wrongly shaped config cannot weaken default guardrails', (t) => {
    const cwd = tempDir(t, 'harness-kit-config-shapes');
    const configFile = path.join(cwd, '.harness-kit.json');

    for (const value of [null, false, 0, [], 'text']) {
      writeJson(configFile, value);
      assert.equal(secretRead(cwd).blocked, true, `root ${JSON.stringify(value)} must not disable secret`);
      assert.equal(
        heavyDirectoryRead(cwd).blocked,
        true,
        `root ${JSON.stringify(value)} must not disable heavyPath`,
      );
    }

    const malformedOptions = [
      { guardrails: null },
      { guardrails: { secret: null } },
      { guardrails: { secret: { enabled: 0, allow: '*' } } },
      { guardrails: { heavyPath: null } },
      { guardrails: { heavyPath: { patterns: 'node_modules', allow: '*' } } },
    ];
    for (const value of malformedOptions) {
      writeJson(configFile, value);
      assert.equal(secretRead(cwd).blocked, true, `malformed secret config must remain protected: ${JSON.stringify(value)}`);
      assert.equal(
        heavyDirectoryRead(cwd).blocked,
        true,
        `malformed heavyPath config must remain protected: ${JSON.stringify(value)}`,
      );
    }
  });

  test('local config still overrides project config after both change', (t) => {
    const cwd = tempDir(t, 'harness-kit-local-config');
    const projectFile = path.join(cwd, '.harness-kit.json');
    const localFile = path.join(cwd, '.harness-kit.local.json');

    writeJson(projectFile, { guardrails: { secret: { enabled: false } } });
    writeJson(localFile, { guardrails: { secret: { enabled: true } } });
    assert.equal(secretRead(cwd).blocked, true, 'local enable must override project disable');

    writeJson(projectFile, { guardrails: { secret: { enabled: true } } });
    writeJson(localFile, { guardrails: { secret: { enabled: false } } });
    assert.equal(secretRead(cwd).blocked, false, 'local disable must override project enable');

    writeJson(projectFile, { guardrails: { secret: { enabled: false } } });
    writeJson(localFile, { guardrails: { secret: { enabled: true } } });
    assert.equal(secretRead(cwd).blocked, true, 'both changed layers must be re-read');
  });

  test('global escape hatch reloads in a long-lived process', (t) => {
    const cwd = tempDir(t, 'harness-kit-global-cwd');
    const home = tempDir(t, 'harness-kit-global-home');
    const configModule = pathToFileURL(path.resolve(HERE, '../src/core/config.mjs')).href;
    const script = `
      import fs from 'node:fs';
      import os from 'node:os';
      import path from 'node:path';
      const { loadConfig } = await import(${JSON.stringify(configModule)});
      const file = path.join(os.homedir(), '.harness-kit.json');
      const enabled = () => loadConfig({ cwd: ${JSON.stringify(cwd)}, includeGlobal: true })
        .guardrails.secret.enabled;
      const values = [enabled()];
      fs.writeFileSync(file, JSON.stringify({ guardrails: { secret: { enabled: false } } }));
      values.push(enabled());
      fs.writeFileSync(file, JSON.stringify({ guardrails: { secret: { enabled: true } } }));
      values.push(enabled());
      fs.unlinkSync(file);
      values.push(enabled());
      console.log(JSON.stringify(values));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        HK_NO_GLOBAL_CONFIG: '',
        HK_LOG_DIR: path.join(home, 'logs'),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [true, false, true, true]);
    assert.equal(fs.existsSync(path.join(home, '.harness-kit.json')), false);
  });
});
