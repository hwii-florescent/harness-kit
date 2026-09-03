#!/usr/bin/env node
/**
 * Replay real agent history through the guardrails.
 *
 * Unit tests prove the logic; they cannot tell you whether the kit is going to
 * be *annoying*. This does. It walks recorded transcripts, feeds every tool
 * call to checkTool(), and reports what fraction would have been blocked.
 *
 * Those calls actually ran and were overwhelmingly legitimate, so the rate is a
 * false-positive estimate — an empirical stand-in for the Phase 0 exit
 * criterion, available in seconds instead of a fortnight. It found the bug that
 * blocked `grep -rn "build" src` at 1-in-25.
 *
 * Read-only. Run it after any change to bash.mjs or the guardrails.
 *
 *   node scripts/replay.mjs                 # ~/.claude/projects
 *   node scripts/replay.mjs <dir> --verbose
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { checkTool } from '../src/core/index.mjs';

const args = process.argv.slice(2);
const verbose = args.includes('--verbose') || args.includes('-v');
const root = args.find((a) => !a.startsWith('-')) ?? path.join(os.homedir(), '.claude', 'projects');

/** Tools the kit has an opinion about; everything else is allowed unread. */
const IN_SCOPE = new Set(['Bash','Read','Write','Edit','MultiEdit','NotebookEdit','Glob','Grep']);

function transcripts(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

const files = transcripts(root);
if (!files.length) {
  console.error(`no .jsonl transcripts under ${root}`);
  process.exit(1);
}

let total = 0;
let scoped = 0;
const blocks = [];

for (const file of files) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block?.type !== 'tool_use') continue;
      total++;
      if (!IN_SCOPE.has(block.name)) continue;
      scoped++;

      const verdict = checkTool({
        hook_event_name: 'PreToolUse',
        tool_name: block.name,
        tool_input: block.input,
        cwd: entry.cwd || process.cwd(),
      });

      if (verdict.blocked) {
        blocks.push({
          guardrail: verdict.guardrail,
          target: verdict.target,
          detail: String(block.input?.command ?? block.input?.file_path ?? block.input?.pattern ?? '')
            .slice(0, 100).replace(/\n/g, ' '),
        });
      }
    }
  }
}

const rate = scoped ? (blocks.length / scoped) * 100 : 0;
console.log(`\n  transcripts  ${files.length}`);
console.log(`  tool calls   ${total} total, ${scoped} in scope`);
console.log(`  blocked      ${blocks.length}  (${rate.toFixed(2)}%)\n`);

const byGuardrail = new Map();
for (const b of blocks) byGuardrail.set(b.guardrail, (byGuardrail.get(b.guardrail) ?? 0) + 1);
for (const [name, n] of [...byGuardrail].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${name.padEnd(11)} ${n}`);
}

if (verbose && blocks.length) {
  const distinct = new Map();
  for (const b of blocks) {
    const key = `${b.guardrail}\t${b.target}\t${b.detail}`;
    distinct.set(key, (distinct.get(key) ?? 0) + 1);
  }
  console.log(`\n  ${distinct.size} distinct, most frequent first:\n`);
  for (const [key, n] of [...distinct].sort((a, b) => b[1] - a[1])) {
    const [guardrail, target, detail] = key.split('\t');
    console.log(`    ${String(n).padStart(3)}x [${guardrail}] "${target}"`);
    console.log(`         ${detail}`);
  }
}

// Every remaining block should be one you would defend. Read them, do not just
// watch the number.
console.log();
