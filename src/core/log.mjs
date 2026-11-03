/**
 * Local crash breadcrumbs and privacy-safe decision counts.
 *
 * A guardrail that hard-fails is worse than one that is briefly absent: users
 * disable the whole kit after one bad day. So every entry point fails open and
 * leaves a breadcrumb here instead of surfacing an error.
 *
 * Phase 0 writes inside the repo (`<kit>/.local/crash.jsonl`) so nothing lands
 * outside the project. HK_LOG_DIR overrides; Phase 1 will point it at
 * `~/.harness-kit/`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const HARNESSES = new Set(['claude', 'codex', 'pi', 'omp', 'tier-a', 'pi-file-tools']);
const RULES = new Set(['secret', 'heavyPath', 'broadGlob', 'fileTools', 'none']);
const DECISION_FILE = /^decisions-\d{4}-\d{2}-\d{2}\.jsonl$/;
const MAX_DECISION_BYTES = 1024 * 1024;

export function logDir() {
  return process.env.HK_LOG_DIR || path.join(KIT_ROOT, '.local');
}

/**
 * Record adapter decisions, not replay/core probes. Never serialize the verdict:
 * it contains the target/reason. Only these closed enums may reach disk.
 * ponytail: append-only daily buckets avoid cross-process counter races; retain
 * 14 UTC days, capped at 1 MiB/day (counts can under-report at the cap or on IO
 * failure). Concurrent final appends can exceed the cap by a few records.
 * Upgrade to SQLite only if that ceiling matters in dogfood.
 */
export function logDecision(harness, verdict) {
  if (process.env.HK_NO_DECISION_LOG === '1' || !HARNESSES.has(harness)) return;
  try {
    const blocked = verdict?.blocked === true;
    const guardrail = blocked ? verdict.guardrail : 'none';
    if (!RULES.has(guardrail) || (blocked && guardrail === 'none')) return;
    const row = JSON.stringify({ harness, outcome: blocked ? 'block' : 'allow', guardrail }) + '\n';
    const dir = logDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const today = new Date().toISOString().slice(0, 10);
    const cutoff = new Date(Date.now() - 13 * 86400000).toISOString().slice(0, 10);
    for (const name of fs.readdirSync(dir)) {
      if (DECISION_FILE.test(name) && name.slice(10, 20) < cutoff) {
        fs.unlinkSync(path.join(dir, name));
      }
    }
    const file = path.join(dir, `decisions-${today}.jsonl`);
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    if (size + Buffer.byteLength(row) <= MAX_DECISION_BYTES) {
      fs.appendFileSync(file, row, { mode: 0o600 });
    }
  } catch { /* Metrics must never change a tool verdict. */ }
}

/** Aggregate retained local observations. No paths, commands or timestamps. */
export function decisionCounts() {
  const counts = new Map();
  const cutoff = new Date(Date.now() - 13 * 86400000).toISOString().slice(0, 10);
  try {
    for (const name of fs.readdirSync(logDir()).filter((name) => DECISION_FILE.test(name) && name.slice(10, 20) >= cutoff)) {
      const file = path.join(logDir(), name);
      if (fs.statSync(file).size > MAX_DECISION_BYTES + 4096) continue;
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        try {
          const { harness, outcome, guardrail } = JSON.parse(line);
          if (!HARNESSES.has(harness) || !RULES.has(guardrail)
            || !['allow', 'block'].includes(outcome)) continue;
          if ((outcome === 'allow') !== (guardrail === 'none')) continue;
          const key = `${harness}/${guardrail}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        } catch { /* A partial final append is not a decision. */ }
      }
    }
  } catch { /* Missing or unreadable telemetry is not a runtime failure. */ }
  return counts;
}

/** Append one crash JSON line. Never throws — this is the last line of defence. */
export function logCrash(where, error, extra = {}) {
  try {
    const dir = logDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'crash.jsonl'),
      JSON.stringify({
        ts: new Date().toISOString(),
        where,
        error: error?.message ?? String(error),
        stack: error?.stack?.split('\n').slice(0, 4).join('\n'),
        ...extra,
      }) + '\n',
    );
  } catch {
    // Logging failed too. Stay silent rather than break the session.
  }
}
