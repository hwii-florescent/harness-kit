# AGENTS.md — read this first

Orientation for a session picking this repo up cold. Portable across Claude Code,
Codex, Pi and omp (Claude Code also reads `CLAUDE.md`, which points here).

For design rationale see [ARCHITECTURE.md](./ARCHITECTURE.md); for phasing and
what "done" means see [SCOPE.md](./SCOPE.md).
For how strongly each claim here is actually backed — and which harness is
still running on assumption — see [EVIDENCE.md](./EVIDENCE.md).
For open problems not yet started — Codex approval and live verification, plus
the shell-variable limit — see [BACKLOG.md](./BACKLOG.md).

---

## What this is

One guardrail core running unmodified on four coding agents. Three guardrails
(`secret`, `heavyPath`, `broadGlob`) intercept tool calls before they execute.

**Status: Phase 0.** Built, wired locally on the author's machine, not published.
The remaining Phase 0 work is a two-week dogfood, not code.

```bash
npm test        # 260 tests, zero dependencies
npm run replay  # false-positive rate against real agent history
npm run doctor  # which harnesses are installed / wired
```

---

## The kit is probably hooked into your own session

If you are working in this repo on a wired machine, your own tool calls go
through `src/tier-a/guard.mjs`. This is intended — it is the dogfood — but it
has practical consequences:

- A command containing `.env`, `id_rsa`, `*.pem` etc. is blocked **even when you
  are only writing test data**. `printf 'K=1' > .env` gets blocked.
- Listing a `node_modules` root is blocked. Use a bounded read instead:
  `grep -c x path/to/file` or `ls path/to/specific/file`.
- Heredoc bodies are stripped before analysis, so `python3 - <<'PY' … PY` and
  `cat > f <<'EOF' … EOF` pass. Putting test fixtures in a heredoc-written file
  is the clean way around the first problem.
- The persistent escape hatch is effective on the next tool call with no
  restart. Use `allow` for `secret`/`heavyPath`, or `enabled:false` for
  `broadGlob`.

  ```bash
  echo '{"guardrails":{"secret":{"enabled":false}}}' > ~/.harness-kit.json
  ```

  Remove the file when done — a disabled guardrail that nobody notices is the
  failure this whole kit exists to avoid. Interactive Claude, Pi, and omp
  approvals are exact-call and one-use; they are not persisted. Codex and
  no-UI runs remain blocked.

Fail-open covers crashes, not correct-but-wrong blocks. If a block is wrong,
that is a bug worth fixing, not working around.

---

## Invariants — do not break these

1. **`src/core/` imports nothing harness-specific.** No `process.exit`, no
   stdout, no harness types. Adapters translate; the core decides.
2. **Adapters do not normalise.** They pass the raw payload through;
   `normalize.mjs` owns every dialect. Normalisation in two places drifts, and
   the drift is silent.
3. **Adapter translations are explicit.** Claude's interactive/default
   `PreToolUse` block returns `permissionDecision:"ask"`; Claude
   `dontAsk`/`bypassPermissions` and Codex return exit 2 + stderr; Pi and omp
   return `{block:true,reason}` after a non-`true` result or without UI, while
   confirmation exceptions fail open. Never send `permissionDecision:"ask"` to
   Codex.
4. **Everything fails open.** Any internal error allows the call and appends to
   `<kit>/.local/crash.jsonl`.
5. **`secret` and `heavyPath` use different extraction on purpose.** Do not
   unify them:
   - `secret` — permissive, all commands. Copying a `.env` is exfiltration even
     though it prints nothing.
   - `heavyPath` — role-aware, unbounded reads only. It is context economy, not
     access control. `rm -rf dist` costs nothing.
6. **Context injection must not name the guardrails.** See trap 2 below.

---

## Traps that already cost a day each

These all *looked* correct and all reported success while being wrong. Four of
the six were the same root mistake: assuming a shape instead of capturing it.

**1. Auto-discovery is real, but it only accepts `.ts` and `.js`.**
Both agents *do* scan `~/.pi/agent/extensions/` and `~/.omp/agent/extensions/`
(and project-local `.pi/extensions/`, `.omp/extensions/`), and both explicitly
follow symlinks. The filter is the whole story:

```js
// pi: dist/core/extensions/loader.js — isExtensionFile()
return name.endsWith(".ts") || name.endsWith(".js");   // omp: byte-identical
```

An earlier `dev-link.sh` linked `~/.pi/agent/extensions/harness-kit.mjs`.
`.mjs` is not `.ts` or `.js`, so the scan skipped it in silence — no error, no
warning. The symlink was never the problem; the extension was.

