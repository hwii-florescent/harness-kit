/**
 * Guardrail: heavy paths.
 *
 * Blocks exploration of directories that would flood the context window —
 * `node_modules`, `dist`, `.git`, and friends. This is a context-economy
 * guardrail, not a security one.
 *
 * The hard part is not detection, it is *not* firing on legitimate work.
 * `npm run build` reads node_modules and writes dist; `vitest` walks both. Those
 * must pass. Only direct exploration is blocked, so command handling defers to
 * bash.mjs's allowlist before looking at paths at all.
 */

import { KIND } from '../normalize.mjs';
import { suspectSubCommands, extractPaths, isContentReadCommand, isBoundedRead } from '../bash.mjs';

/** Split a path into segments, ignoring drive letters and leading separators. */
function segments(filePath) {
  return filePath
    .replace(/\\/g, '/')
    .replace(/^[a-zA-Z]:/, '')
    .split('/')
    .filter((s) => s && s !== '.');
}

/** Segment-level match so `dist` hits `packages/web/dist/x.js` but not `distro.ts`. */
function matchSegment(segment, pattern) {
  if (!pattern.includes('*')) return segment === pattern;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(segment);
}

function ruleFor(filePath, patterns, allow) {
  if (typeof filePath !== 'string' || !filePath) return null;

  const segs = segments(filePath);
  const hit = patterns.find((p) => segs.some((s) => matchSegment(s, p)));
  if (!hit) return null;

  // `allow` is the escape hatch: an entry wins over the blocklist, matching
  // gitignore's `!` semantics without the full spec.
  const normalized = filePath.replace(/\\/g, '/');
  const allowed = allow.some((a) => {
    const bare = a.replace(/^!/, '');
    return normalized.includes(bare) || segs.some((s) => matchSegment(s, bare));
  });

  return allowed ? null : hit;
}

export function check(call, config) {
  const cfg = config?.guardrails?.heavyPath ?? {};
  const { enabled = true, patterns = [], allow = [] } = cfg;
  if (!enabled || patterns.length === 0) return null;

  for (const p of call.paths) {
    const rule = ruleFor(p, patterns, allow);
    if (rule) return verdict(p, rule);
  }

  if (call.searchPath) {
    const rule = ruleFor(call.searchPath, patterns, allow);
    if (rule) return verdict(call.searchPath, rule);
  }

  if (call.pattern) {
    const rule = ruleFor(call.pattern, patterns, allow);
    if (rule) return verdict(call.pattern, rule);
  }

  if (call.kind === KIND.SHELL && call.command) {
    for (const sub of suspectSubCommands(call.command)) {
      // Only reading floods the context. `rm -rf dist`, `mkdir dist`,
      // `cp x dist/` are routine and must stay out of the way.
      if (!isContentReadCommand(sub)) continue;
      for (const p of extractPaths(sub)) {
        const rule = ruleFor(p, patterns, allow);
        if (!rule) continue;
        // Access is not the concern; volume is. A grep into one named file or
        // an `ls` of a single path costs a few lines and is ordinary work.
        // Is the blocked directory itself the thing being listed, or is it
        // merely an ancestor of a specific path inside it?
        const segs = segments(p);
        const listingRoot = segs.length > 0 && matchSegment(segs[segs.length - 1], rule);
        if (isBoundedRead(sub, p, { listingRoot })) continue;
        return verdict(p, rule);
      }
    }
  }

  return null;
}

function verdict(target, rule) {
  return {
    blocked: true,
    guardrail: 'heavyPath',
    rule,
    target,
    reason:
      `harness-kit: blocked access to "${target}" — it is inside "${rule}", ` +
      `a generated or vendored directory.\n` +
      `Reading it would flood the context window with files you did not write.\n\n` +
      `Work from the source that produces it instead. Build and test commands ` +
      `(npm run build, cargo test, …) are not affected by this rule.\n` +
      `To allow permanently, add a pattern to guardrails.heavyPath.allow in .harness-kit.json.`,
  };
}
