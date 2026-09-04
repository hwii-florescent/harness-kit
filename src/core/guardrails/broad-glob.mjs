/**
 * Guardrail: overly broad globs.
 *
 * `Glob **\/*.ts` at a repo root returns every TypeScript file in the project.
 * On a large repo that is thousands of results, and the agent has spent its
 * context before doing any work.
 *
 * Breadth alone is not the problem — `src/**\/*.ts` is fine. It is breadth
 * *combined with* a root or near-root search path. So both conditions must hold
 * before this fires, which keeps it quiet during normal scoped searches.
 */

import path from 'node:path';
import { KIND } from '../normalize.mjs';

/** Patterns that recurse across an entire tree when anchored at the root. */
const BROAD = [
  /^\*\*$/,                    // **
  /^\*$/,                      // *
  /^\*\*\/\*$/,                // **/*
  /^\*\*\/\.\*$/,              // **/.*
  /^\*\.[\w]+$/,               // *.ts
  /^\*\.\{[^}]+\}$/,           // *.{ts,tsx}
  /^\*\*\/\*\.[\w]+$/,         // **/*.ts
  /^\*\*\/\*\.\{[^}]+\}$/,     // **/*.{ts,tsx}
];

/** Directories that make a good narrower suggestion when they are plausible. */
const COMMON_ROOTS = ['src', 'lib', 'app', 'packages', 'server', 'client', 'test'];

/**
 * A search path is "wide" when it is the project root or one level below it.
 * Deeper than that, the developer has already scoped the search themselves.
 */
function isWideSearchPath(searchPath, cwd) {
  if (!searchPath || searchPath === '.' || searchPath === './') return true;

  const normalized = searchPath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized) return true;

  if (path.isAbsolute(normalized)) {
    const rel = path.relative(cwd, normalized);
    if (rel === '' || rel === '.') return true;
    if (rel.startsWith('..')) return false;   // outside the project; not our call
    return rel.split('/').length <= 1;
  }

  return normalized.split('/').filter((s) => s && s !== '.').length <= 1;
}

export function check(call, config) {
  const { enabled = true } = config?.guardrails?.broadGlob ?? {};
  if (!enabled) return null;
  // This guardrail's axis is breadth of *enumeration*: how many names does
  // the call list out, regardless of which directories they live in. A
  // content search is bounded by its matches instead — Claude Code's Grep
  // even has `head_limit` — so `**/*.ts` at the root really does return every
  // file when it's a Glob, but the same pattern as a GREP file filter
  // (`call.pattern` on a GREP call — normalize.mjs, defect #5) doesn't
  // enumerate names into context the way Glob does, and stays out of scope
  // here. heavy-path.mjs polices a different axis on that same GREP call —
  // which tree the search reaches into, not how many results come back — see
  // the comment there; the two guardrails are orthogonal, not contradictory.
  if (call.kind !== KIND.GLOB) return null;

  const pattern = typeof call.pattern === 'string' ? call.pattern.trim() : '';
  if (!pattern || !BROAD.some((re) => re.test(pattern))) return null;
  if (!isWideSearchPath(call.searchPath, call.cwd)) return null;

  return {
    blocked: true,
    guardrail: 'broadGlob',
    rule: pattern,
    target: pattern,
    reason:
      `harness-kit: blocked glob "${pattern}" at the project root — it matches ` +
      `every file in the tree and would fill the context window.\n\n` +
      `Narrow it to a directory:\n` +
      suggestions(pattern).map((s) => `  ${s}`).join('\n') + '\n' +
      `Or search by content with grep instead of listing by name.`,
  };
}

/** Rewrite the same pattern under each plausible source root. */
function suggestions(pattern) {
  const tail = pattern.replace(/^\*\*\//, '').replace(/^\*\*$/, '*');
  return COMMON_ROOTS.slice(0, 3).map((dir) => `${dir}/**/${tail}`);
}
