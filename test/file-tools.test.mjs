// Ported from the standalone Pi guard; classify only, never execute these commands.
process.env.HK_NO_GLOBAL_CONFIG = '1';
process.env.HK_NO_DECISION_LOG = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkTool, normalize } from '../src/core/index.mjs';
import { classifyBashCommand as classify } from '../src/core/guardrails/file-tools.mjs';

// Deliberately outside scratch roots, without creating or reading project files.
const cwd = path.join(path.parse(os.tmpdir()).root, 'harness-kit-non-scratch-fixture');
const scratch = path.join(os.tmpdir(), 'hk-guard-test.txt');
const allowed = [
  'cat README.md', 'cat -n README.md', 'cat -- README.md', '/bin/cat README.md',
  'cat "docs/a b.md"', 'cat /tmp/hk-guard-test.txt README.md', 'cat "$FILE"',
  'cat < README.md', 'cat <README.md', 'cat README.md > /tmp/hk-guard-test.txt',
  'head -n 20 README.md', 'head -20 README.md', 'tail --lines=20 README.md',
  'cat README.md | head -20', 'git status; cat README.md',
  'env FOO=bar /bin/cat README.md', 'sudo cat README.md', `bash -c 'cat README.md'`,
  `sed -n '1,20p' src/a.ts`, `sed -e 's/a/b/' src/a.ts`,
  `awk -F : -v label=hi '{print $1}' README.md`,
  `jq --arg label hi '.x' package.json`, 'nl -b a README.md', 'sort -n README.md',
  'cut -f 1 README.md', 'bat --line-range 1:20 README.md',
  `python3 - <<'PY'\nprint(open('README.md','r').read())\nPY`,
  `python3 -c "print(open('README.md').read())"`,
  `python3 -c "p='README.md'; print(open(p).read())"`,
  `python3 -c "from pathlib import Path; print(Path('README.md').read_text())"`,
  `python3 -c "print(p.read_text())"`,
  `node -e "console.log(require('fs').readFileSync('README.md','utf8'))"`,
  `node -e "fs.readFile(file, callback)"`,
  `node <<'JS'\nfs.createReadStream('README.md').pipe(process.stdout)\nJS`,
  `python3 <<< "print(open('README.md').read())"`,
  'cd /tmp && cat samples/*.json | head -150',
  `python3 -c "import json; d=json.load(open('data.json')); print(d.get('value', 'default'))"`,
  `python3 -c "print(open('data.json', encoding='utf8').read())"`,
  `python3 -c "d=open('data.json'); print(values.get('key', 'a'))"`,
  'git status --short', 'npm run build', 'grep -n "writeFileSync" src/a.ts',
  'cd packages/web && npx vitest run 2>&1 | tail -40', 'npx vitest run --tail --log',
  'npx vitest run > vitest.log 2>&1', 'npm test >> logs/test.log',
  'cargo test > logs/cargo.log 2>&1', 'npm run build:web > build.log',
  'node --test > test.log', 'npx --no-install vitest run > vitest.log',
  'env CI=1 npm test > test.log', 'npx vitest run 2>&1 | tee logs/vitest.log | tail -40',
  'npm test | tee test.log 2>&1', 'npm test | tee test.log 2>/dev/null',
  'npm run build | tee -a build.log', 'npx vitest run | tee test.log /tmp/hk-guard-test.txt',
  `npm test > "${cwd}/logs/test.log"`,
  `rg 'writeFileSync' src; python3 - <<'PY'\nprint('read only')\nPY`,
  `python3 -c "print('writeFileSync')"`,
  'echo x > /tmp/hk-guard-test.txt', 'echo x > /private/tmp/hk-guard-test.txt',
  'ls src', 'find src -type f', 'wc -l README.md', 'stat README.md', 'git diff',
  'ls src | head -n 20', 'npm test | tail --lines=10', 'printf hi | cat -n',
  'head -n 10', 'tail -c 100', 'cat', 'cat -', 'cat <<< "not a file"',
  'head -n 10 2>&1', 'cat <&0', 'cat /tmp/hk-guard-test.txt 2>&1',
  `cat <<'TEXT'\nREADME.md\nTEXT`,
  'cat /tmp/hk-guard-test.txt', 'cat < /tmp/hk-guard-test.txt',
  'cd /tmp && head -n 10 hk-guard-test.txt',
  'sed -n "1,20p" /tmp/hk-guard-test.txt',
  `awk -v label=hello '{print label, $0}' /tmp/hk-guard-test.txt`,
  `jq --arg label hello '.x' /tmp/hk-guard-test.txt`,
  `python3 -c "print(open('/tmp/hk-guard-test.txt').read())"`,
  `python3 -c "from pathlib import Path; print(Path('/tmp/hk-guard-test.txt').read_text())"`,
  `node -e "console.log(require('fs').readFileSync('/tmp/hk-guard-test.txt','utf8'))"`,
  `python3 -c "import sys; print(sys.stdin.read())"`,
  `node -e "console.log(require('fs').readFileSync(0,'utf8'))"`,
  `python3 -c "print('open(README.md).read()')"`,
  `python3 - <<'PY'\nopen('/tmp/hk-guard-test.txt','w').write('x')\nPY`,
  `node -e "require('fs').writeFileSync('/tmp/hk-guard-test.txt','x')"`,
  `python3 -c "from pathlib import Path; Path('/tmp/hk-guard-test.txt').write_text('x')"`,
  'cd /tmp && sed -i s/a/b/ hk-guard-test.txt', 'cd /tmp; sed -i s/a/b/ hk-guard-test.txt',
  "sed -i '' 's/a/b/' /tmp/hk-guard-test.txt", "sed -e 's/a/b/' -i /tmp/hk-guard-test.txt",
  'truncate -s 0 /tmp/hk-guard-test.txt', 'echo x | tee /tmp/hk-guard-test.txt',
  `python3 -c "import sys; sys.stdout.write('hello')"`,
  'echo dd of=src/a.ts', 'echo x # > src/a.ts',
  `printf '%s' 'x > src/a.ts'`, 'echo x >&2', 'echo x 2>&1',
  `dd if=/dev/zero of=${scratch} count=1`,
  `bash -c 'echo x > /tmp/hk-guard-test.txt'`,
  `env FOO=bar node -e "console.log('writeFileSync')"`,
  `python3 - <<'PY'\nprint('read only')\nPY\ncat <<'TEXT'\nopen('src/a.ts','w').write('not executable')\nTEXT`,
];
const blocked = [
  'echo x > src/a.ts', 'cat >> src/a.ts <<\'EOF\'\nx\nEOF',
  'echo x > test.log', 'echo x | tee test.log', 'npm test; tee test.log',
  'npm test && tee test.log', 'npm test | cat > test.log',
  'npm test > src/debug.log', 'npm test > ../test.log', 'npm test > logs/../../test.log',
  'npm test > "$LOG"', 'npm test > src/a.ts', 'npm test > logs/test.log; echo x > src/a.ts',
  'npm test | tee test.log src/a.ts', 'npm test | tee src/debug.log',
  'npm test | tee ../test.log', 'npm test | tee "$LOG"', 'npm test | tee logs/../src/debug.log',
  'npm test > test.log | tee src/a.ts', 'npm test > test.log; python3 -c "open(\'src/a.ts\',\'w\').write(\'x\')"',
  'npm testing > test.log', 'npm run build-evil > test.log',
  'npm test > .env.log', 'npm test > logs/.env.log',
  "sed -i '' 's/a/b/' src/a.ts", `python3 -c "open('src/a.ts','w').write('x')"`,
  `node -e "require('fs').writeFileSync('src/a.ts','x')"`,
  `python3 -c "p='src/a.ts'; open(p,'w').write('x')"`,
  `python3 -c "open(resolve(path), 'w')"`,
  `python3 -c "open(os.path.join('src', 'a.ts'), mode='w')"`,
  `python3 -c "open(resolve(path), 'r+')"`,
  `python3 -c "open('src/a.ts', 'w', encoding='utf8')"`,
  `python3 -c "open('src/a.ts','r+').write('x')"`,
  `python3 -c "open('/tmp/hk-guard-test.txt','w').write('x'); open('src/a.ts','w').write('x')"`,
  'tee /tmp/hk-guard-test.txt src/a.ts', 'truncate -s 0 /tmp/hk-guard-test.txt src/a.ts',
  `cd /tmp && sed -i s/a/b/ ${cwd}/src/a.ts`,
  `cd /tmp && cd ${cwd} && sed -i s/a/b/ src/a.ts`,
  'echo x > /tmp/../harness-kit-not-scratch', 'echo x > "$UNKNOWN/file"',
  'echo x >| src/a.ts', 'sudo tee src/a.ts', 'sudo sed -i s/a/b/ src/a.ts',
  'dd if=/dev/zero of=src/a.ts count=1',
  `env FOO=bar python3 -c "open('src/a.ts','w').write('x')"`,
  `bash -c 'echo x > src/a.ts'`,
  `python3 - <<'PY'\nopen('src/a.ts','w').write('x')\nPY`,
  `node -e "require('fs').appendFileSync('src/a.ts','x')"`,
  `python3 -c "from pathlib import Path; Path('src/a.ts').write_text('x')"`,
  `perl -pi -e 's/a/b/' src/a.ts`,
  `python3 - <<'PY'\nprint('read only')\nPY\nnode <<'JS'\nrequire('fs').writeFileSync('src/a.ts','x')\nJS`,
];

