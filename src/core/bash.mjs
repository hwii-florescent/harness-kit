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
 * Split on `&&`, `||`, `;`, `|` and newlines.
 *
 * A newline separates statements just as `;` does. It was once excluded to
 * protect heredoc bodies and multiline strings; `stripHeredocs` now removes
 * those before this runs, so treating a newline as an operator is safe — and
 * necessary, or a multi-line script is judged as one enormous command.
 */
export function splitCompound(command) {
  if (typeof command !== 'string') return [];
  return command.split(/\s*(?:&&|\|\||[;|\n])\s*/).map((s) => s.trim()).filter(Boolean);
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
  // `python3 script.py` is toolchain work; `python3 -c "open('.env')"` is
  // arbitrary code wearing a toolchain name, and must still be inspected.
  if (INTERPRETER.test(s)) return false;
  return PACKAGE_SCRIPT.test(s) || TOOLCHAIN.test(s) || VENV_EXEC.test(s) || VENV_CREATE.test(s);
}

/**
 * Reduce a command to the sub-commands that still need checking.
 * Returns [] when the whole command is allowlisted.
 */
export function suspectSubCommands(command) {
  const unwrapped = unwrapShellExecutor(stripHeredocs(command));
  return splitCompound(unwrapped).filter((sub) => !isAllowedCommand(sub));
}

/**
 * Commands whose output is inherently bounded, so they cannot flood context.
 *
 * `grep pattern file` prints matching lines; `head` prints a fixed count;
 * `wc`/`stat`/`du` print a summary. Reading one named file inside a generated
 * directory this way is normal work — checking a type definition, confirming a
 * binary was built — and costs a handful of lines.
 */
const BOUNDED_READ = /^(grep|egrep|fgrep|rg|ag|ack|head|tail|wc|file|stat|du|basename|dirname|readlink|realpath|cmp|diff)\b/;

/** Recursive search can walk a whole tree, so the bound comes off again. */
const RECURSIVE = /(^|\s)-[A-Za-z]*[rR][A-Za-z]*\b|--recursive/;

/** A leaf file rather than a directory: its last segment carries an extension. */
export function looksLikeFile(filePath) {
  const base = String(filePath).replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
  return /\.[A-Za-z0-9]{1,8}$/.test(base);
}

/**
 * Would this sub-command pour an unbounded amount of `target` into the
 * transcript? That, and not access itself, is what the heavy-path rule exists
 * to prevent.
 */
export function isBoundedRead(command, target, { listingRoot = false } = {}) {
  const s = stripPrefix(command);

  if (/>\s*\/dev\/null/.test(s)) return true;   // output discarded outright
  if (/^sed\s+-n\b/.test(s)) return true;       // `sed -n '30,60p'` is a line window

  // `ls` floods only at the root of a generated tree. `ls node_modules` prints
  // a thousand entries; `ls node_modules/.bin/tsc` prints one.
  if (/^ls\b/.test(s)) return !listingRoot;

  if (!BOUNDED_READ.test(s)) return false;
  if (RECURSIVE.test(s) && !looksLikeFile(target)) return false;
  return true;
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
 * Flags whose value is a pattern, a literal or a number — never a path.
 *
 * Scoped per command family, because the same letter means different things:
 * `-c` is a commit-message flag to git and a count flag to grep. A single
 * global set gets one of them wrong.
 */
const MESSAGE_FLAGS = new Set([
  '-m', '--message', '-c', '--comment', '-d', '--description', '-t', '--title',
]);

const GREP_FLAGS = new Set([
  '-e', '--regexp', '-f', '--file',
  '--include', '--exclude', '--exclude-dir',
  '-m', '--max-count', '-A', '-B', '-C', '--context',
]);

const FIND_FLAGS = new Set([
  '-name', '-iname', '-path', '-ipath', '-regex', '-iregex',
  '-type', '-perm', '-user', '-group', '-size',
  '-maxdepth', '-mindepth', '-mtime', '-mmin', '-newer',
]);

/** Commands with no file operands at all — their arguments are text to print. */
const NO_PATH_OPERANDS = /^(echo|printf|export|alias|unset|read|test|true|false|sleep|which|type|kill|pkill|pgrep|say)\b/;

/**
 * Commands whose first non-flag operand is a pattern or script, not a path.
 *
 * `grep -rn "build" src` searches for the word "build"; it does not read a
 * directory called build. Getting this wrong blocked 1 in 25 real calls.
 */
const PATTERN_FIRST = /^(grep|egrep|fgrep|rg|ag|ack|awk|sed)\b/;

/** Flags supplying the pattern directly, so the first operand is a path again. */
const PATTERN_FLAGS = new Set(['-e', '--regexp', '-f', '--file']);

/** The flag set that applies to this command. */
function valueFlagsFor(head) {
  if (PATTERN_FIRST.test(head)) return GREP_FLAGS;
  if (/^find\b/.test(head)) return FIND_FLAGS;
  return MESSAGE_FLAGS;
}

/**
 * Drop heredoc bodies.
 *
 * `python3 - <<'PY' … PY` carries a program, not operands. Its words are prose
 * and identifiers that collide with the blocklist — `build`, `out`, `target`.
 */
export function stripHeredocs(command) {
  if (typeof command !== 'string') return command;
  let out = command;
  const open = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1/;

  for (let guard = 0; guard < 10; guard++) {
    const m = open.exec(out);
    if (!m) break;

    const bodyStart = out.indexOf('\n', m.index);
    if (bodyStart === -1) { out = out.slice(0, m.index); break; }

    const rest = out.slice(bodyStart);
    const close = new RegExp(`^[ \\t]*${m[2]}[ \\t]*$`, 'm').exec(rest);
    const end = close ? bodyStart + close.index + close[0].length : out.length;
    out = `${out.slice(0, m.index)} ${out.slice(end)}`;
  }
  return out;
}

/**
 * Split into shell words, keeping quoted regions intact.
 *
 * Splitting on whitespace alone turns `echo "checking build output"` into four
 * operands, one of which is `build`. A quoted region is one value, and a value
 * with a space in it can never equal a single path segment.
 */
export function tokenize(command) {
  if (typeof command !== 'string') return [];
  const out = [];
  let cur = '';
  let quote = null;
  let quoted = false;

  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      quoted = true;
    } else if (/\s/.test(ch)) {
      if (cur || quoted) out.push(cur);
      cur = '';
      quoted = false;
    } else {
      cur += ch;
    }
  }
  if (cur || quoted) out.push(cur);
  return out;
}

