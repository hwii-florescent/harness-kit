// Require native read -> edit/write tools for direct, non-scratch file access.
// ponytail: shell/source heuristics, not a sandbox. Hidden script writes/eval can
// bypass this; unresolved paths and complex shell control flow stay conservative.
// Upgrade to a shell AST if the remaining syntax limits become frequent.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { KIND } from "../normalize.mjs";
import { stripPrefix, unwrapShellExecutor } from "../bash.mjs";

export const BLOCK_REASON =
	"harness-kit: blocked shell-based file modification. Use the native read tool first, " +
	"then edit/write/apply_patch as appropriate. Builds and tests are fine; " +
	"literal scratch destinations are exempt, but unresolved write destinations are not. " +
	"With the user's authorization, guardrails.fileTools.enabled can be set to false " +
	"in .harness-kit.local.json; restore it after the exception.";

export const READ_BLOCK_REASON =
	"harness-kit: blocked shell-based file read. Use the native read tool " +
	"(offset/limit for a line window), or read_symbol/read_enclosing for source bodies. " +
	"This makes the first read usable by read-before-edit tools instead of reading the file twice. " +
	"Search (grep/rg), listings, metadata, builds/tests and literal scratch reads are fine.";

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
		|| [...remaining.matchAll(/\bopen\s*\([^\n]*?,\s*(?:mode\s*=\s*)?(\u0001\d+\u0001)/g)]
			.some((match) => /[wax+]/.test(restore(match[1], quoted)));
}

// Keep searches and metadata out: these commands directly display/process files.
const READERS = new Set(['cat', 'bat', 'less', 'more', 'head', 'tail', 'sed', 'awk',
	'nl', 'tac', 'sort', 'uniq', 'cut', 'paste', 'column', 'od', 'xxd', 'strings', 'jq', 'yq']);
const READ_VALUE_FLAGS = {
	head: ['-n', '-c', '--lines', '--bytes'],
	tail: ['-n', '-c', '--lines', '--bytes', '-s', '--sleep-interval', '--pid'],
	awk: ['-F', '-v'], cut: ['-b', '-c', '-d', '-f', '--bytes', '--characters', '--delimiter', '--fields'],
	sort: ['-k', '-t', '-S', '-T', '--key', '--field-separator', '--buffer-size', '--temporary-directory'],
	uniq: ['-f', '-s', '-w'], paste: ['-d', '--delimiters'],
	nl: ['-b', '-d', '-f', '-h', '-i', '-l', '-n', '-s', '-v', '-w'],
	column: ['-c', '-s', '-o'], od: ['-A', '-j', '-N', '-t', '-w'],
	xxd: ['-c', '-g', '-l', '-s'], strings: ['-n', '-t', '-e', '--bytes', '--radix', '--encoding'],
	bat: ['-l', '--language', '--style', '--theme', '--paging', '--line-range', '--tabs', '--terminal-width', '--color'],
};

function readTargets(head, words) {
	const targets = [];
	const patternTool = ['sed', 'awk', 'jq', 'yq'].includes(head);
	let pattern = patternTool;
	let flags = true;
	for (let i = 1; i < words.length; i++) {
		const word = words[i];
		if (flags && word === '--') { flags = false; continue; }
		if (flags && word.startsWith('-') && word !== '-') {
			const flag = word.split('=')[0];
			if (patternTool && ['-f', '--file', '-e', '--expression'].includes(flag)) {
				const value = word.includes('=') ? word.slice(word.indexOf('=') + 1) : words[++i];
				if (['-f', '--file'].includes(flag) && value) targets.push(value);
				pattern = false;
			} else if (['--arg', '--argjson', '--slurpfile', '--rawfile'].includes(flag)) {
				i++; // variable name, then value (a path only for file flags)
				const value = words[++i];
				if (flag.endsWith('file') && value) targets.push(value);
			} else if (READ_VALUE_FLAGS[head]?.includes(flag) && !word.includes('=')) i++;
			continue;
		}
		if (pattern) { pattern = false; continue; }
		if (word && word !== '-') targets.push(word);
	}
	return targets;
}

