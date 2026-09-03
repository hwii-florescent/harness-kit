/**
 * Core guardrail behaviour.
 *
 * Hermetic: HK_NO_GLOBAL_CONFIG stops the loader reading the developer's home
 * directory, and every payload is a plain object — no filesystem access, no
 * writes anywhere.
 */

process.env.HK_NO_GLOBAL_CONFIG = '1';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { checkTool } from '../src/core/index.mjs';
import { normalize, KIND } from '../src/core/normalize.mjs';
import { isAllowedCommand, splitCompound, unwrapShellExecutor, stripPrefix } from '../src/core/bash.mjs';
import { CWD, CASES, everyHarness, claude, pi } from './payloads.mjs';

const check = (payload, opts = {}) => checkTool(payload, { cwd: CWD, ...opts });

// ── Cross-harness parity ────────────────────────────────────────────────────
// The central claim of the whole kit: one core, four harnesses, same verdict.

describe('cross-harness parity', () => {
  const expectations = [
    ['readSecret', true, 'secret'],
    ['readSafeExample', false, null],
    ['listHeavyDir', true, 'heavyPath'],
    ['buildCommand', false, null],
    ['broadGlob', true, 'broadGlob'],
    ['scopedGlob', false, null],
  ];

  for (const [caseName, shouldBlock, guardrail] of expectations) {
    test(`${caseName}: identical verdict on all four harnesses`, () => {
      const verdicts = everyHarness(CASES[caseName]).map(([label, payload, opts]) => {
        const v = check(payload, opts);
        return { label, blocked: v.blocked, guardrail: v.guardrail ?? null };
      });

      for (const v of verdicts) {
        assert.equal(v.blocked, shouldBlock, `${v.label}: expected blocked=${shouldBlock}`);
        assert.equal(v.guardrail, guardrail, `${v.label}: expected guardrail=${guardrail}`);
      }

      // Not just individually correct — actually identical to one another.
      const distinct = new Set(verdicts.map((v) => `${v.blocked}:${v.guardrail}`));
      assert.equal(distinct.size, 1, `harnesses disagreed: ${JSON.stringify(verdicts)}`);
    });
  }
});

// ── Secret guardrail ────────────────────────────────────────────────────────

describe('guardrail: secret', () => {
  const blocked = [
    '.env', '.env.local', '.env.production',
    'config/credentials.json', '.credentials',
    'secrets.yaml', 'secret.yml',
    'keys/server.pem', 'private.key', 'cert.p12',
    'id_rsa', '.ssh/id_ed25519',
    '.npmrc', '.netrc', '.git-credentials',
  ];
  for (const path of blocked) {
    test(`blocks ${path}`, () => {
      const v = check(claude('Read', { file_path: path }));
      assert.equal(v.blocked, true);
      assert.equal(v.guardrail, 'secret');
    });
  }

  const allowed = [
    '.env.example', '.env.sample', '.env.template',
    'example.env', 'credentials.ts', 'credentials.test.js',
    'src/secrets.ts', 'README.md', 'keyboard.tsx', 'monkey.go',
  ];
  for (const path of allowed) {
    test(`allows ${path}`, () => {
      assert.equal(check(claude('Read', { file_path: path })).blocked, false);
    });
  }

  test('blocks a secret named inside a shell command', () => {
    const v = check(claude('Bash', { command: 'cat .env' }));
    assert.equal(v.blocked, true);
    assert.equal(v.guardrail, 'secret');
  });

  test('blocks a secret hidden behind a compound command', () => {
    const v = check(claude('Bash', { command: 'echo hi && cat config/credentials.json' }));
    assert.equal(v.blocked, true);
  });

  test('catches percent-encoded obfuscation', () => {
    assert.equal(check(claude('Read', { file_path: '%2Eenv' })).blocked, true);
  });

  test('respects the user allow list', () => {
    const v = check(claude('Read', { file_path: 'fixtures/.env' }), {
      overrides: { guardrails: { secret: { allow: ['fixtures/*'] } } },
    });
    assert.equal(v.blocked, false);
  });

  test('can be disabled', () => {
    const v = check(claude('Read', { file_path: '.env' }), {
      overrides: { guardrails: { secret: { enabled: false } } },
    });
    assert.equal(v.blocked, false);
  });
});

// ── Heavy-path guardrail ────────────────────────────────────────────────────

