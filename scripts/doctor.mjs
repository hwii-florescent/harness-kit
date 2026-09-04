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

import { loadConfig } from '../src/core/config.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

// ── Read-only guarantee for the probes below ────────────────────────────────
//
// The live probes (below) run the real guard.mjs, which fails open on any
// internal error by calling logCrash() — an mkdirSync + appendFileSync under
// HK_LOG_DIR. A malformed `~/.harness-kit.json` is enough to trigger that: it
// doesn't have to be invalid JSON (config.mjs swallows that silently); a
// wrong-typed field is enough — e.g. `{"guardrails":{"secret":{"allow":"x"}}}`
// (a string where an array is expected) throws inside secret.mjs's
// `allow.some(...)`, uncaught until checkTool's try/catch, which logs and
// fails open. Left alone, that write would land in this checkout's own
// `.local/crash.jsonl` — and because the probes run before the crash-log
// section below reads that file, doctor would then report its own probing
// as if it were a crash from a real session. Point HK_LOG_DIR at a throwaway
// location for every probe subprocess so nothing lands there. The directory
// is never created by doctor itself — only guard.mjs's mkdirSync creates it,
// and only if a probe actually crashes — and is removed again at exit.
const PROBE_LOG_DIR = path.join(os.tmpdir(), `harness-kit-doctor-${process.pid}`);
const PROBE_ENV = { ...process.env, HK_LOG_DIR: PROBE_LOG_DIR };

function probeCrashCount() {
  try {
    const f = path.join(PROBE_LOG_DIR, 'crash.jsonl');
    if (!fs.existsSync(f)) return 0;
    return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

// ── Tier A: parse + live probe ────────────────────────────────────────────
//
// Tier A used to be graded by grepping the harness's hook file for the kit
// path — `fileMentionsKit()`, since removed. That check is circular for the
// same reason trap 1 in AGENTS.md is: it finds *an* entry mentioning the kit
// and stops looking, so a config wiring `PreToolUse` but not `UserPromptSubmit`
// reads identically to one wiring both. Live proof: on this author's machine
// harness-kit was registered under PreToolUse only — context injection had
// never run — and the old check printed a green "wired" anyway.
//
// Replaced with two checks that can each catch what the other misses:
//   1. Parse the hook file as JSON and look for an entry pointing at THIS kit,
//      per required event, independently — no event is inferred from another.
//   2. Run the EXACT command string found in that entry (via `sh -c`, payload
//      on stdin) rather than a hardcoded `spawnSync('node', [GUARD])`. Running
//      our own known-good invocation would only prove this checkout is
//      healthy, which the config parse already assumes — it would still print
//      green for `/nonexistent/bin/node ".../guard.mjs"` or a typo'd filename
//      in the config, because it never looks at what the config actually
//      says to run. Running the configured string catches both, and catches
//      a guard.mjs that throws on load, because in each case the command
//      genuinely fails to produce the exit code the probe checks for.
//
// What this still cannot catch: a command wired to an event whose real
// dispatch depends on more than the string doctor runs — Claude Code's
// `matcher` field being the concrete case here (see the matcher check below,
// which is a separate, narrower test for exactly that gap). It also cannot
// catch anything that behaves differently run standalone via `sh -c` than it
// would when actually spawned by the harness (working directory, ambient
// env, PATH) — the probe controls only the payload on stdin.
//
// "wired" requires both: the config registers the event with a command that
// resolves to THIS kit, and running that exact command demonstrates the
// behaviour the registration is supposed to buy.

const REQUIRED_EVENTS = ['PreToolUse', 'UserPromptSubmit'];
const GUARD = path.join(KIT, 'src', 'tier-a', 'guard.mjs');

/**
 * Find entries in one event's array that invoke THIS kit's guard.mjs.
 *
 * Matched by the exact guard path (`<KIT>/src/tier-a/guard.mjs`, built with
 * `path.join`), never a bare `command.includes(KIT)` — that reads a config
 * pointing at `${KIT}-stale/src/tier-a/guard.mjs` as this checkout, because
 * KIT is a string prefix of the stale directory's name. The full path with
 * its trailing segments can't collide that way. Shared predicate with
 * dev-link.sh's idempotence check.
 *
 * Only `entry.hooks[].command` is read — confirmed against the hook schema
 * embedded in the installed Claude Code binary, `command`, `timeout` and
 * `statusMessage` are siblings nested inside `hooks[]`. A flat top-level
 * `entry.command` is not a shape either harness fires, so reading it would
 * grade a hook that can never run as wired.
 */
function findWiredEntries(hooksForEvent) {
  if (!Array.isArray(hooksForEvent)) return [];
  const found = [];
  for (const entry of hooksForEvent) {
    if (!Array.isArray(entry?.hooks)) continue;
    for (const h of entry.hooks) {
      if (typeof h?.command === 'string' && h.command.includes(GUARD)) {
        found.push({ command: h.command, matcher: entry.matcher });
      }
    }
  }
  return found;
}

/**
 * Parse one or more Tier A hook-config files (Claude Code checks two:
 * `settings.json` and `settings.local.json`; Codex checks one) and collect,
 * per required event, every entry across them that wires this kit. A missing
 * file just means nothing is configured there yet; a file that exists but
 * fails `JSON.parse` is reported explicitly rather than silently read as
 * "nothing configured" — a hand-edit gone bad should not look like a clean
 * slate.
 */
function checkTierAConfig(files) {
  const events = Object.fromEntries(REQUIRED_EVENTS.map((e) => [e, []]));
  const parseErrors = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let json;
    try {
      json = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      parseErrors.push(`${file}: not valid JSON (${error.message})`);
      continue;
    }
    const hooks = json?.hooks ?? {};
    for (const event of REQUIRED_EVENTS) {
      events[event].push(...findWiredEntries(hooks[event]));
    }
  }
  return { events, parseErrors };
}

/** Run one configured command exactly as the harness would: a shell string, payload on stdin. */
function runConfiguredCommand(command, payload) {
  return spawnSync('sh', ['-c', command], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10000,
    env: PROBE_ENV,
  });
}

