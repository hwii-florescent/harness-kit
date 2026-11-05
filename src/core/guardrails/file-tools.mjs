// Require native edit/write tools for non-scratch file modifications.
// ponytail: shell/source heuristics, not a sandbox. Hidden script writes/eval can
// bypass this; unresolved paths and complex shell control flow stay conservative.
// Upgrade to a shell AST if the remaining syntax limits become frequent.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { KIND } from "../normalize.mjs";
import { splitCompound, stripPrefix, unwrapShellExecutor } from "../bash.mjs";

export const BLOCK_REASON =
	"harness-kit: blocked shell-based file modification. Use the native read tool first, " +
	"then edit/write/apply_patch as appropriate. Build/test execution and literal .log output " +
	"in the working directory or logs/ are allowed; other non-scratch shell writes " +
	"and unresolved destinations are not. " +
	"With the user's authorization, guardrails.fileTools.enabled can be set to false " +
	"in .harness-kit.local.json; restore it after the exception.";

const blockedWrite = (operation, target) => BLOCK_REASON + "\nTrigger: " + operation +
	(target ? ` to ${JSON.stringify(target.slice(0, 160))}.` : " (destination not proven scratch).");

function maskQuotes(text) {
	const quoted = [];
	const masked = text.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, (match) => {
		quoted.push(match.slice(1, -1));
		return `\u0001${quoted.length - 1}\u0001`;
	});
	return { masked, quoted };
}
const restore = (token, quoted) =>
	token.replace(/\u0001(\d+)\u0001/g, (_m, i) => quoted[Number(i)] ?? "");

// Resolve existing ancestors too: /tmp/link-to-workspace/file is not scratch.
function realDestination(target) {
	const suffix = [];
	let parent = target;
	while (!fs.existsSync(parent)) {
		// A dangling symlink is unknown, not an absent ordinary directory.
		try { if (fs.lstatSync(parent).isSymbolicLink()) throw new Error("dangling symlink"); }
		catch (error) { if (error.code !== "ENOENT") throw error; }
		suffix.unshift(path.basename(parent));
		const next = path.dirname(parent);
		if (next === parent) throw new Error("no existing ancestor");
		parent = next;
	}
	return path.join(fs.realpathSync.native(parent), ...suffix);
}

function isScratch(target, cwd) {
	if (target === "-") return true;
	if (target === "$TMPDIR" || target.startsWith("$TMPDIR/") || target.startsWith("${TMPDIR}")) {
		target = target.replace(/^\$(?:TMPDIR|\{TMPDIR\})/, process.env.TMPDIR || os.tmpdir());
	}
	if (!target || /[$`*?{}\\]/.test(target) || (!path.isAbsolute(target) && !cwd)) return false;
	try {
		const resolved = realDestination(path.isAbsolute(target) ? target : `${cwd}/${target}`);
		return ["/dev", "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"]
			.some((root) => resolved.startsWith(root + "/"));
	} catch { return false; }
}

// ponytail: explicit build/test heads and direct tee pipes only; wrappers and
// arbitrary script names use scratch logs instead. Expand from dogfood examples.
const BUILD_TEST = /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|test|check|typecheck|lint)(?::[\w.-]+)?|(?:(?:npx|pnpx|bunx)\s+(?:--no-install\s+)?)?(?:vitest|jest|tsc|pytest)|(?:cargo|go|swift)\s+(?:build|test|check|clippy)|node\s+--test)(?=\s|$)/;

function isBuildLog(target, cwd) {
	if (!cwd || !target || /[$`*?{}\\]/.test(target)) return false;
	try {
		const base = realDestination(cwd);
		const dest = realDestination(path.isAbsolute(target) ? target : `${cwd}/${target}`);
		return /^(?:logs\/)?[\w-][\w.-]*\.log$/.test(path.relative(base, dest));
	} catch { return false; }
}