describe('guardrail: heavyPath', () => {
  const blocked = [
    'node_modules/react/index.js',
    'packages/web/node_modules/lodash/get.js',
    'dist/bundle.js', 'build/main.css', '.next/server/page.js',
    'target/debug/app', 'vendor/autoload.php',
    '__pycache__/mod.pyc', '.venv/lib/python3.12/site.py',
    '.git/config', 'coverage/lcov.info',
  ];
  for (const path of blocked) {
    test(`blocks ${path}`, () => {
      const v = check(claude('Read', { file_path: path }));
      assert.equal(v.blocked, true);
      assert.equal(v.guardrail, 'heavyPath');
    });
  }

  const allowed = [
    'src/index.ts', 'lib/distro.ts', 'src/building/plan.ts',
    'app/vendors.tsx', 'docs/targeting.md',
  ];
  for (const path of allowed) {
    test(`allows ${path} (segment match, not substring)`, () => {
      assert.equal(check(claude('Read', { file_path: path })).blocked, false);
    });
  }

  // The false-positive class that would get the kit uninstalled.
  const buildCommands = [
    'npm run build', 'pnpm --filter web run build', 'yarn workspace app test',
    'npx tsc --noEmit', 'cargo test', 'go build ./...', 'make',
    'NODE_ENV=production npm run build', 'sudo docker build .',
    'uv venv .venv', 'python -m venv .venv', './.venv/bin/pytest',
    'vitest run', 'npm ci && npm run build',
  ];
  for (const command of buildCommands) {
    test(`allows build command: ${command}`, () => {
      assert.equal(check(claude('Bash', { command })).blocked, false, command);
    });
  }

  test('blocks direct exploration of a heavy dir', () => {
    assert.equal(check(claude('Bash', { command: 'ls node_modules' })).blocked, true);
  });

  test('blocks exploration even when chained after a build', () => {
    const v = check(claude('Bash', { command: 'npm run build && cat dist/bundle.js' }));
    assert.equal(v.blocked, true);
    assert.equal(v.guardrail, 'heavyPath');
  });

  // Context economy, not access control: writing to or deleting a generated
  // directory costs no context and must not be blocked.
  const nonReadingCommands = [
    'rm -rf dist', 'rm -rf node_modules', 'mkdir -p dist',
    'cp assets/logo.svg dist/', 'mv dist/old.js dist/new.js', 'touch dist/.keep',
  ];
  for (const command of nonReadingCommands) {
    test(`allows non-reading command: ${command}`, () => {
      assert.equal(check(claude('Bash', { command })).blocked, false, command);
    });
  }

  test('sees through bash -c wrapping', () => {
    assert.equal(check(claude('Bash', { command: `bash -c "ls node_modules"` })).blocked, true);
  });

  test('respects the user allow list', () => {
    const v = check(claude('Read', { file_path: 'vendor/mylib/index.js' }), {
      overrides: { guardrails: { heavyPath: { allow: ['vendor'] } } },
    });
    assert.equal(v.blocked, false);
  });
});

// ── Broad-glob guardrail ────────────────────────────────────────────────────

describe('guardrail: broadGlob', () => {
  const broadAtRoot = ['**', '*', '**/*', '**/*.ts', '*.ts', '**/*.{ts,tsx}', '**/.*'];
  for (const pattern of broadAtRoot) {
    test(`blocks "${pattern}" at root`, () => {
      const v = check(claude('Glob', { pattern, path: '.' }));
      assert.equal(v.blocked, true);
      assert.equal(v.guardrail, 'broadGlob');
    });
  }

  test('allows a broad pattern under a deep path', () => {
    assert.equal(check(claude('Glob', { pattern: '**/*.ts', path: 'src/components' })).blocked, false);
  });

  test('allows an already-scoped pattern at root', () => {
    assert.equal(check(claude('Glob', { pattern: 'src/**/*.ts', path: '.' })).blocked, false);
  });

  test('treats an absolute cwd as root', () => {
    assert.equal(check(claude('Glob', { pattern: '**/*.ts', path: CWD })).blocked, true);
  });

  test('does not fire on non-discovery tools', () => {
    assert.equal(check(claude('Read', { file_path: 'src/a.ts', pattern: '**/*.ts' })).blocked, false);
  });

  test('suggests narrower alternatives', () => {
    const v = check(claude('Glob', { pattern: '**/*.ts', path: '.' }));
    assert.match(v.reason, /src\/\*\*\/\*\.ts/);
  });
});

// ── Fail-open ───────────────────────────────────────────────────────────────

describe('fail-open', () => {
  const junk = [null, undefined, {}, { tool_name: 'Read' }, { tool_name: 'Read', tool_input: null },
    { tool_input: { file_path: 123 } }, 'a string', 42, []];
  for (const payload of junk) {
    test(`allows malformed payload: ${JSON.stringify(payload)}`, () => {
      assert.equal(checkTool(payload, { cwd: CWD }).blocked, false);
    });
  }

  test('allows unknown tools', () => {
    assert.equal(check(claude('SomeFutureTool', { whatever: true })).blocked, false);
  });
});