/** Live probe: for every configured PreToolUse entry, a `Read` of a secrets file must exit 2. */
function probeSecretBlock(entries) {
  if (!entries.length) return false;
  return entries.every((e) => {
    const r = runConfiguredCommand(e.command, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '.env' },
      cwd: '/tmp',
    });
    return !r.error && r.status === 2;
  });
}

/** Live probe: for every configured UserPromptSubmit entry, it must exit 0 and emit `additionalContext`. */
function probeContextInjection(entries) {
  if (!entries.length) return false;
  return entries.every((e) => {
    const r = runConfiguredCommand(e.command, { hook_event_name: 'UserPromptSubmit', cwd: KIT });
    if (r.error || r.status !== 0) return false;
    try {
      const parsed = JSON.parse(r.stdout || '{}');
      return Boolean(parsed?.hookSpecificOutput?.additionalContext);
    } catch {
      return false;
    }
  });
}

/**
 * A Claude Code `matcher` is a `|`-separated list of tool names (dev-link.sh
 * writes e.g. `"Bash|Read|Write|..."`); an absent matcher fires for every
 * tool. The probe above runs the configured command directly and so never
 * goes through matcher-based dispatch at all — a matcher that excludes
 * `Read` would still show a passing probe while a real `Read` of a secrets
 * file never reaches the hook. This is the exact half-absence Stage 1 exists
 * to surface, so it is checked independently rather than trusted to the probe.
 */
function matcherCoversRead(matcher) {
  if (!matcher) return true;
  return matcher
    .split('|')
    .map((s) => s.trim())
    .includes('Read');
}

function probeLine(label, ok, explainedByDisable) {
  if (ok) return dim(`${label}: ok`);
  if (explainedByDisable) return dim(`${label}: off (guardrail disabled by config)`);
  return red(`${label}: FAILED`);
}

/**
 * Classify one Tier A harness from its config + live-probe results.
 *
 * A probe legitimately returning false because the documented escape hatch
 * (`~/.harness-kit.json` → `guardrails.<name>.enabled: false`) turned the
 * guardrail it exercises off is "wiring complete, guardrail intentionally
 * quiet" — not the same failure as an unresolvable `node` or a typo'd path.
 * Conflating the two used to print `half-wired` (red) for the single most
 * routine use of the kill switch. Reported as its own `disabled` state.
 */
function classify({ configWired, noneConfigured, matcherOk, secretProbeOk, contextProbeOk, secretEnabled, anyGuardrailEnabled }) {
  if (noneConfigured) return 'not-wired';
  if (!configWired) return 'half-wired';
  if (!matcherOk) return 'half-wired';
  if (secretProbeOk && contextProbeOk) return 'wired';
  const secretExplained = secretProbeOk || !secretEnabled;
  const contextExplained = contextProbeOk || !anyGuardrailEnabled;
  if (secretExplained && contextExplained) return 'disabled';
  return 'half-wired';
}

const STATE_DISPLAY = {
  wired: { mark: green('●'), label: green('wired') },
  disabled: { mark: green('●'), label: yellow('wired (guardrail disabled by config)') },
  'half-wired': { mark: red('✗'), label: red('half-wired') },
  'not-wired': { mark: yellow('○'), label: yellow('not wired') },
};

