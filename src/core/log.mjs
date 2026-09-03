/**
 * Crash logging.
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

export function logDir() {
  return process.env.HK_LOG_DIR || path.join(KIT_ROOT, '.local');
}

/** Append one JSON line. Never throws — this is the last line of defence. */
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
