/**
 * Real payload shapes for each harness.
 *
 * The point of the kit is that one core serves four harnesses. These builders
 * are how that claim gets tested: the same logical call, expressed four ways,
 * must produce the same verdict. If a harness changes its payload shape, this
 * file is the single place to update.
 */

export const CWD = '/tmp/harness-kit-fixture-project';

/** Claude Code: PascalCase tools, snake_case envelope. */
export function claude(tool, input, event = 'PreToolUse') {
  return { hook_event_name: event, session_id: 'test', cwd: CWD, tool_name: tool, tool_input: input };
}

/** Codex: same envelope, lowercase/underscored tool names. */
export function codex(tool, input, event = 'PreToolUse') {
  return { hook_event_name: event, cwd: CWD, tool_name: tool, tool_input: input };
}

/** Pi / omp: camelCase, and cwd arrives via ctx rather than the payload. */
export function pi(tool, input) {
  return { toolName: tool, input };
}

/**
 * The same logical call in all four dialects.
 * Each entry is `[label, payload, opts]` ready to hand to checkTool.
 */
export function everyHarness({ claudeTool, codexTool, piTool, input }) {
  return [
    ['claude', claude(claudeTool, input), {}],
    ['codex', codex(codexTool, input), {}],
    ['pi', pi(piTool, input), { cwd: CWD }],
    ['omp', pi(piTool, input), { cwd: CWD }],
  ];
}

/** Canonical cross-harness cases used by both the core and adapter suites. */
export const CASES = {
  readSecret: {
    claudeTool: 'Read', codexTool: 'read', piTool: 'read',
    input: { file_path: '.env' },
  },
  readSafeExample: {
    claudeTool: 'Read', codexTool: 'read', piTool: 'read',
    input: { file_path: '.env.example' },
  },
  listHeavyDir: {
    claudeTool: 'Bash', codexTool: 'shell', piTool: 'bash',
    input: { command: 'ls node_modules' },
  },
  buildCommand: {
    claudeTool: 'Bash', codexTool: 'shell', piTool: 'bash',
    input: { command: 'npm run build' },
  },
  broadGlob: {
    claudeTool: 'Glob', codexTool: 'glob', piTool: 'glob',
    input: { pattern: '**/*.ts', path: '.' },
  },
  scopedGlob: {
    claudeTool: 'Glob', codexTool: 'glob', piTool: 'glob',
    input: { pattern: '**/*.ts', path: 'src/components' },
  },
};