const HARNESSES = [
  {
    name: 'Claude Code',
    tier: 'A',
    bin: 'claude',
    hookFiles: ['settings.json', 'settings.local.json'].map((f) => path.join(HOME, '.claude', f)),
    wiring: '~/.claude/settings.json → hooks.PreToolUse + hooks.UserPromptSubmit',
  },
  {
    name: 'Codex',
    tier: 'A',
    bin: 'codex',
    hookFiles: [path.join(HOME, '.codex', 'hooks.json')],
    wiring: '~/.codex/hooks.json → hooks.PreToolUse + hooks.UserPromptSubmit',
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
    wired: () => registeredWith('omp', ['plugin', 'list'], 'harness-kit'),
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

  if (h.tier === 'A') {
    const { events, parseErrors } = checkTierAConfig(h.hookFiles);
    const configWired = REQUIRED_EVENTS.every((e) => events[e].length > 0);
    const noneConfigured = REQUIRED_EVENTS.every((e) => events[e].length === 0);

    // What the config claims should govern each probe is judged against, read
    // from disk directly rather than re-derived — the same loader guard.mjs
    // itself uses, at the same cwd each probe payload carries.
    const secretEnabled = loadConfig({ cwd: '/tmp' })?.guardrails?.secret?.enabled !== false;
    const anyGuardrailEnabled = Object.values(loadConfig({ cwd: KIT })?.guardrails ?? {}).some(
      (g) => g?.enabled !== false,
    );

    const rawSecretProbe = probeSecretBlock(events.PreToolUse);
    const rawContextProbe = probeContextInjection(events.UserPromptSubmit);
    const matcherOk = events.PreToolUse.length === 0 || events.PreToolUse.some((e) => matcherCoversRead(e.matcher));

    const state = classify({
      configWired,
      noneConfigured,
      matcherOk,
      secretProbeOk: rawSecretProbe,
      contextProbeOk: rawContextProbe,
      secretEnabled,
      anyGuardrailEnabled,
    });

    if (state === 'wired' || state === 'disabled') wired++;

    const { mark, label } = STATE_DISPLAY[state];
    const matchers = [...new Set(events.PreToolUse.map((e) => e.matcher ?? '(none — matches all tools)'))];
    const matcherNote = matchers.length ? dim(`  matcher: ${matchers.join(', ')}`) : '';
    console.log(`  ${mark} ${h.name.padEnd(12)} ${dim(`tier ${h.tier}`)}  ${v.padEnd(16)} ${label}${matcherNote}`);

    if (state !== 'wired') {
      for (const event of REQUIRED_EVENTS) {
        const has = events[event].length > 0;
        const line = `${event}: ${has ? 'configured' : 'MISSING'}`;
        console.log(`    ${has ? dim(line) : red(line)}`);
      }
      if (!matcherOk) {
        console.log(
          `    ${red(`matcher excludes Read — a Read of a secrets file would never reach this hook (matcher: ${matchers.join(', ')})`)}`,
        );
      }
      if (!events.UserPromptSubmit.length) {
        console.log(`    ${red('context injection is OFF — no UserPromptSubmit hook, buildContext() never runs')}`);
      }
      if (!noneConfigured) {
        console.log(
          `    live probe — ${probeLine('secret-file block', rawSecretProbe, !secretEnabled)}, ${probeLine('context injection', rawContextProbe, !anyGuardrailEnabled)}`,
        );
      }
      for (const err of parseErrors) console.log(`    ${red(err)}`);
      if (noneConfigured) console.log(`    ${dim(h.wiring)}`);
    }
  } else {
    const isWired = h.wired();
    if (isWired) wired++;

    const mark = isWired ? green('●') : yellow('○');
    const state = isWired ? green('wired') : yellow('not wired');
    console.log(`  ${mark} ${h.name.padEnd(12)} ${dim(`tier ${h.tier}`)}  ${v.padEnd(16)} ${state}`);
    if (!isWired) console.log(`    ${dim(h.wiring)}`);
  }
}

console.log(`\n  ${installed} harness(es) installed, ${wired} wired.`);
if (wired === 0) {
  console.log(dim('  Phase 0 is intentionally unwired — run scripts/dev-link.sh when ready.'));
}

const crashesDuringProbing = probeCrashCount();
if (crashesDuringProbing > 0) {
  console.log(
    `\n  ${yellow(`${crashesDuringProbing} internal error(s) during probing`)} ${dim('(redirected away from the real crash log — check for a malformed .harness-kit.json)')}`,
  );
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

// Best-effort cleanup of the throwaway probe log dir — never created by
// doctor itself, only by a probe subprocess that actually crashed.
try {
  fs.rmSync(PROBE_LOG_DIR, { recursive: true, force: true });
} catch { /* nothing to clean up, or no permission — not doctor's problem */ }
