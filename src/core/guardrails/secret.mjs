/**
 * Guardrail: secret files.
 *
 * Blocks access to credential-bearing files. The threat is an agent reading a
 * `.env` into context, where it then flows to a model provider and into logs.
 *
 * Tuned for a zero false-positive rate, which the Phase 0 exit criteria require:
 * patterns match on the *basename* and are deliberately narrow. `credentials.ts`
 * is a source file and must not trip this; `credentials.json` is data and must.
 */

import path from 'node:path';
import { KIND } from '../normalize.mjs';
import { suspectSubCommands, extractPaths } from '../bash.mjs';

const SECRET = [
  /^\.env$/i,                                            // .env
  /^\.env\.[\w.-]+$/i,                                   // .env.local, .env.production
  /^\.?credentials?(\.(json|ya?ml|toml|ini|txt|enc))?$/i, // credentials, .credentials.json
  /^secrets?\.(json|ya?ml|toml|enc)$/i,                  // secrets.yaml
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,               // ssh keys
  /\.(pem|key|p12|pfx|jks|keystore)$/i,                  // key material
  /^\.(npmrc|pypirc|netrc)$/i,                           // registry tokens
  /^\.git-credentials$/i,
];

/** Documentation stand-ins carry no secrets and are read constantly. */
const SAFE_SUFFIX = /\.(example|sample|template|dist|tpl)$/i;

/** `.env.example` ends in `.example`; `example.env` does not — check both ends. */
const SAFE_PREFIX = /^(example|sample|template)[.-]/i;

/**
 * Canonical secret filenames, used to judge whether a glob would reach one.
 *
 * `cat .env*` pulls the credentials into context exactly as `cat .env` does,
 * and an agent writes it without meaning anything by it.
 */
const EXEMPLARS = [
  '.env', '.env.local', '.env.production', 'credentials.json', 'credentials.yaml',
  'secrets.yaml', 'secrets.json', 'id_rsa', 'id_ed25519', 'server.pem',
  'private.key', 'store.p12', '.npmrc', '.netrc', '.pypirc', '.git-credentials',
];

function globReachesSecret(basename) {
  const wildcard = basename.search(/[*?]/);
  if (wildcard === -1) return false;

  // The literal part BEFORE the first wildcard is what shows intent. `.env*`
  // names a secret; `*.json` names a file type and matches `credentials.json`
  // only by accident — blocking `ls *.json` would be absurd.
  if (wildcard < 3) return false;

  const re = new RegExp(`^${basename
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')}$`, 'i');
  return EXEMPLARS.some((name) => re.test(name));
}

function isSafe(basename) {
  return SAFE_SUFFIX.test(basename) || SAFE_PREFIX.test(basename);
}

function matchesUserAllow(filePath, allow) {
  return allow.some((pattern) => {
    // Support a leading/trailing `*` without pulling in a glob dependency.
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(filePath);
  });
}

/** @returns {string|null} the matched rule, or null when the path is fine. */
function ruleFor(filePath, allow) {
  if (typeof filePath !== 'string' || !filePath) return null;

  let normalized = filePath.replace(/\\/g, '/');
  try {
    normalized = decodeURIComponent(normalized); // catches %2e obfuscation
  } catch { /* invalid encoding — use as-is */ }

  if (matchesUserAllow(normalized, allow)) return null;

  const basename = path.posix.basename(normalized);
  if (isSafe(basename)) return null;

  const hit = SECRET.find((re) => re.test(basename));
  if (hit) return hit.source;

  return globReachesSecret(basename) ? `glob "${basename}"` : null;
}

export function check(call, config) {
  const { enabled = true, allow = [] } = config?.guardrails?.secret ?? {};
  if (!enabled) return null;

  // Direct path arguments.
  for (const p of call.paths) {
    const rule = ruleFor(p, allow);
    if (rule) return verdict(p, rule);
  }

  // A glob can name a secret file just as effectively as a path can — and for
  // a GREP call, normalize.mjs now carries the *regex* separately as
  // call.searchRegex and puts the file filter (Claude Code/Pi/omp's `glob`)
  // here as call.pattern (defect #5), so `Grep{pattern:"KEY", glob:".env*"}`
  // reaches a real credential exactly like `Glob{pattern:".env*"}` does. This
  // check no longer excludes KIND.GREP: that exclusion was written when
  // `call.pattern` on a GREP still held the search term, and became a stale
  // credential hole once normalize.mjs was fixed to route the file filter
  // here instead. The regex itself never lands in `call.pattern`, so
  // searching *for* the string ".env" still isn't treated as opening it.
  if (call.pattern) {
    const rule = ruleFor(call.pattern, allow);
    if (rule) return verdict(call.pattern, rule);
  }

  // Shell commands: only inspect sub-commands that are not build tooling.
  if (call.kind === KIND.SHELL && call.command) {
    for (const sub of suspectSubCommands(call.command)) {
      for (const p of extractPaths(sub, { permissive: true })) {
        const rule = ruleFor(p, allow);
        if (rule) return verdict(p, rule);
      }
    }
  }

  return null;
}

function verdict(target, rule) {
  return {
    blocked: true,
    guardrail: 'secret',
    rule,
    target,
    reason:
      `harness-kit: blocked access to "${target}" — it looks like a secrets file.\n` +
      `Reading it would pull credentials into the model's context.\n\n` +
      `If you need it: ask the user to share the specific value, or read the ` +
      `matching .example file instead.\n` +
      `To allow permanently, add a pattern to guardrails.secret.allow in .harness-kit.json.`,
  };
}
