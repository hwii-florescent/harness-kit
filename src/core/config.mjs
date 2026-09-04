/**
 * Layered configuration.
 *
 *   defaults  <-  global  <-  project  <-  local
 *
 * Global is `~/.harness-kit.json`; project and local live beside the code being
 * worked on. Every harness reads the same file through this loader, so there is
 * no per-harness configuration anywhere in the kit.
 *
 * Phase 0 note: `includeGlobal` defaults to false when HK_NO_GLOBAL_CONFIG is
 * set, which the test suite does — tests must never read the developer's home
 * directory.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULTS = {
  guardrails: {
    secret: {
      enabled: true,
      /** Extra glob-ish path patterns to exempt, e.g. "fixtures/**". */
      allow: [],
    },
    heavyPath: {
      enabled: true,
      patterns: [
        'node_modules', 'dist', 'build', 'out',
        '.next', '.nuxt', '.turbo', '.cache',
        '__pycache__', '.venv', 'venv',
        'vendor', 'target',
        '.git', 'coverage',
      ],
      allow: [],
    },
    broadGlob: {
      enabled: true,
    },
  },
};


/** Deep-merge plain objects; arrays replace rather than concatenate. */
function merge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base?.[k]
      ? merge(base[k], v)
      : v;
  }
  return out;
}

const isObject = (value) => value !== null
  && typeof value === 'object'
  && !Array.isArray(value);

const isStringArray = (value) => Array.isArray(value)
  && value.every((entry) => typeof entry === 'string');

/**
 * Keep only typed guardrail options. Invalid config must not replace defaults
 * or trigger a fail-open exception inside a guardrail.
 */
function sanitizeGuardrail(name, value) {
  if (!isObject(value)) return null;

  const out = {};
  for (const [key, option] of Object.entries(value)) {
    if (key === 'enabled') {
      if (typeof option === 'boolean') out[key] = option;
      continue;
    }
    if ((key === 'allow' || (name === 'heavyPath' && key === 'patterns'))
      && !isStringArray(option)) {
      continue;
    }
    out[key] = option;
  }
  return out;
}

function sanitizeConfig(value) {
  if (!isObject(value)) return null;

  const out = { ...value };
  if (!Object.hasOwn(value, 'guardrails')) return out;
  if (!isObject(value.guardrails)) {
    delete out.guardrails;
    return out;
  }

  const guardrails = { ...value.guardrails };
  for (const name of ['secret', 'heavyPath', 'broadGlob']) {
    if (!Object.hasOwn(guardrails, name)) continue;
    const sanitized = sanitizeGuardrail(name, guardrails[name]);
    if (sanitized === null) delete guardrails[name];
    else guardrails[name] = sanitized;
  }
  out.guardrails = guardrails;
  return out;
}

function readJson(file) {
  try {
    return sanitizeConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    // Missing, malformed, or wrongly shaped config is not fatal — defaults
    // still protect the user.
    return null;
  }
}

/**
 * @param {object} [opts]
 * @param {string} [opts.cwd]            Project root to look in.
 * @param {boolean} [opts.includeGlobal] Read `~/.harness-kit.json` (default: true).
 * @param {object} [opts.overrides]      Applied last; used by tests.
 */
export function loadConfig({ cwd = process.cwd(), includeGlobal, overrides } = {}) {
  const global = includeGlobal ?? !process.env.HK_NO_GLOBAL_CONFIG;

  let config = DEFAULTS;
  if (global) config = merge(config, readJson(path.join(os.homedir(), '.harness-kit.json')));
  config = merge(config, readJson(path.join(cwd, '.harness-kit.json')));
  config = merge(config, readJson(path.join(cwd, '.harness-kit.local.json')));

  const sanitizedOverrides = sanitizeConfig(overrides);
  return sanitizedOverrides ? merge(config, sanitizedOverrides) : config;
}