Directory entries take a second route: a subdirectory (symlink included) is read
for `package.json` with a `pi`/`omp` manifest key, else `index.ts`/`index.js`.
The manifest route only `stat`s the declared path, so **`.mjs` is fine there** —
which is why `pi install` / `omp install` works with our `./src/tier-b/*.mjs`
entry points. Prefer install anyway: it registers in settings, supports
`/reload` and enable/disable, and gives `doctor` something authoritative to ask.

The `doctor` half of this trap stands: the old one looked for the symlink it had
just created and reported "wired" while nothing had loaded. It now checks the
canonical Tier A command and asks `pi list` / `omp plugin list` for Tier B
registration. A live block/pass smoke is still the proof that a handler loaded.

**2. Naming the guardrails in injected context causes silent refusals.**
`context.mjs` once said *"Guardrails active: secret, heavyPath, broadGlob"*.
Agents then simulated the rules rather than relying on them — asked to run
`grep -rn "build" src`, omp saw `build`, decided heavy-path would object, and
refused. Nothing had blocked it. No hook fired, nothing was logged, the work
just did not happen. Say a hook exists; tell the agent **not to anticipate it**.

**3. An unrecognised tool is a hole, not a safe default.**
It becomes `KIND.OTHER` with no paths, every guardrail sees nothing, and it
passes. omp's hashline editor sends the whole patch as one `input` string with
the target inside it — every omp edit was invisible, including edits to `.env`.
**Capture payloads before trusting a harness:**

```js
// load with `omp -e spy.mjs` / `pi -e spy.mjs`
export default function (pi) {
  pi.on('tool_call', (e) => console.error(e.toolName, Object.keys(e.input ?? {})));
}
```

**4. A word is not a path because of how it is spelled.**
Every `heavyPath` blocklist entry — `build`, `dist`, `out`, `target` — is also an
ordinary word and a common search term. `grep -rn "build" src` searches for a
word; `grep -vE "node_modules|dist/"` *excludes* those directories. Treating all
operands as paths blocked 1 in 25 real calls. The same bug then survived
separately in the structured-tool path, where a Grep tool's `pattern` field was
read as a path.

**5. A clean replay rate can mean the corpus never exercised that path.**
`replay.mjs` prints which in-scope tools a corpus never hit. Read that line.

---

## Verifying a change

Run all of these after touching `bash.mjs` or any guardrail. Unit tests alone
have missed every serious defect found so far.

```bash
npm test                        # 260 tests
npm run replay -- --verbose     # rate + the actual remaining blocks
node scripts/doctor.mjs         # wiring honest?
```

Then exercise a real agent — this is the step that catches silent absence:

```bash
cd <a scratch dir with a .env and a src/>
omp -p 'Use cat to read .env and show its contents.'      # must be blocked
omp -p 'Run exactly one command: grep -rn "build" src'    # must SUCCEED
```

Both halves matter. A guardrail that blocks everything passes the first test.

**Read the remaining replay blocks, do not just watch the number.** Each should
be one you would defend: `cat .npmrc`, `ls node_modules`, `find dist -type f`.

---

## Where things live

```
src/core/index.mjs         checkTool() — the single entry point
src/core/normalize.mjs     four payload dialects → one shape; patch-body parsing
src/core/bash.mjs          shell analysis — largest file, most of the difficulty
src/core/guardrails/       secret · heavy-path · broad-glob
src/tier-a/guard.mjs       Claude Code + Codex (mode-aware stdin → output/exit 0|2)
src/tier-b/shared.mjs      Pi + omp (pi.mjs / omp.mjs are thin re-exports)
test/tool-shapes.test.mjs  real captured payloads per harness
test/extraction.test.mjs   regressions found by replaying real history
scripts/replay.mjs         the false-positive measurement
scripts/dev-link.sh        wire all four; dry-run unless --apply
```

Adding a guardrail: write `src/core/guardrails/<name>.mjs` exporting
`check(call, config)`, add it to `GUARDRAILS` in `index.mjs` ordered by severity,
add defaults to `config.mjs`. No adapter changes — it is live on all four
immediately.

---

## What's next

Phase 0's remaining work, in order:

1. **Verify Codex live.** It is the one harness whose payloads have only ever
   been synthetic here. Acceptance criterion 1 in SCOPE.md is not closed.
2. **Dogfood for two weeks.** Watch for a block you would argue with.
3. **Find a second dogfooder.** The exit criteria require more than one person.

Do not start Phase 1 (publishing) until the SCOPE.md exit criteria are met.

Current numbers, for comparison after a change: 260 tests, replay 34/3,993
in-scope calls (0.85%). A prior red-team run covered 39 vectors; 36 passed and
three deliberate shell-evasion cases remain outside the threat model of a
well-meaning agent.
