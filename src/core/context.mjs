/**
 * Context injection — the non-blocking half of "hooks".
 *
 * Runs on UserPromptSubmit (Claude Code, Codex) and before_agent_start (Pi,
 * omp), and returns a short block of text prepended to the turn.
 *
 * Kept deliberately small. Injected context is paid for on *every* turn, so
 * anything here must earn its tokens — state the agent cannot cheaply discover
 * for itself, and nothing more. Project conventions belong in AGENTS.md, not
 * here.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { logCrash } from './log.mjs';

/** Lockfile → package manager. First match wins. */
const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
  ['uv.lock', 'uv'],
  ['poetry.lock', 'poetry'],
  ['Cargo.lock', 'cargo'],
  ['go.sum', 'go'],
];

/** Marker file → project type. */
const MARKERS = [
  ['package.json', 'node'],
  ['pyproject.toml', 'python'],
  ['Cargo.toml', 'rust'],
  ['go.mod', 'go'],
  ['pubspec.yaml', 'dart'],
  ['Gemfile', 'ruby'],
  ['composer.json', 'php'],
];

function detect(cwd, table) {
  for (const [file, label] of table) {
    if (fs.existsSync(path.join(cwd, file))) return label;
  }
  return null;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @returns {string} Markdown block, or '' when there is nothing worth saying.
 */
export function buildContext({ cwd = process.cwd() } = {}) {
  try {
    const config = loadConfig({ cwd });
    const lines = [];

    const type = detect(cwd, MARKERS);
    const pm = detect(cwd, LOCKFILES);
    const env = [type, pm && `${pm} (lockfile)`].filter(Boolean).join(' · ');
    if (env) lines.push(`- Project: ${env}`);

    const active = Object.entries(config.guardrails ?? {})
      .filter(([, v]) => v?.enabled !== false)
      .map(([name]) => name);

    if (active.length) {
      lines.push(
        `- Guardrails active: ${active.join(', ')}. ` +
        `Blocked calls return a reason explaining what to do instead — read it ` +
        `rather than retrying the same call.`,
      );
    }

    if (!lines.length) return '';
    return ['## harness-kit', ...lines].join('\n');
  } catch (error) {
    logCrash('buildContext', error);
    return '';
  }
}
