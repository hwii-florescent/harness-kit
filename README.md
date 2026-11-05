# harness-kit

One guardrail core, four coding-agent harnesses.

**Phase 0 — local only.** Built and wired locally; nothing is published. The
remaining Phase 0 work is a two-week dogfood, not code.

New here? Start with [AGENTS.md](./AGENTS.md) — invariants and the traps that
have already cost time. Then [SCOPE.md](./SCOPE.md) for phasing and
[ARCHITECTURE.md](./ARCHITECTURE.md) for the design.

```bash
npm test              # hermetic core, adapter and metrics tests
npm run replay        # would-block rate against recorded agent history
npm run doctor        # registration + retained decision counts
npm run smoke -- codex pi omp  # LIVE, billable; cheap Luna models
npm run smoke -- claude        # LIVE, billable; Haiku, $0.15 session cap
npm run smoke -- --file-tools codex pi omp # reads/logs pass; source writes block
npm run smoke -- --heavy-bounds claude codex pi omp # metadata + bounded listings must run
```

## What it does

Four guardrails share one core decision on Claude Code, Codex, Pi and omp:

| Guardrail | Blocks | Why |
|---|---|---|
| `secret` | `.env`, `*.pem`, `id_rsa`, `credentials.json`, … | Stops credentials entering model context |
| `heavyPath` | reads inside `node_modules`, `dist`, `.git`, … | Stops generated files flooding the context window |
| `broadGlob` | `**/*.ts` at the project root | Same, for discovery tools |
| `fileTools` | Common non-scratch shell/interpreter modifications, except narrow build/test logs | Routes source edits to native tools; native reads are guidance, not a hard block |

Each guardrail is configurable and individually disablable. Core failures fail
open; a block can be persistently exempted in configuration. These are path and
command heuristics, not an actual file-size limit.

`heavyPath` allows directory-only metadata (`ls -ld node_modules`), a concrete
dependency `package.json` (including parent-relative paths), and GUI launchers
(`open build/App.app`, `code dist/bundle.js`). Direct pipes into literal
`head`/`tail` limits up to 200 lines or 16 KiB, a `wc` summary, or a count-only
`grep`/`rg` with one pattern and no file operands also pass.
These pipeline exemptions do not apply to secrets. Quoted/commented pipes,
`||`, negative/variable/oversized limits, and stdout redirected around the pipe
are not accepted as bounds; later commands are still checked independently.
Wildcard and recursive listings remain conservative. A named manifest is
treated as metadata without a byte-size check, not as a universal size guarantee.
Routine shell reads are allowed by `fileTools`, including bounded `cat`/`sed`
reads and dependency manifests. Secret and unbounded generated-tree protections
still apply independently.

## How one core serves four harnesses

The harnesses fall into two integration tiers, so there are two adapters, not four:

```
                     src/core/          ← all logic, no harness imports
                    checkTool()
                         │
          ┌──────────────┴──────────────┐
   Tier A: process hook          Tier B: in-process extension
   stdin JSON → adapter output   pi.on('tool_call') → adapter result
   Claude Code · Codex           Pi · omp
```

`checkTool()` returns the same global verdict for every raw payload dialect.
Adapters translate that verdict:

- Claude Code and Codex return exit 2 + stderr for a block.
- Pi and omp return `{block:true, reason}` for a block.

**No automatic approval dialogs**, even in interactive sessions. A block tells
the agent to use the suggested alternative first. Only if that cannot accomplish
the task should it ask the user for an explicit configuration exception. The
agent must not change guardrail settings without authorization; a conversational
"yes" or an `approved` field does not itself bypass the hook. Exceptions are
configuration changes, not exact-call approval tokens: preserve unrelated
settings and restore the previous configuration when finished.

Older design documents describe automatic prompts, not the current policy.
Registration is not proof that a hook loaded: use the live smoke for that claim.

Allowed process calls remain exit 0 with no output. Context injection still uses
the shared JSON `additionalContext` shape.

## Layout

