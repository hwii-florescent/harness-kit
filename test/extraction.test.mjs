/**
 * Regression tests derived from replaying 3,600+ real tool calls.
 *
 * Every case here is a command that actually ran in a real session. The first
 * suite is the false-positive class that replay exposed: an early version of
 * `extractPaths` treated every operand as a path, so a word's *role* was
 * invisible and 1 in 25 legitimate calls was blocked.
 *
 * Keep these honest by re-running `node scripts/replay.mjs` after any change to
 * bash.mjs — a unit test can only encode collisions we already know about.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { checkTool } from '../src/core/index.mjs';
import { everyHarness } from './payloads.mjs';
import {
  extractPaths, tokenize, stripHeredocs, splitCompound, isBoundedRead,
} from '../src/core/bash.mjs';

const bash = (command) => checkTool(
  { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } },
  { overrides: {} },
);
const allowed = (c) => assert.equal(bash(c).blocked, false, `should allow: ${c}`);
const blocked = (c) => assert.equal(bash(c).blocked, true, `should block: ${c}`);

describe('argument roles: a word is not a path just because it appears', () => {
  test('a grep pattern is not a directory', () => {
    assert.deepEqual(extractPaths('grep -rn "build" src'), ['src']);
    allowed('grep -rn "build" src');
  });

  test('a grep exclusion is not a directory being read', () => {
    allowed('git ls-tree -r --name-only HEAD | grep -vE "node_modules|dist/"');
  });

  test('grep -c is a count flag, not git\'s comment flag', () => {
    assert.deepEqual(
      extractPaths('grep -c "node_modules/x" package-lock.json'),
      ['package-lock.json'],
    );
  });

  test('find -name and -type values are predicates, not paths', () => {
    assert.deepEqual(extractPaths('find . -name .git -type d'), ['.']);
    allowed('find . -name .git -type d');
    allowed('find . -iname "config*.rs" -not -path "*/vendor/*"');
  });

  test('echo arguments are text, never files', () => {
    assert.deepEqual(extractPaths('echo "=== checking build output ==="'), []);
    allowed('echo "=== checking build output ==="');
  });

  test('a commit message may name a secret without touching one', () => {
    allowed('git commit -m "fix .env loading"');
    allowed('git commit -m "ignore dist and node_modules"');
  });
});

describe('quoting and heredocs', () => {
  test('a quoted region is one value, not several operands', () => {
    assert.deepEqual(tokenize('echo "a b c" d'), ['echo', 'a b c', 'd']);
  });

  test('heredoc bodies carry programs, not operands', () => {
    assert.equal(stripHeredocs("python3 - <<'PY'\nx = 'build'\nPY\n").includes('build'), false);
    allowed("python3 - <<'PY'\ns = open('docs/x.md').read()\nPY");
  });

  test('newlines separate statements the way `;` does', () => {
    assert.deepEqual(splitCompound('cd /tmp\nls foo'), ['cd /tmp', 'ls foo']);
  });
});

describe('heavy paths: volume is the concern, not access', () => {
  test('unbounded reads of a generated tree are blocked', () => {
    blocked('ls node_modules');
    blocked('cat dist/bundle.js');
    blocked('find packages/web/dist -type f');
    blocked('grep -rln "Props" node_modules/dockview-core/dist/esm/');
  });

  test('bounded reads of one named file are ordinary work', () => {
    allowed('ls node_modules/ws/package.json');
    allowed('ls -l target/release/app-core');
    allowed('sed -n "3360,3520p" node_modules/x/dist/styles/x.css');
    allowed('grep -n "interface WebSocketRoute" -A 60 node_modules/pw-core/types/types.d.ts');
    allowed('ls node_modules >/dev/null 2>&1');
  });

  test('build and test commands are never touched', () => {
    allowed('npm run build');
    allowed('rm -rf dist && npm run build');
    allowed('cargo test -p app-core 2>&1 | grep -E "^test result"');
    allowed('./node_modules/.bin/eslint src');
  });

  test('isBoundedRead distinguishes listing a root from listing inside it', () => {
    assert.equal(isBoundedRead('ls node_modules', 'node_modules', { listingRoot: true }), false);
    assert.equal(isBoundedRead('ls node_modules/a/b.json', 'node_modules/a/b.json', {}), true);
  });
});

describe('heavy paths: bounded output and metadata across harnesses', () => {
  const allowCommands = [
    'ls -ld node_modules', 'ls -d node_modules dist', 'ls -lad node_modules',
    'ls --directory node_modules', 'ls -dR node_modules',
    'ls node_modules | head -20', 'ls node_modules | head',
    'ls node_modules 2>&1 | head -n 20', 'ls node_modules | head -n20',
    'ls node_modules | head --lines=20', 'ls node_modules | head --lines 20',
    'ls node_modules | head -c 100', 'ls node_modules | head --bytes=100',
    'ls node_modules | tail -3', 'cat .git/info/exclude | tail -n 3',
    'ls node_modules | wc -l', 'ls node_modules | wc',
    'cat dist/bundle.js | head -20', 'find dist -type f | head -20',
    'grep -rn "Props" node_modules/pkg | head -30',
    'ls node_modules | head -20; git status --short',
    'cat ../../node_modules/@xterm/addon-fit/package.json',
    'cat node_modules/pkg/package.json | grep version',
    'open build/App.app', 'code dist/bundle.js',
    'diff -ru src copy -x __pycache__', 'diff -r --exclude node_modules src copy',
    'diff -r --exclude=dist src copy',
  ];
  const blockCommands = [
    'ls node_modules', 'ls -l node_modules', 'ls -R node_modules/pkg',
    'ls -ld node_modules/*', 'ls -I -d node_modules', 'ls --ignore -d node_modules',
    'ls -- -d node_modules', 'ls node_modules | cat', 'ls node_modules | grep .',
    'ls node_modules || head -20', 'ls node_modules; head -20',
    'ls node_modules | head -20; cat dist/bundle.js',
    'ls node_modules | head -20 | cat dist/bundle.js',
    'ls node_modules | head -n -20', 'ls node_modules | head --bytes=-10',
    'ls node_modules | tail -n +3', 'ls node_modules | tail -f',
    'ls node_modules | head -n "$LIMIT"', 'ls node_modules | head -n 1000000',
    'ls node_modules | head -c 1000000',
    'ls node_modules >&2 | head -20', 'ls node_modules 1>&2 | head -20',
    'ls node_modules > /dev/stderr | head -20',
    'ls node_modules # ignored | head -20', 'ls node_modules | echo "head -20"',
    'ls node_modules | head -20 dist/other.js',
    'cat dist/bundle.js "| head -20"',
    'cat node_modules/*/package.json', 'cat node_modules/pkg/lib.js',
    'cat dist/bundle.js', 'find dist -type f',
    'open build/App.app; cat dist/bundle.js',
    'diff -r src node_modules',
  ];
  for (const [commands, expected] of [[allowCommands, false], [blockCommands, true]]) {
    for (const command of commands) {
      test(`${expected ? 'blocks' : 'allows'} ${command}`, () => {
        const results = everyHarness({ claudeTool: 'Bash', codexTool: 'shell', piTool: 'bash', input: { command } })
          .map(([, payload, opts]) => checkTool(payload, { ...opts, overrides: {} }));
        assert.equal(results[0].blocked, expected, command);
        if (expected) assert.equal(results[0].guardrail, 'heavyPath');
        for (const result of results) assert.deepEqual(result, results[0]);
      });
    }
  }
  test('pipeline limits never exempt secret reads or shell writes', () => {
    assert.equal(bash('cat .env | head -20').guardrail, 'secret');
    assert.equal(bash('open .env').guardrail, 'secret');
    assert.equal(bash('ls node_modules | head -20; echo x > /harness-kit-workspace/a.ts').guardrail, 'fileTools');
  });
  test('compound splitting preserves quoted separators and real operator identity', () => {
    assert.deepEqual(splitCompound('grep "a|b;c" src && ls node_modules | head -20'),
      ['grep "a|b;c" src', 'ls node_modules', 'head -20']);
    assert.deepEqual(splitCompound('ls node_modules || head -20', { keepOperators: true }),
      ['ls node_modules', '||', 'head -20']);
  });
});

