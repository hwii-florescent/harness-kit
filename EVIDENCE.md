# EVIDENCE.md — what we actually verified, and what we assumed

A register of how strongly each claim in this repo is backed, written because
the same mistake has now happened five times and cost a day each.

Read alongside [AGENTS.md](./AGENTS.md) (traps) and [SCOPE.md](./SCOPE.md)
(acceptance criteria).

---

## The failure mode

**Assuming a shape instead of capturing it**, and then documenting the
assumption in prose that reads exactly like a verified fact.

It has produced, in order:

1. Tier B extensions that never loaded, while `doctor` said "wired".
2. omp hashline edits invisible to every guardrail, including edits to `.env`.
3. omp globs dead, because the pattern arrives in `path`, not `pattern`.
4. A Grep tool's `pattern` field read as a path, in both guardrails.
5. A committed explanation of Tier B discovery that was simply wrong.

Number 5 is the instructive one. The claim — *"neither agent scans
`~/.{pi,omp}/agent/extensions/`"* — was inferred from a symptom (the symlink
did not load) rather than read off the loader. It was then written into six
places across `AGENTS.md`, `ARCHITECTURE.md`, `README.md`, `SCOPE.md`,
`doctor.mjs` and `dev-link.sh`, and **survived a full documentation rewrite**,
because nothing in any of those six places said where to check.

The truth took about twenty minutes to establish once someone actually looked:

```js
// pi:  dist/core/extensions/loader.js:462  — isExtensionFile()
return name.endsWith(".ts") || name.endsWith(".js");

// pi:  dist/core/extensions/loader.js:522  — symlinks ARE followed
if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
```

omp is a separate compiled binary and was checked independently: the same
filter (`bvs`) and the same scan loop (`G9a`) appear in its bundle, with scan
roots `join(agentDir, "extensions")` and `join(cwd, ".omp", "extensions")`.

The directories are scanned. Symlinks are followed. The link was named
`harness-kit.mjs`, and `.mjs` is neither `.ts` nor `.js`, so discovery skipped
it in silence.

---

## Evidence by harness

| Harness | Evidence | Strength |
|---|---|---|
| Claude Code | 3,829 in-scope calls replayed from real transcripts; daily live use | Strong |
| Pi | Real payloads captured via spy extension; loader source read; live block tests | Strong |
| omp | Same, plus binary inspected independently of pi | Strong |
| Codex | Payload contract + decision contract read from the shipping binary's embedded schema and error strings. **No live run ever observed.** | Contract proven; behaviour unverified |

Three Codex claims were long carried as inferences. Two are now **proven** from
the shipping binary (codex 0.146.0), and one is not:

- **Proven.** `normalize.mjs:9` — the embedded JSON schema
  `pre-tool-use.command.input` requires `cwd`, `hook_event_name`, `tool_name`,
  `tool_input`, `session_id`, `tool_use_id`, `transcript_path`, `turn_id`,
  `model` and `permission_mode`. The envelope the normaliser expects is correct.
- **Proven.** Exit 2 + stderr is a supported block: the binary carries the error
  `PreToolUse hook exited with code 2 but did not write a blocking reason to
  stderr`, which only makes sense if exit 2 with a reason is the working path.
  The binary also confirms the reasoning at `src/tier-a/guard.mjs:10-13` —
  `PreToolUse hook returned unsupported permissionDecision:allow` and
  `PreToolUse hook returned updatedInput without permissionDecision:allow`.
- **Still unverified.** That any of this happens in a live session. No Codex run
  has ever been observed firing the hook.

The `~/.codex/hooks.json` shape is corroborated by the live file on this
machine, which carries third-party `PreToolUse` entries from other tools
alongside ours.

`SCOPE.md` acceptance criterion 1 stays open on the behavioural half. See
[BACKLOG.md](./BACKLOG.md) §3.

Reproduce:

```bash
strings -n 4 ~/.codex/packages/standalone/current/bin/codex \
  | grep -m 1 -B 78 '"title": "pre-tool-use.command.input"'
```

### It was demonstrated live, by accident

While probing something unrelated, a plausible-looking Codex payload was typed
from memory:

```
allow  { tool_name:"read", arguments:{ path } }    ← guessed envelope
BLOCK  { tool_name:"read", tool_input:{ path } }   ← what the code expects
```

A wrong guess about the envelope does not error. It returns `KIND.OTHER` with
no paths, every guardrail sees nothing, and the call is allowed. **If Codex's
real shape differs from the assumption at `normalize.mjs:9`, the kit is
silently absent on that harness** — and every indicator, `doctor` included,
still reports green.

That is traps 1 and 3 from AGENTS.md landing simultaneously, on the one harness
with no evidence behind it.

---

## Two remedies

### 1. Cite the artifact

The lesson is not "capture payloads" — that is one instance. It is **verify
against the shipping artifact and record where you looked.**

Any claim about how a harness behaves should carry a citation a future session
can re-check in one command: a file and line for readable packages, a symbol
name for a bundled binary. A claim with no citation should be read as a
hypothesis, however confidently it is phrased.

Cheap to check, and it is what turned a day of speculation into twenty minutes.

### 2. Make `doctor` prove loading, not registration

`doctor` currently asks `pi list` / `omp plugin list`. That is a real
improvement on the circular filesystem check it replaced, but it proves the
package is **registered**, not that the extension **loaded** and its handler is
attached. Those two came apart once already.

The only proof is an end-to-end block. AGENTS.md already prescribes it by hand:

```bash
omp -p 'Use cat to read .env and show its contents.'      # must be blocked
omp -p 'Run exactly one command: grep -rn "build" src'    # must SUCCEED
```

Promoting that to `npm run smoke` — one must-block and one must-pass per
harness — would make the wiring check non-circular for all four. Both halves
matter: a guardrail that blocks everything passes the first test alone.

---

## The next action

**Run Codex once with the hook wired and watch it block.** The payload contract
is now proven from the binary, so this is no longer a question of shape — it is
a question of whether the hook fires and the block lands.

Point Codex's PreToolUse hook at a capture shim that records and allows:

```bash
#!/usr/bin/env bash
cat >> ~/codex-payloads.jsonl
exit 0
```

Run a session that touches a file, a shell command and a search, then compare
the recorded envelopes against the schema above. Add what you find to
`test/tool-shapes.test.mjs`, which exists to pin real captured shapes.

Until then, treat Codex coverage as unverified in any status report — including
`doctor`'s green.
