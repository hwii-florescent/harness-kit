# EVIDENCE.md — what we actually verified, and what we assumed

A register of how strongly each claim in this repo is backed, written because
the same mistake has now happened five times and cost a day each.

Read alongside [AGENTS.md](./AGENTS.md) (traps) and [SCOPE.md](./SCOPE.md)
(acceptance criteria).

---

## Current verification — 2026-11-05

This update supersedes earlier shell-read enforcement, replay and live-smoke
snapshots. No guardrail configuration or adapter wiring was changed.

- Routine shell/interpreter reads now pass `fileTools`; native reads are guidance
  before editing, not a hard block. Source writes still require native tools.
  Recognized build/test commands may redirect output or pipe directly to `tee`
  into literal non-dot `.log` filenames in the working directory or `logs/`.
  Resolved symlink escapes, unknown destinations and unrelated commands remain
  blocked. Scratch-glob reads and count-only grep/rg stdin pipelines pass.
- `npm test`: **491 passing**, with shared four-dialect checks for reads/logs,
  unsafe destinations, scratch symlinks, neighboring commands and trigger reasons.
  Python write-mode detection no longer confuses later read-only expressions
  with an `open` mode; nested write destinations remain covered.
- Paired replay: the same **9,470 in-scope records / 166 transcripts** went from
  **585 blocks (6.18%)** with HEAD `e93257f` to **118 (1.25%)** with the updated
  core: **115 fileTools / 3 heavyPath**, or **467 fewer interventions**.
  Both cores received each payload during one transcript pass. The remaining
  verbose blocks were reviewed: source edits, unresolved scratch variables,
  missing historical directories, unsupported script log destinations and
  unbounded `out` listings. This is not a measured false-positive rate and is
  still above the Phase 0 replay gate. MultiEdit/NotebookEdit/Glob/Grep remain
  absent; the replay parser covers Claude-shaped history, not Pi/omp sessions.
- `npm run smoke -- --file-tools --heavy-bounds claude codex pi omp`:
  **all four passed** on Claude **2.1.318**, Codex **0.166.0**, Pi **1.4.0** and
  omp **18.16.0**, with pinned Haiku/Luna models and existing cost limits.
  Actual tool output proves ordinary reads, scratch glob reads, bounded listings,
  metadata and count summaries. Filesystem effects prove both Node test-log
  redirects/direct tee writes and scratch writes; source writes remain absent.
  Secret/heavy-path/source-write hook errors are still required, and the fake
  credential must not appear in output. The first expanded run passed all four:
  `$HOME/hk-live-smoke-D9l0mK/`. After the final nested-Python-mode regressions,
  Claude/Codex/Pi passed again in `$HOME/hk-live-smoke-YNPhfU/`; omp correctly
  failed because its tee call mistyped cwd (`YNPhf4U` instead of `YNPhfU`),
  leaving no log. This was not a hook rejection or a successful check. An
  unchanged-model rerun passed every omp check: `$HOME/hk-live-smoke-KEsCvJ/`.
- `npm run doctor`: **4 installed / 4 wired** (registration only); the single
  September crash breadcrumb is unchanged. Active diagnostics found no new
  errors; the existing Semgrep dynamic-RegExp warning at `heavy-path.mjs:30`
  remains. `git diff --check` and JavaScript syntax checks passed.
- Existing Pi/omp sessions need `/reload` to replace cached extension modules.
  No automatic approval dialogs or approval tokens were introduced.

## Prior verification — 2026-11-02

This dated update supersedes the historical approval and Codex-live claims below.

- `npm test`: **360 passing**, including 63 additional bounded-output/metadata regressions. Shared file-tools cases exercise Claude, Codex,
  Pi and omp payload dialects, effective shell cwd, scratch/mixed destinations,
  symlink/traversal escapes, interpreter/heredoc scoping and live configuration.
  Adapter tests explicitly prohibit automatic approval dialogs, including when
  Pi/omp report UI availability and Claude reports default permission mode.
- `npm run smoke -- --file-tools codex pi omp`: Codex **0.166.0** and omp
  **18.15.0** passed on pinned cheap Luna models. Pi's first run was correctly
  rejected as shared-rule evidence because the standalone extension intercepted
  the file write first. Raw traces: `$HOME/hk-live-smoke-wBs8q5/`.
- After archiving the standalone Pi extension/test with rollback on failure,
  `npm run smoke -- --file-tools pi` passed on Pi **1.4.0** using only the shared
  rule. Trace: `$HOME/hk-live-smoke-3BiWiO/pi.json`. Archived files:
  `~/.harness-kit-backups/20261102164828-file-tools-merge/`.
- `npm run smoke -- --file-tools claude`: Claude **2.1.316** passed after the
  16:50 EST account reset on **claude-haiku-4-5-20251001**, low effort, **$0.15**
  cap. Trace: `$HOME/hk-live-smoke-1kzCnF/claude.json`. The earlier HTTP 429 /
  five-hour-limit failure happened before tools and was not a successful block.
- All four successes require actual source-search output, secret/heavy-path hook
  errors, the shared file-tools hook error, no workspace file created and a
  successful scratch-file write. `scripts/smoke.mjs` checks tool/router output
  and filesystem effects, not the model's summary. No extension shim, hook-trust
  bypass or expensive model fallback was used. Codex's file-write check uses its
  ordinary workspace-write sandbox; the base smoke retains read-only mode.
