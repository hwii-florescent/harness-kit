import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { logDecision, decisionCounts } from '../src/core/log.mjs';
import { install } from '../src/tier-b/shared.mjs';
import { checkTool } from '../src/core/index.mjs';

process.env.HK_NO_GLOBAL_CONFIG = '1';

function isolated(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-decisions-'));
  const previous = { dir: process.env.HK_LOG_DIR, disabled: process.env.HK_NO_DECISION_LOG };
  process.env.HK_LOG_DIR = dir;
  delete process.env.HK_NO_DECISION_LOG;
  try { fn(dir); } finally {
    if (previous.dir === undefined) delete process.env.HK_LOG_DIR; else process.env.HK_LOG_DIR = previous.dir;
    if (previous.disabled === undefined) delete process.env.HK_NO_DECISION_LOG; else process.env.HK_NO_DECISION_LOG = previous.disabled;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('decision schema discards sensitive fields, rejects arbitrary labels and counts outcomes', () => isolated((dir) => {
  logDecision('pi', { blocked: false, command: 'SENSITIVE', target: 'SENSITIVE' });
  logDecision('pi', { blocked: true, guardrail: 'secret', target: 'SENSITIVE', reason: 'SENSITIVE' });
  logDecision('SENSITIVE', { blocked: false });
  logDecision('pi', { blocked: true, guardrail: 'SENSITIVE' });
  const file = path.join(dir, fs.readdirSync(dir)[0]);
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.includes('SENSITIVE'), false);
  assert.deepEqual(text.trim().split('\n').map(JSON.parse), [
    { harness: 'pi', outcome: 'allow', guardrail: 'none' },
    { harness: 'pi', outcome: 'block', guardrail: 'secret' },
  ]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(Object.fromEntries(decisionCounts()), { 'pi/none': 1, 'pi/secret': 1 });
  fs.appendFileSync(file, 'partial record\n' + JSON.stringify({ harness: 'pi', outcome: 'allow', guardrail: 'secret' }) + '\n');
  assert.equal(decisionCounts().size, 2);
}));

test('retention removes only old metric buckets; daily log is bounded and opt-out works', () => isolated((dir) => {
  fs.writeFileSync(path.join(dir, 'decisions-2000-01-01.jsonl'), JSON.stringify({ harness: 'pi', outcome: 'allow', guardrail: 'none' }) + '\n');
  assert.equal(decisionCounts().size, 0, 'old buckets must not appear even before the next write prunes them');
  fs.writeFileSync(path.join(dir, 'crash.jsonl'), 'keep');
  logDecision('codex', { blocked: false });
  assert.equal(fs.existsSync(path.join(dir, 'decisions-2000-01-01.jsonl')), false);
  assert.equal(fs.readFileSync(path.join(dir, 'crash.jsonl'), 'utf8'), 'keep');
  const file = path.join(dir, fs.readdirSync(dir).find((name) => name.startsWith('decisions-')));
  fs.truncateSync(file, 1024 * 1024);
  logDecision('codex', { blocked: false });
  assert.equal(fs.statSync(file).size, 1024 * 1024);
  fs.rmSync(file);
  process.env.HK_NO_DECISION_LOG = '1';
  logDecision('pi', { blocked: false });
  assert.equal(fs.existsSync(file), false);
}));

test('broken telemetry storage cannot change adapter allow/block results', () => isolated((dir) => {
  const notDirectory = path.join(dir, 'file');
  fs.writeFileSync(notDirectory, 'x');
  process.env.HK_LOG_DIR = notDirectory;
  let handler;
  install({ on(name, fn) { if (name === 'tool_call') handler = fn; } });
  assert.equal(handler({ toolName: 'read', input: { path: 'src/a.js' } }, { cwd: dir }), undefined);
  assert.equal(handler({ toolName: 'read', input: { path: '.env' } }, { cwd: dir }).block, true);
  assert.equal(decisionCounts().size, 0);
}));

test('Tier A logs the explicit harness; Tier B logs its own label without core/replay pollution', () => isolated((dir) => {
  checkTool({ tool_name: 'Read', tool_input: { file_path: '.env' }, cwd: dir });
  assert.equal(fs.readdirSync(dir).length, 0, 'direct core/replay calls do not log decisions');
  const r = spawnSync(process.execPath, ['src/tier-a/guard.mjs', '--harness', 'claude'], {
    input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '.env' }, cwd: dir }),
    env: { ...process.env, HK_NO_GLOBAL_CONFIG: '1' }, encoding: 'utf8',
  });
  assert.equal(r.status, 2);
  let handler;
  install({ on(name, fn) { if (name === 'tool_call') handler = fn; } }, { harness: 'omp' });
  handler({ toolName: 'bash', input: { command: 'npm test' } }, { cwd: dir });
  assert.deepEqual(Object.fromEntries(decisionCounts()), { 'claude/secret': 1, 'omp/none': 1 });
}));
