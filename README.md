# harness-kit

One guardrail core, four coding-agent harnesses.

**Phase 0 — local only.** Built and wired locally; nothing is published. The
remaining Phase 0 work is a two-week dogfood, not code.

New here? Start with [AGENTS.md](./AGENTS.md) — invariants and the traps that
have already cost time. Then [SCOPE.md](./SCOPE.md) for phasing and
[ARCHITECTURE.md](./ARCHITECTURE.md) for the design.

```bash
npm test              # 274 tests, no dependencies
npm run replay        # false-positive rate against real agent history
npm run doctor        # which harnesses are installed / wired
```

## What it does

Three guardrails share one core decision on Claude Code, Codex, Pi and omp:

| Guardrail | Blocks | Why |
|---|---|---|
| `secret` | `.env`, `*.pem`, `id_rsa`, `credentials.json`, … | Stops credentials entering model context |
| `heavyPath` | reads inside `node_modules`, `dist`, `.git`, … | Stops generated files flooding the context window |
| `broadGlob` | `**/*.ts` at the project root | Same, for discovery tools |

Each guardrail is configurable and individually disablable. Core failures fail
open; a correct block can be declined through a supported interactive adapter or
persistently exempted in configuration.

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

- Claude Code's interactive/default `PreToolUse` path returns
  `permissionDecision: "ask"` so Claude owns the one-call prompt. Its
  `dontAsk` and `bypassPermissions` modes stay on exit 2 + stderr.
- Codex stays on exit 2 + stderr; its installed runtime rejects
  `permissionDecision: "ask"`.
- Pi and omp await one `ctx.ui.confirm()` only when `ctx.hasUI === true`.
  Approval allows that exact call once; a non-`true` result or no UI returns
  `{block:true, reason}`. A confirmation exception fails open. No approval
  persists.

Claude's separate `PermissionRequest` event is documented but unused; the kit
uses the `PreToolUse` `ask` response instead. Registration and structural
inspection are not proof that an extension loaded, so use the live block/pass
smoke for that claim.

Allowed process calls remain exit 0 with no output. Context injection still uses
the shared JSON `additionalContext` shape.

## Layout

```
src/core/            checkTool, config, normalisation, bash analysis
  guardrails/        secret · heavy-path · broad-glob
src/tier-a/guard.mjs Claude Code + Codex
src/tier-b/          shared.mjs + pi.mjs + omp.mjs
test/                274 tests; payloads.mjs holds the four dialects
scripts/             doctor.mjs · replay.mjs (read-only) · dev-link.sh
```

## Testing approach

`test/payloads.mjs` expresses the same logical call in all four harness dialects.
The core parity suite asserts not only that each verdict is correct but that the
four are **identical to one another** — the kit's central claim.

Tier A is tested by spawning `guard.mjs` with explicit Claude and Codex modes and
asserting on the process contract. Tier B is tested through an async fake
`ExtensionAPI` shaped like Pi's, including approval, denial, no-UI, and
fail-open confirmation cases.

A dedicated false-positive suite protects the Phase 0 replay target:
`git commit -m "fix .env loading"`, `rm -rf dist`, `./node_modules/.bin/eslint
src` and friends must all pass through.

### Replay: the test that unit tests cannot be

`npm run replay` walks recorded agent transcripts and feeds every tool call to
`checkTool()`. Those calls actually ran and were overwhelmingly legitimate, so
the blocked fraction is an empirical false-positive rate — the Phase 0 exit
criterion, measured in seconds rather than a fortnight.

It earns its place. The first run over 3,600 real calls returned **3.99%**: one
in twenty-five legitimate commands blocked. `extractPaths` was treating every
operand as a path, so `grep -rn "build" src` looked like a read of a directory
named `build`, and `grep -vE "node_modules|dist/"` was blocked for naming the
very things it excludes. No hand-written case would have found that — you have
to already suspect the collision to write the test.

The latest recorded run covered **4,248 calls**, of which **3,993 were in
scope** and **34 were blocked (0.85%)**. The remaining blocks are the guardrail
working: `cat .npmrc`, `ls node_modules`, `find dist -type f`. Run it after any
change to `bash.mjs` or a guardrail, and read the remaining blocks rather than
watching the number — each one should be a block you would defend.

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

Everything is hermetic: `HK_NO_GLOBAL_CONFIG=1` stops the config loader reading
`~`, and crash logs are redirected under `test/`. The suite writes nothing
outside this repo.

## Configuration

`.harness-kit.json`, layered global → project → local:

```json
{
  "guardrails": {
    "secret":    { "enabled": true, "allow": ["fixtures/*"] },
    "heavyPath": { "enabled": true, "allow": ["vendor"] },
    "broadGlob": { "enabled": true }
  }
}
```

Configuration is read afresh on every intercepted call, including in long-lived
Pi and omp sessions. A malformed or missing layer contributes nothing and later
layers still apply. Persistent exceptions use `allow` for `secret` and
`heavyPath`, or `enabled:false` for `broadGlob`; interactive grants are
one-call-only and are not written to disk.

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

Tier A writes canonical nested `hooks.PreToolUse` groups with exact commands:

```text
node "<kit>/src/tier-a/guard.mjs" --harness claude
node "<kit>/src/tier-a/guard.mjs" --harness codex
```

Reruns migrate the old mode-less command, wrong-harness mode, direct legacy
entries, and duplicate harness-kit handlers without clobbering unrelated groups
or handlers. `doctor` considers Tier A wired only when exactly one canonical
nested handler has the expected harness-specific command. It asks Pi and omp
whether the package is registered; the documented live block/pass smoke proves
that the extension actually loaded and executes.

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
exception.

## Status against Phase 0

Done: core, both adapters, three guardrails, context injection, tests, doctor,
replay, and local wiring support on all four harnesses.

Remaining: the two-week dogfood — the actual gate into Phase 1 — plus one open
technical item: **Codex has never been exercised live.** Its payloads here have
only ever been synthetic. See SCOPE.md acceptance criterion 1.
