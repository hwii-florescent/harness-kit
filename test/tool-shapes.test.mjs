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
    // Defect #6: heavyPath is context economy ("unbounded reads only",
    // ARCHITECTURE.md §7), not access control — writing/editing a file under
    // node_modules costs no context, it's `rm -rf`/`mkdir` under a different
    // tool name. `secret` still independently blocks an edit of `.env` above.
    allowed(hashline('node_modules/x/index.js'), 'hashline edit inside node_modules is a write, not a read');
    // Guard against this passing for the wrong reason: either heavyPath
    // correctly skips a WRITE/EDIT, or the patch parser silently returned []
    // and there was nothing for any guardrail to see. Only the first is real.
    assert.deepEqual(normalize(hashline('node_modules/x/index.js')).paths, ['node_modules/x/index.js']);
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
});

describe('Stage 4 review fixes', () => {
  test('a grep pattern is a regex, not a path or a glob (#5 reproduction)', () => {
    // No `glob` field at all — `pattern` is purely a search term here, even
    // one that happens to look like a file-name pattern.
    allowed({ toolName: 'Grep', input: { pattern: '*.ts', path: '.' } }, 'search term, not a glob');
    allowed({ toolName: 'Grep', input: { pattern: '**/*' } }, 'search term, not a glob');
  });

  test('Grep and Glob are told apart even with the same pattern text', () => {
    // Same broad pattern, same wide search path — Grep is a content search
    // bounded by its matches, Glob enumerates every name in the tree.
    allowed(
      { toolName: 'Grep', input: { pattern: 'foo', glob: '**/*.ts', path: '.' } },
      'content search with a broad file filter',
    );
    blocked(
      { toolName: 'Glob', input: { pattern: '**/*.ts', path: '.' } },
      'name enumeration at the project root',
    );
  });

  test('F1: a GREP file filter that names a secret is a hole, not a search term', () => {
    // secret.mjs used to exempt every GREP call from the pattern check, back
    // when `pattern` still held the regex. Now that normalize.mjs routes the
    // GREP file filter into call.pattern (defect #5), that exemption left
    // `Grep{pattern:"API_KEY", glob:".env*"}` allowed straight through.
    blocked(
      { toolName: 'Grep', input: { pattern: 'API_KEY', glob: '.env*', output_mode: 'content' } },
      'a grep whose file filter reaches .env files',
    );
    blocked({ toolName: 'Grep', input: { pattern: 'x', glob: '**/*.pem' } }, 'file filter reaches key material');
    // And no new false positive: an ordinary file-type filter is still fine.
    allowed({ toolName: 'Grep', input: { pattern: 'x', glob: '*.json' } }, 'ordinary file-type filter');
    allowed({ toolName: 'Grep', input: { pattern: 'x', glob: '**/*.ts' } }, 'ordinary file-type filter');
    // #5 stays fixed: searching *for* the string ".env" is not opening one.
    allowed({ toolName: 'Grep', input: { pattern: '.env', path: 'src' } }, 'searching for the string ".env"');
  });

  test('F2: str_replace_editor{command:"view"} is a read, not an edit', () => {
    // heavy-path.mjs returns early on WRITE/EDIT (#6); str_replace_editor
    // normalised to KIND.EDIT regardless of `command`, so a `view` call — an
    // unbounded read of a file or a whole directory — slipped past that
    // return under an editor's name. No wired harness has been observed
    // sending this shape (see normalize.mjs), so this pins the code-level fix
    // rather than a reproduced live incident.
    assert.equal(
      normalize({ toolName: 'str_replace_editor', input: { command: 'view', path: 'x' } }).kind,
      KIND.READ,
    );
    blocked(
      { toolName: 'str_replace_editor', input: { command: 'view', path: 'node_modules/x/big.d.ts' } },
      'viewing a file inside node_modules',
    );
    blocked(
      { toolName: 'str_replace_editor', input: { command: 'view', path: 'dist/bundle.js' } },
      'viewing a generated bundle',
    );
  });

  test('F3: boundedRead requires an actual numeric bound, not just a present field', () => {
    // Each of these has an offset/limit field, but none of them bounds
    // anything — they must all still block on a heavy path.
    blocked({ toolName: 'Read', input: { file_path: 'dist/bundle.js', limit: 999999 } }, 'limit far past useful');
    blocked({ toolName: 'Read', input: { file_path: 'dist/bundle.js', limit: 0 } }, 'limit: 0 bounds nothing');
    blocked({ toolName: 'Read', input: { file_path: 'dist/bundle.js', limit: -1 } }, 'negative limit');
    blocked({ toolName: 'Read', input: { file_path: 'dist/bundle.js', limit: false } }, 'limit: false is not a number');
    blocked({ toolName: 'Read', input: { file_path: 'dist/bundle.js', limit: {} } }, 'limit: {} is not a number');
    blocked({ toolName: 'Read', input: { file_path: 'dist/bundle.js', limit: '40' } }, 'a stringified limit');
    blocked({ toolName: 'Read', input: { file_path: 'dist/bundle.js', offset: 1 } }, 'offset with no limit reads to EOF');
    // The real corpus call this stage's fix must keep passing.
    allowed(
      {
        toolName: 'Read',
        input: {
          file_path: 'node_modules/@xterm/xterm/src/common/services/OptionsService.ts',
          limit: 40,
        },
      },
      'the real replayed call with an actual bound',
    );
  });

  test('F2 regression guard: Write dist/x.js is fine, Write dist/.env is not', () => {
    // Pins #6's early return (heavyPath ignores writes into generated dirs)
    // and invariant #5 (secret still fires on a write regardless) together,
    // so a future change cannot fix one by breaking the other.
    allowed({ toolName: 'Write', input: { file_path: 'dist/x.js', content: 'x' } }, 'writing a build artifact');
    blocked({ toolName: 'Write', input: { file_path: 'dist/.env', content: 'KEY=1' } }, 'writing a secret, even into dist');
  });

  test('cross-harness half of #5: omp grep with case/gitignore flags', () => {
    allowed(
      { toolName: 'grep', input: { pattern: '*.ts', path: '.', case: true, gitignore: true } },
      'omp grep with a glob-looking search term',
    );
  });
});