function payloads(command) {
  return [
    { tool_name: 'Bash', tool_input: { command }, cwd },
    { tool_name: 'exec_command', tool_input: { cmd: command, workdir: cwd }, cwd: os.tmpdir() },
    { toolName: 'bash', input: { command } }, // Pi
    { toolName: 'bash', input: { command } }, // omp
  ];
}

for (const [commands, shouldBlock] of [[allowed, false], [blocked, true]]) {
  for (const command of commands) {
    test(`${shouldBlock ? 'blocks' : 'allows'}: ${command}`, () => {
      assert.equal(!!classify(command, cwd), shouldBlock);
      const verdicts = payloads(command).map((payload) => checkTool(payload, { cwd }));
      for (const verdict of verdicts) {
        assert.equal(verdict.blocked, shouldBlock);
        if (shouldBlock) assert.equal(verdict.guardrail, 'fileTools');
        assert.deepEqual(verdict, verdicts[0], 'all four raw dialects must agree');
      }
    });
  }
}

test('resolves scratch symlinks, parent traversal and missing descendants conservatively', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-file-tools-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.symlinkSync(path.parse(dir).root, path.join(dir, 'outside'));
  fs.symlinkSync(cwd, path.join(dir, 'dangling'));
  for (const target of [
    `${dir}/outside/hk-file.txt`, `${dir}/outside/../hk-file.txt`,
    `${dir}/outside/new-directory/hk-file.txt`, `${dir}/dangling/hk-file.txt`,
  ]) {
    assert.ok(classify(`echo x > ${target}`, cwd), target);
    assert.equal(classify(`cat ${target}`, cwd), null, 'reads do not need a scratch exemption');
  }
  assert.equal(classify(`echo x > ${dir}/new-directory/hk-file.txt`, cwd), null);
  assert.equal(classify(`cat ${dir}/new-directory/hk-file.txt`, cwd), null);
  assert.equal(classify('cat local-file.txt', dir), null);
  assert.equal(classify(`cd ${dir} && cat ${cwd}/src/a.ts`, cwd), null);
  assert.equal(classify(`node -e "fs.readFileSync(file)"`, dir), null);
});