/**
 * Pull filesystem path candidates out of a command string.
 *
 * A word's meaning comes from its role — which command it follows and where it
 * sits — not from its spelling. `build` after `grep` is a search term; `build`
 * after `cat` is a directory. This walks the operands with that in mind, and
 * everything it cannot account for stays a candidate: precision beyond this
 * point comes from the guardrails, which match whole path segments.
 */
export function extractPaths(command, { permissive = false } = {}) {
  if (typeof command !== 'string') return [];

  const head = stripPrefix(stripHeredocs(command));
  if (!permissive && NO_PATH_OPERANDS.test(head)) return [];

  const tokens = tokenize(head);
  // Permissive mode keeps every operand, including ones this command only
  // *names* — `find . -name .env -exec cat {} ;` and `echo .env | xargs cat`
  // read the file through a second command. Only the secret guardrail asks for
  // it: its patterns are basename-anchored and narrow, so the extra candidates
  // cost nothing, whereas heavy-path's blocklist is full of ordinary words.
  const valueFlags = permissive ? MESSAGE_FLAGS : valueFlagsFor(head);
  const out = [];
  let skipNext = false;
  let patternPending = !permissive && PATTERN_FIRST.test(head);

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;

    if (skipNext) { skipNext = false; continue; }

    if (token.startsWith('-') && token.length > 1) {
      const flag = token.split('=')[0];
      if (valueFlags.has(flag) && !token.includes('=')) skipNext = true;
      // The pattern came from a flag, so the next operand is a path after all.
      if (PATTERN_FLAGS.has(flag)) patternPending = false;
      continue;
    }

    if (token === '-' || /^[&|;<>()]/.test(token)) continue; // stdin, punctuation

    if (patternPending) { patternPending = false; continue; }

    const cleaned = token.replace(/^[`(]+/, '').replace(/[`),;]+$/, '');
    if (cleaned) out.push(cleaned);
  }

  if (permissive) out.push(...interpreterLiterals(command));

  return out;
}

/**
 * Filename literals inside interpreter code: `python3 -c "open('.env').read()"`.
 *
 * The tokenizer strips quotes, so the filename would otherwise vanish into one
 * unmatched blob. Secret-guardrail use only.
 */
const INTERPRETER = /^(python3?|node|ruby|perl|php|deno|bun)\b.*\s-(c|e)(\s|$)/;

function interpreterLiterals(command) {
  if (!INTERPRETER.test(stripPrefix(command))) return [];
  const out = [];
  for (const m of command.matchAll(/(['"])([^'"\s]{2,200})\1/g)) {
    if (/[./]/.test(m[2])) out.push(m[2]);
  }
  return out;
}
