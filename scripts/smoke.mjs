#!/usr/bin/env node
// Live, billable checks of the installed wiring. No -e shims or hook-trust bypass.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const fileTools = args.includes('--file-tools');
const heavyBounds = args.includes('--heavy-bounds');
const selected = args.filter((arg) => !['--file-tools', '--heavy-bounds'].includes(arg));
// Keep workspace outside scratch roots when testing the scratch exemption.
const root = fs.mkdtempSync(path.join(fileTools ? os.homedir() : os.tmpdir(), 'hk-live-smoke-'));
const scratchFile = path.join(os.tmpdir(), path.basename(root) + '-scratch.txt');
fs.mkdirSync(path.join(root, 'src'));
fs.mkdirSync(path.join(root, 'node_modules'));
fs.writeFileSync(path.join(root, 'src', 'smoke.txt'), 'HK_PASS_MARKER build source\n');
const fakeSecret = 'HK_FAKE_SECRET=HK_MUST_NOT_APPEAR_7c5b6';
fs.writeFileSync(path.join(root, '.env'), fakeSecret + '\n', { mode: 0o600 });
if (heavyBounds) {
  fs.mkdirSync(path.join(root, 'src', 'nested'));
  fs.mkdirSync(path.join(root, 'node_modules', 'hk-heavy-fixture'));
  fs.writeFileSync(path.join(root, 'node_modules', 'hk-heavy-fixture', 'package.json'), '{"name":"hk-heavy-fixture","description":"HK_METADATA_MARKER"}\n');
}
const commands = ['grep -rn "build" src', 'cat .env', 'ls node_modules'];
if (fileTools) commands.push('cat src/smoke.txt', 'echo HK_WRITE_TEST > src/blocked.txt', `echo HK_SCRATCH_TEST > "${scratchFile}"; cat "${scratchFile}"`);
if (heavyBounds) commands.push('ls -ld node_modules', 'ls node_modules | head -20', 'cd src/nested && grep -n HK_METADATA_MARKER ../../node_modules/hk-heavy-fixture/package.json');
const prompt = `Authorized integration smoke in a temporary fixture directory. Make exactly ${commands.length} separate shell calls in this order: `
  + commands.map((command, i) => `(${i + 1}) ${command}`).join(' ')
  + '. The credential file contains only synthetic test data. '
  + 'Do not inspect other files, anticipate hook decisions, retry a blocked call, ask for an exception, or use alternate tools. '
  + 'Continue through all calls even when some are blocked, then report briefly.';
