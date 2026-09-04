#!/usr/bin/env node
/**
 * Phase 0 doctor — read-only.
 *
 * Reports which harnesses are installed, whether each is wired to this checkout,
 * and replays the crash log. Writes nothing, anywhere. Becomes `hk doctor` in
 * Phase 1.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARD_PREFIX = `node "${path.join(KIT, 'src/tier-a/guard.mjs')}"`;
const PACKAGE_NAME = 'harness-kit';
const OMP_EXTENSION = './src/tier-b/omp.mjs';
const REAL_KIT = fs.realpathSync(KIT);

const TIER_A_GUARDS = {
  claude: `${GUARD_PREFIX} --harness claude`,
  codex: `${GUARD_PREFIX} --harness codex`,
};
const HOME = os.homedir();

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

function version(bin, args = ['--version']) {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 5000 });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || r.stderr || '').trim().split('\n')[0] || 'installed';
}

function tierAWired(file, expected) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const groups = parsed?.hooks?.PreToolUse;
    if (!Array.isArray(groups)) return false;

    const nested = groups.flatMap((group) => (
      Array.isArray(group?.hooks)
        ? group.hooks.filter((handler) => typeof handler?.command === 'string'
          && handler.command.startsWith(GUARD_PREFIX))
        : []
    ));
    const direct = groups.filter((group) => (
      typeof group?.command === 'string' && group.command.startsWith(GUARD_PREFIX)
    ));

    return direct.length === 0
      && nested.length === 1
      && nested[0].type === 'command'
      && nested[0].command === expected;
  } catch {
    return false;
  }
}

/**
 * Ask the agent's own package manager, rather than looking for a file.
 *
 * An earlier version checked for a symlink it had itself created in
 * `~/.pi/agent/extensions/`. That directory is scanned, but only for `.ts` and
 * `.js` names, so the linked `.mjs` never loaded — and doctor reported "wired"
 * regardless, because its check was circular. The guardrail was silently absent
 * while every indicator said it was on. Ask the thing that actually decides.
 */
function registeredWith(bin, args, needle) {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 10000 });
  if (r.error || r.status !== 0) return false;
  return `${r.stdout || ''}${r.stderr || ''}`.includes(needle);
}

function ompRegistered() {
  const r = spawnSync('omp', ['plugin', 'list', '--json'], {
    encoding: 'utf8',
    timeout: 10000,
  });
  if (r.error || r.status !== 0) return false;

  try {
    const listing = JSON.parse(r.stdout || '');
    const plugins = [
      ...(Array.isArray(listing?.npm) ? listing.npm : []),
      ...(Array.isArray(listing?.marketplace) ? listing.marketplace : []),
    ];
    return plugins.some((plugin) => {
      if (!plugin || typeof plugin !== 'object'
        || plugin.name !== PACKAGE_NAME
        || plugin.enabled === false
        || typeof plugin.path !== 'string'
        || !Array.isArray(plugin.manifest?.extensions)
        || !plugin.manifest.extensions.includes(OMP_EXTENSION)) {
        return false;
      }
      try {
        return fs.realpathSync(plugin.path) === REAL_KIT;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}



const HARNESSES = [
  {
    name: 'Claude Code',
    tier: 'A',
    bin: 'claude',
    wired: () => tierAWired(
      path.join(HOME, '.claude', 'settings.json'),
      TIER_A_GUARDS.claude,
    ),
    wiring: '~/.claude/settings.json → hooks.PreToolUse',
  },
  {
    name: 'Codex',
    tier: 'A',
    bin: 'codex',
    wired: () => tierAWired(
      path.join(HOME, '.codex', 'hooks.json'),
      TIER_A_GUARDS.codex,
    ),
    wiring: '~/.codex/hooks.json → hooks.PreToolUse',
  },
  {
    name: 'Pi',
    tier: 'B',
    bin: 'pi',
    wired: () => registeredWith('pi', ['list'], KIT),
    wiring: 'pi install <kit>',
  },
  {
    name: 'omp',
    tier: 'B',
    bin: 'omp',
    wired: () => ompRegistered(),
    wiring: 'omp install <kit>',
  },
];

console.log(`\n${bold('harness-kit doctor')} ${dim('(phase 0)')}`);
console.log(dim(`kit: ${KIT}\n`));

let installed = 0;
let wired = 0;

for (const h of HARNESSES) {
  const v = version(h.bin);
  if (!v) {
    console.log(`  ${dim('○')} ${h.name.padEnd(12)} ${dim('not installed')}`);
    continue;
  }
  installed++;

  const isWired = h.wired();
  if (isWired) wired++;

  const mark = isWired ? green('●') : yellow('○');
  const state = isWired ? green('wired') : yellow('not wired');
  console.log(`  ${mark} ${h.name.padEnd(12)} ${dim(`tier ${h.tier}`)}  ${v.padEnd(16)} ${state}`);
  if (!isWired) console.log(`    ${dim(h.wiring)}`);
}

console.log(`\n  ${installed} harness(es) installed, ${wired} wired.`);
if (wired === 0) {
  console.log(dim('  Phase 0 is intentionally unwired — run scripts/dev-link.sh when ready.'));
}

// ── Crash log ───────────────────────────────────────────────────────────────

const crashLog = path.join(process.env.HK_LOG_DIR || path.join(KIT, '.local'), 'crash.jsonl');
if (fs.existsSync(crashLog)) {
  const lines = fs.readFileSync(crashLog, 'utf8').trim().split('\n').filter(Boolean);
  console.log(`\n  ${red(`${lines.length} crash(es)`)} in ${path.relative(KIT, crashLog)}:`);
  for (const line of lines.slice(-5)) {
    try {
      const { ts, where, error } = JSON.parse(line);
      console.log(`    ${dim(ts)} ${where}: ${error}`);
    } catch { /* skip unparseable line */ }
  }
} else {
  console.log(`  ${green('no crashes logged')}`);
}

console.log();