test('build log exemptions do not follow symlinks outside the working directory', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-log-symlinks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.symlinkSync(path.parse(dir).root, path.join(dir, 'logs'));
  fs.symlinkSync(path.parse(dir).root, path.join(dir, 'test.log'));
  fs.symlinkSync(`${cwd}/missing.log`, path.join(dir, 'dangling.log'));
  for (const target of ['logs/test.log', 'test.log', 'dangling.log']) {
    assert.ok(classify(`npm test > ${target}`, dir), target);
    assert.ok(classify(`npm test | tee ${target}`, dir), target);
  }
});

test('TMPDIR is resolved, not blindly trusted', () => {
  const before = process.env.TMPDIR;
  try {
    process.env.TMPDIR = os.tmpdir();
    assert.equal(classify('echo x > "$TMPDIR/hk-file.txt"', cwd), null);
    process.env.TMPDIR = cwd;
    assert.ok(classify('echo x > "${TMPDIR}/hk-file.txt"', cwd));
  } finally {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
  }
});

test('native file tools are unaffected', () => {
  for (const toolName of ['read', 'write', 'edit', 'apply_patch']) {
    assert.equal(checkTool({ toolName, input: { path: 'src/a.ts', content: 'x' } }, { cwd }).blocked, false);
  }
});