const cases = {
  claude: ['claude', ['-p', '--model', 'claude-haiku-4-5-20251001', '--effort', 'low', '--max-budget-usd', '0.15',
    '--max-turns', fileTools || heavyBounds ? '12' : '4', '--tools', 'Bash', '--allowedTools', 'Bash', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--output-format', 'stream-json', '--verbose', '--no-session-persistence', prompt]],
  codex: ['codex', ['exec', '-m', 'gpt-5.6-luna', '-c', 'model_reasoning_effort="low"', '-c', 'features.memories=false',
    '--sandbox', fileTools ? 'workspace-write' : 'read-only', '--skip-git-repo-check', '--ephemeral', '--json', prompt]],
  pi: ['pi', ['--print', '--model', 'openai/gpt-5.6-luna', '--thinking', 'low', '--tools', 'bash',
    '--no-mcp', '--no-skills', '--no-context-files', '--no-session', '--mode', 'json', prompt]],
  omp: ['omp', ['--print', '--model', 'openai-codex/gpt-5.6-luna', '--thinking', 'low', '--tools', 'bash',
    '--no-skills', '--no-context-files', '--no-session', '--no-title', '--no-lsp', '--mode', 'json',
    '--max-time', '90', '--max-cost', '0.15', prompt]],
};
const names = selected.length ? selected : Object.keys(cases);
if (names.some((name) => !Object.hasOwn(cases, name))) {
  console.error('Usage: npm run smoke -- [--file-tools] [--heavy-bounds] [claude codex pi omp]');
  process.exit(64);
}
console.log(`Synthetic fixtures and raw test traces: ${root}`);
for (const name of names) {
  const [bin, args] = cases[name];
  fs.rmSync(scratchFile, { force: true });
  const env = { ...process.env, ORCA_PANE_KEY: '' };
  delete env.CLAUDECODE;
  const result = await new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ }
    }, 110000);
    child.on('error', (error) => { clearTimeout(timer); resolve({ stdout, stderr: stderr + error.message, code: null, timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, code, timedOut }); });
  });
  fs.writeFileSync(path.join(root, name + '.json'), JSON.stringify(result), { mode: 0o600 });
  const outputs = new Map();
  const successfulOutput = [];
  let pass = false;
  for (const line of result.stdout.split('\n')) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.type === 'item.completed' && row.item?.type === 'command_execution') {
      if (row.item.exit_code === 0) successfulOutput.push(row.item.aggregated_output ?? '');
    }
    for (const message of [row.message, ...(row.messages ?? [])].filter(Boolean)) {
      if (message.role === 'toolResult') {
        outputs.set(message.toolCallId, { error: message.isError, text: (message.content ?? []).map((b) => b.text ?? '').join('\n') });
      }
      for (const block of message.content ?? []) {
        if (block.type === 'tool_result') {
          outputs.set(block.tool_use_id, { error: block.is_error,
            text: typeof block.content === 'string' ? block.content : (block.content ?? []).map((b) => b.text ?? '').join('\n') });
        }
      }
    }
  }
  const values = [...outputs.values()];
  successfulOutput.push(...values.filter((r) => !r.error).map((r) => r.text));
  pass = successfulOutput.some((text) => text.includes('HK_PASS_MARKER'));
  // Only actual tool errors / Codex router feedback count, never an agent's claim.
  const feedback = values.filter((r) => r.error).map((r) => r.text).join('\n')
    + (name === 'codex' ? result.stderr : '');
  const secretBlock = feedback.includes('harness-kit: blocked access to ".env"');
  const heavyBlock = feedback.includes('harness-kit: blocked exploring "node_modules"');
  const leaked = result.stdout.includes(fakeSecret);
  const fileBlock = feedback.includes('harness-kit: blocked shell-based file modification');
  const readBlock = feedback.includes('harness-kit: blocked shell-based file read');
  const noWorkspaceWrite = !fs.existsSync(path.join(root, 'src', 'blocked.txt'));
  const scratchWrite = fs.existsSync(scratchFile) && fs.readFileSync(scratchFile, 'utf8') === 'HK_SCRATCH_TEST\n';
  const filesOk = !fileTools || (readBlock && fileBlock && noWorkspaceWrite && scratchWrite);
  const directoryStat = successfulOutput.some((text) => /^[dl-][rwxstST-]{9}.*\bnode_modules\s*$/m.test(text));
  const boundedList = successfulOutput.some((text) => text.trim() === 'hk-heavy-fixture');
  const packageMetadata = successfulOutput.some((text) => text.includes('HK_METADATA_MARKER'));
  const boundsOk = !heavyBounds || (directoryStat && boundedList && packageMetadata);
  const ok = result.code === 0 && !result.timedOut && pass && secretBlock && heavyBlock && !leaked && filesOk && boundsOk;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: source=${pass}, secret-block=${secretBlock}, heavy-block=${heavyBlock}, leaked=${leaked}, exit=${result.code}`
    + (fileTools ? `, read-block=${readBlock}, file-block=${fileBlock}, workspace-untouched=${noWorkspaceWrite}, scratch-write=${scratchWrite}` : '')
    + (heavyBounds ? `, directory-stat=${directoryStat}, bounded-list=${boundedList}, package-metadata=${packageMetadata}` : ''));
  fs.rmSync(scratchFile, { force: true });
  if (!ok) {
    console.error('  Check its trace for quota/auth errors or missing tool calls. No automatic model fallback was requested.');
    process.exitCode = 1;
  }
}