describe('secrets: reachable by any route', () => {
  test('globs that name a secret are blocked', () => {
    blocked('cat .env*');
    blocked('cat .en?');
    blocked('cat credential*');
  });

  test('generic extension globs are not', () => {
    allowed('ls *.json');
    allowed('ls *.yaml');
    allowed('ls packages/web/*.json');
  });

  test('reached through a second command', () => {
    blocked('echo .env | xargs cat');
    blocked('find . -name ".env" -exec cat {} \;');
  });

  test('reached through interpreter code', () => {
    blocked(`python3 -c "print(open('.env').read())"`);
    blocked(`node -e "console.log(require('fs').readFileSync('.env','utf8'))"`);
  });

  test('variable expansion does not hide the basename', () => {
    blocked('cat $HOME/.env');
  });

  test('a plain interpreter run is still toolchain work', () => {
    allowed('python3 scripts/build.py');
    allowed('node scripts/gen.mjs');
  });
});

describe('structured tools: a grep pattern is not a path', () => {
  /**
   * The same root cause as the shell cases above, surviving in a second code
   * path. Agents that shell out to `grep` went through bash.mjs and were fixed;
   * agents with a *native* grep tool pass { pattern, path } instead, and both
   * guardrails were reading `pattern` as a path. Searching for the word "build"
   * was blocked as a read of a `build` directory.
   *
   * Replay could not find this: the transcript corpus contained no Grep tool
   * calls at all. It took running a real agent that has one.
   */
  const call = (toolName, input) => checkTool({ toolName, input }, { cwd: '/tmp' });

  test('searching FOR a blocklisted word is not reading it', () => {
    assert.equal(call('grep', { pattern: 'build', path: 'src' }).blocked, false);
    assert.equal(call('grep', { pattern: 'dist', path: 'src' }).blocked, false);
    assert.equal(call('search', { pattern: 'node_modules', path: 'src' }).blocked, false);
  });

  test('searching FOR a secret filename is not reading it', () => {
    assert.equal(call('grep', { pattern: '.env', path: 'src' }).blocked, false);
    assert.equal(call('grep', { pattern: 'credentials.json', path: 'src' }).blocked, false);
  });

  test('but searching INSIDE a generated tree still floods', () => {
    assert.equal(call('grep', { pattern: 'x', path: 'node_modules' }).blocked, true);
    assert.equal(call('grep', { pattern: 'x', path: 'dist/esm' }).blocked, true);
  });

  test('a glob pattern does name files, so it stays in scope', () => {
    assert.equal(call('glob', { pattern: '.env*', path: 'src' }).blocked, true);
    assert.equal(call('glob', { pattern: '**/*.ts', path: '.' }).blocked, true);
  });
});