```
src/core/            checkTool, config, normalisation, bash analysis
  guardrails/        secret · heavy-path · broad-glob · file-tools
src/tier-a/guard.mjs Claude Code + Codex
src/tier-b/          shared.mjs + pi.mjs + omp.mjs
test/                core, adapter and telemetry regression checks
scripts/             doctor.mjs · replay.mjs · smoke.mjs · dev-link.sh
```

## Testing approach

`test/payloads.mjs` expresses the same logical call in all four harness dialects.
The core parity suite asserts not only that each verdict is correct but that the
four are **identical to one another** — the kit's central claim.

Tier A is tested by spawning `guard.mjs` and asserting its exit-code contract.
Tier B uses a fake `ExtensionAPI` to check block/pass returns and context
injection. Metrics tests cover data minimization, retention, caps, labels and
failure isolation.

A dedicated false-positive suite protects the Phase 0 replay target:
`git commit -m "fix .env loading"`, `rm -rf dist`, `./node_modules/.bin/eslint
src` and friends must all pass through.

### Replay: the test that unit tests cannot be

`npm run replay` walks recorded agent transcripts and feeds every tool call to
`checkTool()`. The blocked fraction is a would-block rate, not a measured
false-positive rate: each blocked call still needs review.

It earns its place. The first run over 3,600 real calls returned **3.99%**: one
in twenty-five legitimate commands blocked. `extractPaths` was treating every
operand as a path, so `grep -rn "build" src` looked like a read of a directory
named `build`, and `grep -vE "node_modules|dist/"` was blocked for naming the
very things it excludes. No hand-written case would have found that — you have
to already suspect the collision to write the test.

The 2026-11-02 pre-merge baseline covered **7,110 tool-call records**, **6,872
in scope**, and **19 would-block decisions (0.28%)**, all `heavyPath`. Enabling
`fileTools` adds **401**, for **420 (6.11%)** total. Most new matches are direct
shell/interpreter edits; unresolved scratch-variable writes and workspace log
redirects also block. This is an expanded policy, not a regression in the three
older rules or a measured false-positive rate. The corpus includes repeated
records, missing historical scratch directories, and no Glob/Grep/MultiEdit/
NotebookEdit. After the bounded-read cleanup, the same corpus reports **407
(5.92%)**: **5 heavyPath**, **402 fileTools**. Of the 19 old heavy-path blocks,
13 now pass and one exposes an existing file-tools block on an unresolved write.
The remaining five are listings/recursive diffs without a proven bound. Review
the actual commands, not just the percentage.

A historical shell-read-enforcement snapshot reported **763/9,528 (8.01%)**:
**762 fileTools**, **1 heavyPath**. Many new matches are the intended `cat`/`sed`
source reads; scratch variables and missing historical working directories
remain conservative. Corpus growth means this is not an apples-to-apples
comparison with the older rates above.

On **2026-11-05**, dogfood tuning removed shell-read hard blocks and added narrow
build/test log exceptions. A paired replay of the **same 9,470 in-scope records**
through HEAD `e93257f` and the updated core went from **585 (6.18%)** to
**118 (1.25%)**, a reduction of **467 interventions**. The remaining matches are
**115 fileTools / 3 heavyPath**, including intentional edits, unresolved scratch
variables and unsupported script log destinations. This is still a would-block
rate, not measured false positives, and remains above the Phase 0 replay gate.

`test/extraction.test.mjs` pins the classes replay uncovered so they cannot
come back.

### Tool shapes are the other half of coverage

A guardrail can only judge a call it understands. A tool whose payload shape the
normaliser does not recognise is not a safe default — it is a silent hole: the
call becomes `KIND.OTHER` with no paths, every guardrail sees nothing, and it
passes while a registration check can still say "wired".

omp is the demanding case. It has far more tools than pi and edits with
**hashline**, which sends the whole patch as one `input` string with the target
named inside it (`[src/app.ts#F613]`) and no `file_path` field at all. Editing
`.env` was invisible. Its `glob` tool likewise carries the pattern in `path`
with no `pattern` field, so `broadGlob` never fired on omp while working
everywhere else.

`test/tool-shapes.test.mjs` pins the real payloads, captured from running
agents rather than guessed. When adding a harness, capture its tools first:

```js
// load with `omp -e spy.mjs` / `pi -e spy.mjs`
export default function (pi) {
  pi.on('tool_call', (e) => console.error(e.toolName, Object.keys(e.input ?? {})));
}
```

**Replay has a blind spot, and it reports it.** A rate is only as good as its
coverage: these transcripts contain no `Grep` or `Glob` tool calls, so the same
bug survived in the structured-tool path — both guardrails read a Grep tool's
`pattern` field as a path, blocking a search *for* the word `build` as if it
were a read of a `build` directory. Only running a real agent with a native
grep tool found it. Replay now lists the in-scope tools a corpus never
exercised, so the gap is visible rather than assumed.

Unit tests isolate global configuration and telemetry; temporary metrics
fixtures are removed after each check. Live smoke is opt-in and uses the real
installed wiring/authentication, not fake adapters. It creates synthetic files
in a temporary directory and requires a real source-search result plus secret
and heavy-directory hook errors. A model refusal or quota error is a failure,
not a successful block. Raw traces stay in the printed temporary directory.
`--file-tools` requires an ordinary shell read to succeed, a source-file write
to be denied without creating the file, scratch write/read and glob-read output,
and actual successful Node test logs written by both redirection and direct
`tee`. Its temporary project is created under the user's home, outside scratch
roots; Codex uses its normal workspace-write sandbox, not a sandbox bypass.
`--heavy-bounds` additionally requires directory metadata, a capped listing,
a count-only binary-inspection pipeline, and a parent-relative dependency
manifest search. Both flags passed together on all four installed harnesses on
2026-11-05 using pinned Haiku/Luna models. See EVIDENCE.md for raw traces.

## Configuration

`.harness-kit.json`, layered global → project → local:

```json
{
  "guardrails": {
    "secret":    { "enabled": true, "allow": ["fixtures/*"] },
    "heavyPath": { "enabled": true, "allow": ["vendor"] },
    "broadGlob": { "enabled": true },
    "fileTools": { "enabled": true }
  }
}
```

Configuration is read afresh on every intercepted call, including in long-lived
Pi and omp sessions. A malformed or missing layer contributes nothing and later
layers still apply. Persistent exceptions use `allow` for `secret` and
`heavyPath`, or `enabled:false` for `broadGlob` / `fileTools`.

### Direct file reads and edits

`fileTools` replaces the standalone Pi `prefer-builtin-file-tools` extension;
do not keep both active. It applies to normalized shell calls on all four
harnesses, including Codex `cmd` / `workdir`. Native read/write/edit/apply_patch
calls are unaffected by this rule (other rules still apply).

Routine shell/interpreter reads (`cat`, `sed`, `awk`, Python/Node/Path reads,
etc.) are allowed. Context guidance prefers native `read` or source-body tools
before editing so the first read can satisfy the editor's read-before-edit
requirement; it is not a hard block or a read-history tracker. Scratch glob
reads need no special exception. `secret` and `heavyPath` still apply to reads.

Searches, listings, metadata, builds/tests and stdin-only filters also remain
allowed. Source modifications still require native write/edit/apply_patch.
Block messages identify the offending operation and destination rather than
blaming a neighboring test command; interpreter reasons omit source bodies.

Write detection covers common redirects, tee/truncate/dd outputs, in-place
sed/perl/ruby, and inline/heredoc Python/Node/Path writes. Literal scratch paths under
`/tmp`, `/private/tmp`, `/var/folders`, `/private/var/folders` and `/dev` are
exempt after resolving existing ancestors and symlinks; `$TMPDIR` is resolved
and checked rather than trusted. Scratch roots are path-based, so a project
itself under a scratch root also benefits from that exemption.

Recognized build/test commands may redirect output, or pipe directly to `tee`,
to a literal non-dot `.log` filename in their working directory or its `logs/`
directory: `npx vitest run > vitest.log`, `npm test > logs/test.log`, and
`npm run build | tee build.log` pass. Symlinks and existing ancestors are
resolved; escaped destinations, dotfiles, source-file destinations and unrelated
commands are not covered. The deliberately narrow command list covers package
manager build/test/check/typecheck/lint scripts, vitest/jest/tsc/pytest,
cargo/go/swift build/test/check/clippy, and `node --test`. Other wrappers or script
names can use literal scratch logs instead.