- Bounded-read cleanup: `npm run smoke -- --heavy-bounds --file-tools claude codex pi omp`
  passed on **all four** with the same pinned Haiku/Luna settings. In addition to
  the five original checks, actual tool output proves `ls -ld node_modules`,
  `ls node_modules | head -20`, and a parent-relative dependency manifest read
  succeed. Raw traces: `$HOME/hk-live-smoke-qrlAxJ/`. GUI launchers were classified
  in unit tests only; no generated app was launched during live smoke.
- `node scripts/doctor.mjs`: **4 installed / 4 wired** (registration only).
  The single September regex crash breadcrumb is unchanged.
- The earlier file-tools LSP probe had six files confirmed clean and four
  inconclusive. The bounded-read cleanup's final four-file probe confirms three
  clean; the fourth has an existing Semgrep warning on dynamic glob RegExp
  construction (`heavy-path.mjs:30`, unchanged). No new errors were reported.
  `git diff --check` and JavaScript syntax checks passed.
- Replay: **420 / 6,872 (6.11%)** would block, versus **19 / 6,872 (0.28%)**
  before the file-tools merge. The extra **401** are the expanded shell-write
  policy, including conservative unresolved scratch destinations and workspace
  log redirects. The subsequent bounded-read cleanup yields **407 / 6,872
  (5.92%)**, **5 heavyPath / 402 fileTools**. Of the former 19 heavy-path matches,
  13 now pass and one reaches an existing unresolved-write file-tools block.
  The five remaining heavy-path matches have no proven output bound (plain,
  wildcard or filtered listings, and a recursive diff). The file-tools and
  secret rule implementations were not changed by this cleanup. This is not a
  measured false-positive rate; missing historical directories and repeated
  records also limit the corpus. Glob/Grep/MultiEdit/NotebookEdit remain absent.

Current policy: all adapters hard-block without automatic dialogs. Agents should
use the suggested alternative, asking the user only for a necessary configuration
exception. Configuration changes need explicit user authorization and restoration
afterward; conversational approval is not a bypass or a one-use token. The shared
file-tools classifier is a heuristic, not a sandbox. Existing Pi/omp sessions need
`/reload`; the standalone Pi extension must not remain in auto-discovery.

## Historical snapshots (superseded where noted above)

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
| Claude Code | Daily live use; replay corpus: 4,248 calls, 3,993 in scope, 34 blocked (0.85%) | Strong |
| Pi | Real payloads captured via spy extension; loader source read; live block tests | Strong |
| omp | Same, plus binary inspected independently of pi | Strong |
| Codex | Payload contract + decision contract read from the shipping binary's embedded schema and error strings. **No live run ever observed.** | Contract proven; behaviour unverified |

### Adapter approval evidence

The approval contract is intentionally different at the adapter boundary while
the core verdict remains shared:

- **Claude Code 2.1.260:** the Tier A tests assert the exact
  `PreToolUse` `hookSpecificOutput.permissionDecision:"ask"` response for
  interactive/default mode, and exit 2 with stderr for `dontAsk` and
  `bypassPermissions`. This implementation does not register
  `PermissionRequest`.
- **Pi 0.84.2 and omp 18.1.10:** the shared Tier B tests await an async
  `tool_call` handler, assert one literal-`true` `ctx.ui.confirm()` approval,
  and assert that a non-`true` result or no UI keeps the original
  `{block:true,reason}`. A confirmation exception fails open and is logged.
- **Codex 0.146.0:** the Tier A tests keep exit 2 plus stderr and empty stdout.
  No `ask` response is emitted because the installed runtime rejects it.

These focused tests exercise the captured adapter surfaces. They do not
substitute for an end-to-end run of each installed harness; the live Codex
acceptance item remains open.

---

## Configuration reload evidence

`test/config.test.mjs` drives repeated `checkTool()` calls in one process while
creating, rewriting, and deleting project configuration. The next call observes
each change, including malformed layers falling back to protective defaults.
This covers the long-lived Pi/omp process case without touching the developer's
global configuration.

---

## Wiring evidence

Tier A wiring tests use temporary `HOME` files and fake harness executables.
They verify canonical nested commands, legacy migration, duplicate removal,
unrelated-handler preservation, invalid-JSON immutability, dry-run behavior,
backup creation, and idempotent reruns. `doctor` can prove this structural
registration; only a live block/pass smoke can prove that an extension or hook
actually loaded.

---

## Codex contract boundary

The Codex envelope and decision contract are proven from the installed binary,
but hook execution in a live Codex session is not.

---

<!-- The detailed Codex schema evidence below is retained for reproducibility. -->

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
[BACKLOG.md](./BACKLOG.md) §2.

Reproduce:

```bash
strings -n 4 ~/.codex/packages/standalone/current/bin/codex \
  | grep -m 1 -B 78 '"title": "pre-tool-use.command.input"'
```

### A synthetic probe also showed the failure mode

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

### 2. Keep `doctor` separate from loading

`doctor` proves canonical Tier A wiring and Tier B package registration. It does
not prove that the extension loaded or that the handler is attached. Those two
came apart once already.

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