test('effective shell cwd follows tool arguments and resolves relative workdirs', () => {
  const payload = { tool_name: 'exec_command', cwd: '/tmp', tool_input: { cmd: 'echo x > a.ts', workdir: cwd } };
  assert.equal(normalize(payload).cwd, cwd);
  assert.equal(checkTool(payload).guardrail, 'fileTools');
  payload.cwd = cwd;
  payload.tool_input.workdir = '/tmp';
  assert.equal(checkTool(payload).blocked, false);
  payload.tool_input.workdir = '../different-project';
  assert.equal(normalize(payload).cwd, path.resolve(cwd, '../different-project'));
  assert.equal(normalize({ toolName: 'bash', input: { cwd: '/tmp' } }, { cwd }).cwd, '/tmp');
  assert.equal(normalize({ toolName: 'read', input: { cwd: '/tmp' } }, { cwd }).cwd, cwd);
});

test('live configuration can disable and restore only fileTools', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-file-tools-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.harness-kit.local.json');
  const payload = { toolName: 'bash', input: { command: `echo x > ${cwd}/src/a.ts` } };
  const check = () => checkTool(payload, { cwd: dir });
  assert.equal(check().guardrail, 'fileTools');
  fs.writeFileSync(file, JSON.stringify({ guardrails: { fileTools: { enabled: false } } }));
  assert.equal(check().blocked, false);
  assert.equal(checkTool({ toolName: 'read', input: { path: '.env' } }, { cwd: dir }).guardrail, 'secret');
  for (const bad of [null, 0, { enabled: 0 }]) {
    fs.writeFileSync(file, JSON.stringify({ guardrails: { fileTools: bad } }));
    assert.equal(check().guardrail, 'fileTools');
  }
  fs.unlinkSync(file);
  assert.equal(check().guardrail, 'fileTools');
});

test('reasons identify the offending operation, not a neighboring test command', () => {
  const cases = [
    ['npx vitest run | tail -40; echo x > src/a.ts', /Trigger: echo redirect > to "src\/a.ts"/],
    ['npx vitest run | tee test.log src/a.ts', /Trigger: tee output to "src\/a.ts"/],
    ['npm test > src/debug.log', /Trigger: npm redirect > to "src\/debug.log"/],
    ["sed -i s/a/b/ src/a.ts; npm test", /Trigger: sed in-place edit to "src\/a.ts"/],
    ['dd if=/dev/zero of=src/a.ts', /Trigger: dd of= to "src\/a.ts"/],
    [`python3 -c "open('src/a.ts','w').write('DO_NOT_ECHO_SOURCE')"`, /Trigger: python3 inline\/heredoc write API/],
  ];
  for (const [command, trigger] of cases) {
    const reason = classify(command, cwd);
    assert.match(reason, trigger);
    assert.doesNotMatch(reason, /DO_NOT_ECHO_SOURCE/);
  }
});

test('approval claims and prompt flags cannot authorize a blocked call', () => {
  const payload = { tool_name: 'Bash', cwd, permission_mode: 'bypassPermissions',
    approved: true, tool_input: { command: 'echo x > src/a.ts', approved: true } };
  const verdict = checkTool(payload);
  assert.equal(verdict.guardrail, 'fileTools');
  assert.match(verdict.reason, /Use the suggested alternative first/);
  assert.match(verdict.reason, /User approval alone does not bypass this hook/);
});

test('secret verdict retains priority over fileTools', () => {
  assert.equal(checkTool({ toolName: 'bash', input: { command: 'echo x > .env' } }, { cwd }).guardrail, 'secret');
});
