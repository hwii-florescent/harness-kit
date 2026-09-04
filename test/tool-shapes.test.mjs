/**
 * Tool payload shapes across harnesses.
 *
 * The kit's claim is that one core serves four agents. That only holds if the
 * normaliser actually understands what each agent sends — and a tool whose
 * shape it does not recognise is not a safe default, it is a silent hole: the
 * call normalises to KIND.OTHER with no paths, every guardrail sees nothing,
 * and the call sails through while `doctor` still reports "wired".
 *
 * Each case below is a real payload captured from a running agent, not a guess.
 * omp is the demanding one: it edits with hashline and has far more tools than
 * pi, so it is where the holes were.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkTool, normalize, KIND } from '../src/core/index.mjs';

const check = (payload) => checkTool(payload, { cwd: '/proj' });
const blocked = (p, why) => assert.equal(check(p).blocked, true, `should block: ${why}`);
const allowed = (p, why) => assert.equal(check(p).blocked, false, `should allow: ${why}`);

/** omp's hashline editor: the whole patch is one string, target named inside. */
const hashline = (file) => ({
  toolName: 'edit',
  input: { input: `*** Begin Patch\n[${file}#F613]\nPUT 3.=3:\n+value\n*** End Patch\n` },
});

describe('patch bodies name their target', () => {
  test('hashline edits are visible to the guardrails', () => {
    // Before this was handled, normalize() returned paths: [] for all of these
    // and every guardrail was blind to what the edit touched.
    assert.deepEqual(normalize(hashline('src/app.ts')).paths, ['src/app.ts']);
    blocked(hashline('.env'), 'hashline edit of a secrets file');
    blocked(hashline('.ssh/id_' + 'rsa'), 'hashline edit of a private key');
    // An edit inside node_modules is no longer a heavyPath block — writing
    // there costs no context — but the target must still be *visible*, which is
    // the property this file exists to pin.
    assert.deepEqual(
      normalize(hashline('node_modules/x/index.js')).paths,
      ['node_modules/x/index.js'],
    );
  });

  test('ordinary hashline edits still pass', () => {
    allowed(hashline('README.md'), 'editing a normal file');
    allowed(hashline('src/app.ts'), 'editing source');
  });

  test('apply_patch and unified diff headers too', () => {
    blocked(
      { toolName: 'apply_patch', input: { input: '*** Update File: .env\n+KEY=1\n' } },
      'apply_patch targeting a secrets file',
    );
    blocked(
      { toolName: 'edit', input: { patch: '--- a/.env\n+++ b/.env\n+KEY=1\n' } },
      'unified diff targeting a secrets file',
    );
  });

  test('/dev/null in a diff header is not a path', () => {
    allowed(
      { toolName: 'edit', input: { patch: '--- /dev/null\n+++ b/src/new.ts\n+x\n' } },
      'a new-file diff',
    );
  });
});

describe('glob: omp carries the pattern in `path`', () => {
  // omp sends { path: "**/*.ts" } with no `pattern` field at all, so broadGlob
  // never fired on it while working correctly everywhere else.
  test('the pattern is split out of the path', () => {
    const n = normalize({ toolName: 'glob', input: { path: 'src/**/*.ts' } });
    assert.equal(n.kind, KIND.GLOB);
    assert.equal(n.pattern, '**/*.ts');
    assert.equal(n.searchPath, 'src');
  });

  test('broad patterns are blocked in omp shape as in every other', () => {
    blocked({ toolName: 'glob', input: { path: '**/*' } }, 'omp broad glob');
    blocked({ toolName: 'glob', input: { path: '**/*.ts', limit: 1000 } }, 'omp broad glob');
    blocked({ toolName: 'glob', input: { pattern: '**/*.ts', path: '.' } }, 'claude broad glob');
  });

  test('a scoped search is still fine', () => {
    allowed({ toolName: 'glob', input: { path: 'src/components/**/*.ts' } }, 'deep scope');
  });
});

describe('the rest of the omp tool surface', () => {
  test('read uses `path`, not `file_path`', () => {
    blocked({ toolName: 'read', input: { path: '.env' } }, 'omp read of a secrets file');
    allowed({ toolName: 'read', input: { path: 'README.md' } }, 'omp read of a normal file');
  });

  test('grep passes { pattern, path, case, gitignore }', () => {
    allowed(
      { toolName: 'grep', input: { pattern: 'greeting', path: 'src', case: true, gitignore: true } },
      'searching for a word',
    );
    blocked(
      { toolName: 'grep', input: { pattern: 'x', path: 'node_modules' } },
      'searching inside node_modules',
    );
  });

  test('list is a discovery tool', () => {
    assert.equal(normalize({ toolName: 'list', input: { path: 'src' } }).kind, KIND.GLOB);
    blocked({ toolName: 'list', input: { path: 'node_modules' } }, 'listing node_modules');
  });

  test('tools with no filesystem surface are simply allowed', () => {
    allowed({ toolName: 'todo', input: { op: 'init', list: [] } }, 'todo');
    allowed({ toolName: 'say', input: { text: 'hello' } }, 'say');
  });

  test('read paths with harness selector suffixes are normalized', () => {
    blocked({ toolName: 'read', input: { path: '.env:raw' } }, 'reading .env with :raw selector');
    blocked({ toolName: 'read', input: { path: '.env:1-50' } }, 'reading .env with line selector');
    blocked({ toolName: 'read', input: { path: 'node_modules:raw' } }, 'reading heavy root with selector');
    allowed({ toolName: 'read', input: { path: 'node_modules/pkg/index.js:raw:1-10' } }, 'targeted file in heavy path with selector');
    allowed({ toolName: 'read', input: { path: 'src/index.ts:50-100' } }, 'reading source file with line selector');
  });
});
