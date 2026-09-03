/**
 * Shell command analysis.
 *
 * Guardrails must not block the build. `npm run build` legitimately reads
 * `node_modules` and writes `dist`, so a naive substring match on a blocked
 * directory would fire on nearly every real command. This module exists to tell
 * "the agent is rummaging through node_modules" apart from "the agent is
 * building the project".
 *
 * Strategy: unwrap shell executors, split compound commands, strip prefixes,
 * then allowlist each sub-command independently.
 */

/** `npm run build`, `pnpm --filter web test`, `yarn workspace app lint`, … */
const PACKAGE_SCRIPT = /^(npm|pnpm|yarn|bun)\s+([^\s]+\s+)*(run\s+)?(build|test|lint|dev|start|install|ci|add|remove|update|publish|pack|init|create|exec|typecheck|format)\b/;

/** Toolchain binaries that legitimately traverse blocked directories. */
const TOOLCHAIN = /^(\.\/)?(npx|pnpx|bunx|tsc|tsx|esbuild|vite|webpack|rollup|turbo|nx|jest|vitest|mocha|playwright|eslint|prettier|biome|go|cargo|make|mvn|mvnw|gradle|gradlew|dotnet|docker|podman|kubectl|helm|terraform|ansible|bazel|cmake|sbt|flutter|swift|ninja|meson|python3?|pip3?|uv|poetry|deno|bundle|rake|gem|php|composer|ruby|mix|elixir|node)\b/;

/** Anything executed from inside a virtualenv is by definition allowed. */
const VENV_EXEC = /(^|[/\\])\.?venv[/\\](bin|Scripts)[/\\]/;

/** Creating a virtualenv writes into `.venv`, which is otherwise blocked. */
const VENV_CREATE = /^(python3?|py)\s+(-[\w.]+\s+)*-m\s+venv\s+|^uv\s+venv(\s|$)|^virtualenv\s+/;

/** `bash -c "…"`, `sh -c '…'`, `eval "…"` → the inner command. */
export function unwrapShellExecutor(command) {
  if (typeof command !== 'string') return command;
  const m = command.trim().match(/^(?:(?:bash|sh|zsh|dash)\s+-c|eval)\s+["'](.+)["']\s*$/s);
  return m ? m[1] : command;
}

/**
 * Split on `&&`, `||`, `;` and `|`.
 *
 * Newlines are deliberately not split on: in practice they are heredoc bodies
 * and multiline strings, not compound operators.
 */
export function splitCompound(command) {
  if (typeof command !== 'string') return [];
  return command.split(/\s*(?:&&|\|\||[;|])\s*/).map((s) => s.trim()).filter(Boolean);
}

/**
 * `NODE_ENV=production sudo env FOO=1 npm run build` → `npm run build`
 *
 * Wrappers nest arbitrarily, so strip until the string stops changing rather
 * than assuming a fixed depth.
 */
export function stripPrefix(command) {
  if (typeof command !== 'string') return command;
  let s = command.trim();
  for (let i = 0; i < 5; i++) {
    const before = s;
    s = s.replace(/^(\w+=\S*\s+)+/, '');
    s = s.replace(/^(sudo|env|nice|nohup|time|timeout|command|exec)\s+(-\S+\s+)*/, '');
    s = s.trim();
    if (s === before) break;
  }
  return s;
}

/** True when this single sub-command is build/toolchain work, not exploration. */
export function isAllowedCommand(command) {
  const s = stripPrefix(command);
  return PACKAGE_SCRIPT.test(s) || TOOLCHAIN.test(s) || VENV_EXEC.test(s) || VENV_CREATE.test(s);
}

/**
 * Reduce a command to the sub-commands that still need checking.
 * Returns [] when the whole command is allowlisted.
 */
export function suspectSubCommands(command) {
  const unwrapped = unwrapShellExecutor(command);
  return splitCompound(unwrapped).filter((sub) => !isAllowedCommand(sub));
}

/**
 * Commands that pull file *content* or directory listings into the transcript.
 *
 * This is the distinction the heavy-path guardrail needs. Its concern is context
 * economy, so `cat dist/bundle.js` is a problem and `rm -rf dist` is not —
 * deleting generated files is routine cleanup that costs no context at all.
 * The secret guardrail deliberately does not use this filter: copying a `.env`
 * somewhere is an exfiltration risk even though it prints nothing.
 */
const CONTENT_READ = /^(cat|bat|less|more|head|tail|ls|ll|la|dir|tree|find|fd|grep|rg|ag|ack|awk|sed|wc|od|xxd|strings|jq|yq|diff|open|code|nl|tac|column|sort|uniq)\b/;

export function isContentReadCommand(command) {
  return CONTENT_READ.test(stripPrefix(command));
}

/**
 * Free-text flag values that must not be scanned for paths.
 *
 * `git commit -m "fix .env loading"` is a legitimate command that mentions a
 * secret filename. Treating the message as a path would block it — exactly the
 * false-positive class that gets a guardrail uninstalled.
 */
const MESSAGE_FLAG = /(?:^|\s)-{1,2}(?:m|message|c|comment|d|description|t|title)(?:=|\s+)(["'])(?:(?!\1).)*\1/g;
const MESSAGE_FLAG_BARE = new Set(['-m', '--message', '-c', '--comment', '-d', '--description', '-t', '--title']);

/**
 * Pull filesystem path candidates out of a command string.
 *
 * Deliberately permissive: every operand is a candidate, because a bare
 * directory name like `node_modules` has no slash and no extension yet is
 * exactly what we need to catch. Precision comes from the guardrails, which
 * only match whole path segments against a known list — a stray word such as
 * `express` in `npm install express` matches nothing and costs nothing.
 */
export function extractPaths(command) {
  if (typeof command !== 'string') return [];

  const tokens = command.replace(MESSAGE_FLAG, ' ').split(/\s+/);
  const out = [];
  let skipNext = false;

  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i];
    if (!raw) continue;

    if (skipNext) { skipNext = false; continue; }
    if (MESSAGE_FLAG_BARE.has(raw)) { skipNext = true; continue; }
    if (i === 0) continue;                       // the command itself, not an operand
    if (raw.startsWith('-')) continue;           // a flag
    if (/^[&|;<>()$]/.test(raw)) continue;       // shell punctuation

    const token = raw.replace(/^["'`]+/, '').replace(/["'`,;)]+$/, '');
    if (token) out.push(token);
  }

  return out;
}
