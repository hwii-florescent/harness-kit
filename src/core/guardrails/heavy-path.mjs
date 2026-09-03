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
import { suspectSubCommands, extractPaths, isContentReadCommand, isBoundedRead, looksLikeFile } from '../bash.mjs';

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

/** Characters that make a path a pattern rather than a name. */
const GLOB_CHARS = /[*?[\]{}]/;

/**
 * The matching rule *deepest* in the path, and the segment index it matched.
 *
 * Deepest rather than first-in-config, because the two disagree and the answer
 * decides whether the heavy directory is the target or merely an ancestor.
 * `node_modules/pkg/dist` is a `dist` listing that happens to live under
 * `node_modules`; taking `patterns.find` order made the reported rule — and the
 * root check built on it — depend on how the config array happened to be
 * written, so `ls repo/pkg/dist` blocked while the deeper, more expensive
 * `ls repo/node_modules/pkg/dist` was allowed.
 */
function ruleFor(filePath, patterns, allow) {
  if (typeof filePath !== 'string' || !filePath) return null;

  const segs = segments(filePath);
  let rule = null;
  let depth = -1;
  for (let i = segs.length - 1; i >= 0; i--) {
    const hit = patterns.find((p) => matchSegment(segs[i], p));
    if (hit) {
      rule = hit;
      depth = i;
      break;
    }
  }
  if (!rule) return null;

  // `allow` is the escape hatch: an entry wins over the blocklist, matching
  // gitignore's `!` semantics without the full spec.
  const normalized = filePath.replace(/\\/g, '/');
  const allowed = allow.some((a) => {
    const bare = a.replace(/^!/, '');
    return normalized.includes(bare) || segs.some((s) => matchSegment(s, bare));
  });
  if (allowed) return null;

  return { rule, depth, isRoot: depth === segs.length - 1 };
}

/**
 * Does this path name one concrete file *inside* the heavy directory?
 *
 * That is targeted access, not exploration: to ask for it you must already know
 * it is there. The cost driver is breadth — listing a tree, walking it
 * recursively, globbing it — not a single named file. The shell branch has
 * always drawn this line via `isBoundedRead`; this is the same line for tools
 * that arrive as structured arguments instead of a command string.
 */
function isTargetedFile(filePath, match) {
  if (GLOB_CHARS.test(filePath)) return false;
  if (match.isRoot) return false;
  return looksLikeFile(filePath);
}

export function check(call, config) {
  const cfg = config?.guardrails?.heavyPath ?? {};
  const { enabled = true, patterns = [], allow = [] } = cfg;
  if (!enabled || patterns.length === 0) return null;

  // Structured tools get the same two rules the shell branch applies below.
  //
  // First: only reading costs context. `cp x dist/` and `rm -rf dist` have
  // always been allowed as commands, but a Write or Edit carrying the same path
  // as a structured argument was blocked — the guardrail contradicting its own
  // stated principle depending on how the call happened to arrive.
  //
  // Second: a concrete file inside a heavy directory is targeted access. It was
  // blocked here while `sed -n 1,50p <the same file>` passed, so the block never
  // prevented the read — it only pushed the agent into the shell to get it. A
  // guardrail that teaches the way around itself is worse than one that is
  // merely noisy.
  if (call.kind !== KIND.WRITE && call.kind !== KIND.EDIT) {
    for (const p of call.paths) {
      const match = ruleFor(p, patterns, allow);
      if (!match || isTargetedFile(p, match)) continue;
      return verdict(p, match.rule);
    }
  }

  // A search root is a directory to walk, which is exploration whatever the
  // tool. Only a concrete file narrows it to one bounded read.
  if (call.searchPath) {
    const match = ruleFor(call.searchPath, patterns, allow);
    if (match && !isTargetedFile(call.searchPath, match)) {
      return verdict(call.searchPath, match.rule);
    }
  }

  // A GREP pattern is a search expression, not a path. Searching *for* the text
  // "build" or ".env" reads neither — the paths are `searchPath` and `paths`.
  // A GLOB pattern does name files, so it stays in scope.
  if (call.pattern && call.kind !== KIND.GREP) {
    const match = ruleFor(call.pattern, patterns, allow);
    if (match) return verdict(call.pattern, match.rule);
  }

  if (call.kind === KIND.SHELL && call.command) {
    for (const sub of suspectSubCommands(call.command)) {
      // Only reading floods the context. `rm -rf dist`, `mkdir dist`,
      // `cp x dist/` are routine and must stay out of the way.
      if (!isContentReadCommand(sub)) continue;
      for (const p of extractPaths(sub)) {
        const match = ruleFor(p, patterns, allow);
        if (!match) continue;
        // Access is not the concern; volume is. A grep into one named file or
        // an `ls` of a single path costs a few lines and is ordinary work.
        // Is the blocked directory itself the thing being listed, or is it
        // merely an ancestor of a specific path inside it?
        if (isBoundedRead(sub, p, { listingRoot: match.isRoot })) continue;
        return verdict(p, match.rule);
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
      `harness-kit: blocked exploring "${target}" — it is inside "${rule}", ` +
      `a generated or vendored directory.\n` +
      `Walking it would flood the context window with files you did not write.\n\n` +
      `Reading one named file inside it is allowed, so narrow to the exact path ` +
      `you need. For your own build output, prefer the source that produces it — ` +
      `though for an installed dependency the shipped files are the only source ` +
      `there is. Build and test commands (npm run build, cargo test, …) are ` +
      `not affected by this rule.\n` +
      `To allow permanently, add a pattern to guardrails.heavyPath.allow in .harness-kit.json.`,
  };
}
