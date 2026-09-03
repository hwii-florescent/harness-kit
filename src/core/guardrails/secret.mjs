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
  return hit ? hit.source : null;
}

export function check(call, config) {
  const { enabled = true, allow = [] } = config?.guardrails?.secret ?? {};
  if (!enabled) return null;

  // Direct path arguments.
  for (const p of call.paths) {
    const rule = ruleFor(p, allow);
    if (rule) return verdict(p, rule);
  }

  // Search patterns can name a secret file just as effectively as a path can.
  if (call.pattern) {
    const rule = ruleFor(call.pattern, allow);
    if (rule) return verdict(call.pattern, rule);
  }

  // Shell commands: only inspect sub-commands that are not build tooling.
  if (call.kind === KIND.SHELL && call.command) {
    for (const sub of suspectSubCommands(call.command)) {
      for (const p of extractPaths(sub)) {
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