Unknown variable write paths and complex control flow stay conservative.
This is a heuristic, not a sandbox: hidden script writes, eval, and
unsupported shell syntax/APIs are not comprehensively analyzed. Source text is scoped
to its own command/interpreter, not confused with a neighboring write script.
Run `node --test test/file-tools.test.mjs` for the focused regression check.

## Wiring it up

One command covers all four harnesses:

```bash
bash scripts/dev-link.sh            # dry run — read what it will touch
bash scripts/dev-link.sh --apply
node scripts/doctor.mjs             # verify

bash scripts/dev-unlink.sh --apply  # back it out
```

Then restart Claude Code and Codex; `/reload` in Pi and omp.

Both scripts are dry-run unless given `--apply`, are idempotent, back up every
file they edit, and accept `--only claude,pi` to wire a subset.

Tier A appends a nested `hooks.PreToolUse` handler. Existing legacy installations
may include `--harness claude` or `--harness codex`; these label decision metrics
(the verdict remains shared). Mode-less calls are counted as `tier-a`.

The current installer checks for a checkout-path mention; it does **not** migrate
stale paths or validate duplicate handlers. `doctor` likewise checks path mentions
for Tier A and package registration for Tier B, not runtime execution. After
moving the checkout, replace stale registrations rather than appending a second
hook, and run the live smoke.

Tier B registers through each agent's own package manager (`pi install`,
`omp install`, or `omp plugin install`), which records the entry in its settings
and links the checkout. The entry points come from the `pi` and `omp` keys in
`package.json`. Both agents also auto-discover their extension directories, but
a loose ambient file there must be named `.ts` or `.js`; manifest-declared
`.mjs` entry points are the supported route.

**Emergency off-switch**, effective on the next tool call even in a long-lived
Tier B session:

```bash
echo '{"guardrails":{"heavyPath":{"enabled":false}}}' > ~/.harness-kit.json
```

Use `guardrails.secret.allow` or `guardrails.heavyPath.allow` for persistent
path exceptions, and disable the firing guardrail for a persistent broad-glob
or file-tools exception. Agents may do this only with explicit user permission;
prefer a local exception and restore the previous configuration afterward.

## Local decision counts

`npm run doctor` aggregates `.local/decisions-YYYY-MM-DD.jsonl` (or `HK_LOG_DIR`).
Each record contains only closed-enum `harness`, `outcome` and `guardrail` fields:
no command, path, prompt, content, reason, identifier or exact timestamp.
Adapters record actual interceptions; direct core calls and replay do not.
These are intervention counts, not false-positive counts, and include live smoke
traffic. `fileTools` decisions now use the normal harness label. Retained
`pi-file-tools` observations come from the retired standalone Pi extension.

Buckets retain 14 UTC days, capped at 1 MiB/day. Counts can under-report at that
cap or on IO failure; telemetry failures never alter a decision. Set
`HK_NO_DECISION_LOG=1` to opt out. Crash breadcrumbs are separate and retain
their existing error/stack format; the strict schema applies to decision logs.

## Status against Phase 0

Done: core, both adapters, four guardrails, context injection, tests, doctor,
replay, and local wiring support on all four harnesses.

2026-11-02: repaired stale Claude/Pi paths and restored omp registration.
Codex 0.166.0, Pi 1.4.0 and omp 18.15.0 passed the live source-search,
secret-read block and heavy-directory block checks on `gpt-5.6-luna`.
They also passed the shared file-tools block/scratch-write smoke. Pi's standalone
extension and old local test were archived outside auto-discovery after a staged
migration with rollback on failure; a fresh Pi process passed with only the
shared rule. Existing Pi/omp sessions need `/reload`.
Claude 2.1.316 initially hit the five-hour account quota before tools started;
after the 16:50 EST reset it passed all five checks on pinned Haiku 4.5,
low effort, with a $0.15 cap. The quota failure was not counted as a block.

The two-week dogfood and a second dogfooder remain Phase 0 exit requirements.
Older design/evidence documents contain September snapshots; this dated check
supersedes their claim that Codex has never run live.