function sourceReadsWorkspace(source, cwd) {
	const { masked, quoted } = maskQuotes(source);
	const literal = String.raw`\u0001\d+\u0001`;
	const calls = new RegExp(
		String.raw`\bopen\s*\(\s*([^,\n)]+)(?:,\s*(?:mode\s*=\s*)?([^,\n)]+))?` +
		'|' + String.raw`\b(?:readFile(?:Sync)?|createReadStream|readTextFile(?:Sync)?|readBinaryFile(?:Sync)?)\s*\(\s*([^,\n)]+)` +
		'|' + String.raw`\b(?:pathlib\.)?Path\s*\(\s*(${literal})\s*\)\s*\.\s*(?:read_text|read_bytes)\s*\(`,
		'g',
	);
	let unsafe = false;
	const remaining = masked.replace(calls, (_match, pythonPath, mode, nodePath, pathlibPath) => {
		const modeValue = mode && restore(mode.trim(), quoted);
		if (pythonPath && modeValue && /^[wax][bt]?$/.test(modeValue)) return ' ';
		const target = (pythonPath || nodePath || pathlibPath).trim();
		if (target !== '0' && (!new RegExp(`^${literal}$`).test(target) || !isScratch(restore(target, quoted), cwd))) unsafe = true;
		return ' ';
	});
	return unsafe || /\b(?:read_text|read_bytes|readFile(?:Sync)?|createReadStream|readTextFile(?:Sync)?|readBinaryFile(?:Sync)?)\s*\(/.test(remaining);
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
	for (const part of masked.replace(/(^|\s)#[^\n]*/g, "$1").split(/&&|\|\||[;\n]|(?<!>)\|/)) {
		const sub = stripPrefix(part.trim());
		if (!sub) continue;
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
		for (const match of sub.matchAll(/(?<![>=\-<])(?:>>|>\||>)(?!&)\s*([^\s;&|<>()]+)/g)) {
			if (!isScratch(restore(match[1], quoted), directory)) return BLOCK_REASON;
		}
		const words = sub.split(/\s+/).map((word) => restore(word, quoted));
		if (words[0] === "sudo") words.shift();
		const head = path.basename(words[0] || "");
		const inPlace = ['sed', 'perl', 'ruby'].includes(head) && words.some((word) => /^-[a-zA-Z]*i|^--in-place/.test(word));
		if (READERS.has(head) && !inPlace) {
			const inputs = [];
			// Heredocs/here-strings are data; only a single < names an input file.
			const operands = sub.replace(/\d*(<<<|<<|<|>>|>\||>)(?:&[\d-]+|\s*([^\s;&|<>()]+))/g, (_match, op, target) => {
				if (op === '<' && target) inputs.push(restore(target, quoted));
				return ' ';
			}).split(/\s+/).map((word) => restore(word, quoted));
			if (operands[0] === 'sudo') operands.shift();
			if ([...inputs, ...readTargets(head, operands)].some((file) => !isScratch(file, directory))) return READ_BLOCK_REASON;
		}
		if (head === "tee" || head === "truncate") {
			const files = words.slice(1).filter((word, i, rest) => !word.startsWith("-") &&
				!(head === "truncate" && ["-s", "--size", "-r", "--reference"].includes(rest[i - 1])));
			if (files.some((file) => !isScratch(file, directory))) return BLOCK_REASON;
		}
		if (head === "dd" && words.slice(1).some((word) => word.startsWith("of=") && !isScratch(word.slice(3), directory))) {
			return BLOCK_REASON;
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
			if (!files.length || files.some((file) => !isScratch(file, directory))) return BLOCK_REASON;
		}
		if (/^(?:python[0-9.]*|node|ruby|perl|deno|bun)$/.test(head)) {
			const heredoc = /<<HEREDOC(\d+)/.exec(sub);
			const inline = /(?:^|\s)(?:-[a-zA-Z]*[cepE]|--eval|--command)\s+(\u0001\d+\u0001)/.exec(sub);
			const hereString = /<<<\s*(\u0001\d+\u0001)/.exec(sub);
			let source = null;
			if (heredoc) source = bodies[Number(heredoc[1])];
			else if (inline) source = restore(inline[1], quoted);
			else if (hereString) source = restore(hereString[1], quoted);
			if (source !== null && sourceWritesWorkspace(source, directory)) return BLOCK_REASON;
			if (source !== null && sourceReadsWorkspace(source, directory)) return READ_BLOCK_REASON;
		}
	}
	return null;
}

export function check(call, config) {
	if (config?.guardrails?.fileTools?.enabled === false || call.kind !== KIND.SHELL) return null;
	const reason = classifyBashCommand(call.command, call.cwd);
	if (!reason) return null;
	const rule = reason === READ_BLOCK_REASON ? "shell-read" : "shell-write";
	return { blocked: true, guardrail: "fileTools", rule, target: "shell command", reason };
}