// ── False positives ─────────────────────────────────────────────────────────
// The Phase 0 exit criteria require a zero false-positive rate. A guardrail that
// blocks legitimate work gets switched off once and never switched back on, so
// every case below is a regression test for adoption, not just correctness.

describe('false positives', () => {
  const mustAllow = [
    // Secret filenames mentioned in free text, not opened.
    ['git commit -m "fix .env loading"', 'commit message naming a secret file'],
    ['git commit -m "document credentials.json format"', 'commit message, quoted'],
    ['gh pr create --title "Add .env.example"', 'PR title'],
    ['echo "see .env.example for setup"', 'echo of documentation text'],

    // Ordinary development commands.
    ['git status', 'plain git'],
    ['git diff src/index.ts', 'diff of a source file'],
    ['ls src', 'listing a source directory'],
    ['cat package.json', 'reading a manifest'],
    ['grep -r TODO src', 'searching source'],
    ['rm -rf dist && npm run build', 'clean rebuild'],
    ['npm install express', 'installing a dependency'],
    ['docker build -t app .', 'container build'],
    ['pytest tests/test_auth.py', 'running a test file'],
    ['./node_modules/.bin/eslint src', 'binary invoked from node_modules'],
  ];

  for (const [command, why] of mustAllow) {
    test(`allows: ${why}`, () => {
      const v = check(claude('Bash', { command }));
      assert.equal(v.blocked, false, `blocked by ${v.guardrail}: ${command}`);
    });
  }

  const sourceFiles = [
    'src/config/env.ts', 'lib/keyring.rs', 'app/secrets/index.tsx',
    'test/fixtures/credentials.spec.ts', 'docs/environment.md',
    'src/services/token.service.ts', 'internal/pem/parser.go',
  ];
  for (const path of sourceFiles) {
    test(`allows source file: ${path}`, () => {
      assert.equal(check(claude('Read', { file_path: path })).blocked, false);
    });
  }
});

// ── Normalisation ───────────────────────────────────────────────────────────

describe('normalize', () => {
  test('maps each harness tool name to a canonical kind', () => {
    assert.equal(normalize({ tool_name: 'Bash' }).kind, KIND.SHELL);
    assert.equal(normalize({ tool_name: 'exec_command' }).kind, KIND.SHELL);
    assert.equal(normalize({ toolName: 'bash' }).kind, KIND.SHELL);
    assert.equal(normalize({ tool_name: 'apply_patch' }).kind, KIND.EDIT);
    assert.equal(normalize({ tool_name: 'Edit' }).kind, KIND.EDIT);
    assert.equal(normalize({ tool_name: 'Glob' }).kind, KIND.GLOB);
    assert.equal(normalize({ tool_name: 'Nope' }).kind, KIND.OTHER);
  });

  test('reads arguments from every envelope', () => {
    const want = 'x.ts';
    assert.equal(normalize({ tool_input: { file_path: want } }).paths[0], want);
    assert.equal(normalize({ input: { file_path: want } }).paths[0], want);
    assert.equal(normalize({ args: { path: want } }).paths[0], want);
  });

  test('separates a discovery search path from target paths', () => {
    const call = normalize({ tool_name: 'Glob', tool_input: { pattern: '*.ts', path: 'src' } });
    assert.equal(call.searchPath, 'src');
    assert.equal(call.paths.length, 0);
  });

  test('falls back to opts.cwd when the payload omits it (Pi/omp)', () => {
    assert.equal(normalize(pi('read', { path: 'a' }), { cwd: CWD }).cwd, CWD);
  });
});

// ── Bash analysis ───────────────────────────────────────────────────────────

describe('bash analysis', () => {
  test('unwraps shell executors', () => {
    assert.equal(unwrapShellExecutor(`bash -c "ls foo"`), 'ls foo');
    assert.equal(unwrapShellExecutor(`eval 'cat x'`), 'cat x');
    assert.equal(unwrapShellExecutor('ls foo'), 'ls foo');
  });

  test('splits compound commands', () => {
    assert.deepEqual(splitCompound('a && b || c ; d | e'), ['a', 'b', 'c', 'd', 'e']);
  });

  test('strips env vars and wrappers', () => {
    assert.equal(stripPrefix('NODE_ENV=production npm run build'), 'npm run build');
    assert.equal(stripPrefix('sudo env FOO=1 make'), 'make');
  });

  test('recognises toolchain commands', () => {
    assert.equal(isAllowedCommand('npm run build'), true);
    assert.equal(isAllowedCommand('cargo test'), true);
    assert.equal(isAllowedCommand('ls node_modules'), false);
    assert.equal(isAllowedCommand('cat dist/x.js'), false);
  });
});