// Only exempt write calls with a literal scratch destination. Unknown receiver
// writes (f.write, variable paths, etc.) still require the builtin file tools.
function sourceWritesWorkspace(source, cwd) {
	const { masked, quoted } = maskQuotes(source);
	const literal = String.raw`\u0001\d+\u0001`;
	const targetCalls = new RegExp(
		String.raw`\bopen\s*\(\s*(${literal})\s*,\s*(?:mode\s*=\s*)?(${literal})\s*\)(?:\s*\.\s*(?:write|writelines)\s*\()?` +
		"|" + String.raw`\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream)\s*\(\s*(${literal})` +
		"|" + String.raw`\b(?:pathlib\.)?Path\s*\(\s*(${literal})\s*\)\s*\.\s*(?:write_text|write_bytes)\s*\(`,
		"g",
	);
	let unsafe = false;
	const remaining = masked.replace(targetCalls, (_match, pythonPath, mode, nodePath, pathlibPath) => {
		if (pythonPath && !/[wax+]/.test(restore(mode, quoted))) return " ";
		if (!isScratch(restore(pythonPath || nodePath || pathlibPath, quoted), cwd)) unsafe = true;
		return " ";
	}).replace(/\b(?:sys|process)\.(?:stdout|stderr)\.write\s*\(/g, " ");
	return unsafe || /\.\s*(?:write|writelines)\s*\(|\b(?:write_text|write_bytes|writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream)\b/.test(remaining)
		|| [...remaining.matchAll(/\bopen\s*\((?:[^()\n]|\([^()\n]*\))*?,\s*(?:mode\s*=\s*)?(\u0001\d+\u0001)/g)]
			.some((match) => /[wax+]/.test(restore(match[1], quoted)));
}

export function classifyBashCommand(command, cwd = process.cwd()) {
	if (typeof command !== "string") return null;
	command = unwrapShellExecutor(command);
	// Associate each heredoc with its own header, not every interpreter nearby.
	const bodies = [];
	const lines = command.split("\n");
	const shell = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const start = /<<(?!<)-?\s*(['"]?)([A-Za-z_]\w*)\1/.exec(line);
		if (!start) { shell.push(line); continue; }
		const body = [];
		while (++i < lines.length && lines[i].trim() !== start[2]) body.push(lines[i]);
		shell.push(line.replace(start[0], `<<HEREDOC${bodies.length}`));
		bodies.push(body.join("\n"));
	}
	const { masked, quoted } = maskQuotes(shell.filter((line) => !line.trimStart().startsWith("#")).join("\n"));
	let directory = cwd;
	// Quotes and heredoc bodies are already masked, so their separators are data.
	const parts = splitCompound(masked.replace(/(^|\s)#[^\n]*/g, "$1"), { keepOperators: true });
	for (let i = 0; i < parts.length; i++) {
		const sub = stripPrefix(parts[i]);
		if (/^(?:&&|\|\||[;|\n])$/.test(sub)) continue;
		// Do not carry a guessed cwd through groups, substitutions or control flow.
		if (/[(){}]|^(?:if|then|else|fi|for|while|do|done)\b/.test(sub)) directory = null;
		const cd = /^cd\s+(?:--\s+)?([^\s]+)$/.exec(sub);
		if (cd) {
			const dest = restore(cd[1], quoted);
			try {
				let candidate = null;
				if (!/[$`]/.test(dest) && (directory || path.isAbsolute(dest))) {
					candidate = realDestination(path.isAbsolute(dest) ? dest : `${directory}/${dest}`);
				}
				directory = candidate && fs.statSync(candidate).isDirectory() ? candidate : null;
			} catch { directory = null; }
			continue;
		}
		const words = sub.split(/\s+/).map((word) => restore(word, quoted));
		if (words[0] === "sudo") words.shift();
		const head = path.basename(words[0] || "");
		const buildTest = BUILD_TEST.test(sub);
		for (const match of sub.matchAll(/(?<![>=\-<])(>>|>\||>)(?!&)\s*([^\s;&|<>()]+)/g)) {
			const target = restore(match[2], quoted);
			if (!isScratch(target, directory) && !(buildTest && isBuildLog(target, directory))) {
				return blockedWrite(`${head} redirect ${match[1]}`, target);
			}
		}
		const inPlace = ['sed', 'perl', 'ruby'].includes(head) && words.some((word) => /^-[a-zA-Z]*i|^--in-place/.test(word));
		if (head === "tee" || head === "truncate") {
			const operands = sub.replace(/\d*(?:>>|>\||>)(?:&[\d-]+|\s*[^\s;&|<>()]+)/g, " ")
				.split(/\s+/).map((word) => restore(word, quoted));
			if (operands[0] === "sudo") operands.shift();
			const files = operands.slice(1).filter((word, i, rest) => word && !word.startsWith("-") &&
				!(head === "truncate" && ["-s", "--size", "-r", "--reference"].includes(rest[i - 1])));
			const testPipe = head === "tee" && parts[i - 1] === "|" && BUILD_TEST.test(stripPrefix(parts[i - 2] ?? ""));
			const target = files.find((file) => !isScratch(file, directory) && !(testPipe && isBuildLog(file, directory)));
			if (target) return blockedWrite(`${head} output`, target);
		}
		if (head === "dd") {
			const output = words.slice(1).find((word) => word.startsWith("of=") && !isScratch(word.slice(3), directory));
			if (output) return blockedWrite("dd of=", output.slice(3));
		}
		if (inPlace) {
			const files = [];
			let script = head === "sed";
			for (let i = 1; i < words.length; i++) {
				const word = words[i];
				if (["-e", "-f", "--expression", "--file"].includes(word)) { i++; script = false; continue; }
				if (word.startsWith("-")) { if (word === "-i" && words[i + 1] === "") i++; continue; }
				if (script) { script = false; continue; }
				files.push(word);
			}
			const target = files.find((file) => !isScratch(file, directory));
			if (!files.length || target) return blockedWrite(`${head} in-place edit`, target);
		}
		if (/^(?:python[0-9.]*|node|ruby|perl|deno|bun)$/.test(head)) {
			const heredoc = /<<HEREDOC(\d+)/.exec(sub);
			const inline = /(?:^|\s)(?:-[a-zA-Z]*[cepE]|--eval|--command)\s+(\u0001\d+\u0001)/.exec(sub);
			const hereString = /<<<\s*(\u0001\d+\u0001)/.exec(sub);
			let source = null;
			if (heredoc) source = bodies[Number(heredoc[1])];
			else if (inline) source = restore(inline[1], quoted);
			else if (hereString) source = restore(hereString[1], quoted);
			if (source !== null && sourceWritesWorkspace(source, directory)) return blockedWrite(`${head} inline/heredoc write API`);
		}
	}
	return null;
}

export function check(call, config) {
	if (config?.guardrails?.fileTools?.enabled === false || call.kind !== KIND.SHELL) return null;
	const reason = classifyBashCommand(call.command, call.cwd);
	if (!reason) return null;
	return { blocked: true, guardrail: "fileTools", rule: "shell-write", target: "shell command", reason };
}
