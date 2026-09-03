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
      // Deliberately does NOT name the active guardrails.
      //
      // An earlier version listed them ("Guardrails active: secret, heavyPath,
      // broadGlob"). Live testing showed agents then *simulated* the rules
      // instead of relying on them: asked to run `grep -rn "build" src`, the
      // model saw the word "build", decided heavy-path would object, and
      // refused — a call the guardrail allows. That failure is worse than a
      // false block, because nothing is logged and no reason is shown; the work
      // simply does not happen. So: say a hook exists, say what a block looks
      // like, and tell the agent not to anticipate it.
      lines.push(
        '- A guardrail hook may block a tool call and return a reason. ' +
        'Do not try to predict it and do not refuse pre-emptively — make the ' +
        'call you would normally make. If it is blocked you will get an ' +
        'explanation and a suggested alternative; act on that rather than ' +
        'retrying the same call.',
      );
    }

    if (!lines.length) return '';
    return ['## harness-kit', ...lines].join('\n');
  } catch (error) {
    logCrash('buildContext', error);
    return '';
  }
}
