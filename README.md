# harness-kit

One guardrail core, four coding-agent harnesses.

**Phase 0 — local only.** Nothing is published, and nothing is wired into any
harness on this machine yet. See [SCOPE.md](./SCOPE.md) for phasing and
[ARCHITECTURE.md](./ARCHITECTURE.md) for the design.

```bash
npm test              # 188 tests, no dependencies
npm run replay        # false-positive rate against real agent history
npm run doctor        # which harnesses are installed / wired
```

## What it does

Three guardrails, enforced identically on Claude Code, Codex, Pi and omp:

| Guardrail | Blocks | Why |
|---|---|---|
| `secret` | `.env`, `*.pem`, `id_rsa`, `credentials.json`, … | Stops credentials entering model context |
| `heavyPath` | reads inside `node_modules`, `dist`, `.git`, … | Stops generated files flooding the context window |
| `broadGlob` | `**/*.ts` at the project root | Same, for discovery tools |

Each guardrail is configurable and individually disablable. All three fail open.

## How one core serves four harnesses

The harnesses fall into two integration tiers, so there are two adapters, not four:

```
                     src/core/          ← all logic, no harness imports
                    checkTool()
                         │
          ┌──────────────┴──────────────┐
   Tier A: process hook          Tier B: in-process extension
   stdin JSON → exit 0|2         pi.on('tool_call') → {block:true}
   Claude Code · Codex           Pi · omp
```

Blocking uses **exit 2 + stderr**, not `permissionDecision` JSON — both process
harnesses honour it identically, whereas Codex rejects a bare
`permissionDecision: "allow"`. One code path, no branching.

## Layout

```
src/core/            checkTool, config, normalisation, bash analysis
  guardrails/        secret · heavy-path · broad-glob
src/tier-a/guard.mjs Claude Code + Codex
src/tier-b/          shared.mjs + pi.mjs + omp.mjs
test/                188 tests; payloads.mjs holds the four dialects
scripts/             doctor.mjs · replay.mjs (read-only) · dev-link.sh
```

## Testing approach

`test/payloads.mjs` expresses the same logical call in all four harness dialects.
The parity suite asserts not only that each verdict is correct but that the four
are **identical to one another** — that is the kit's central claim, so it is
tested directly.

Tier A is tested by spawning `guard.mjs` as a subprocess and asserting on the
exit code, because the exit code *is* the contract. Tier B is tested through a
fake `ExtensionAPI` shaped like Pi's.

A dedicated `false positives` suite guards the Phase 0 exit criterion of a zero
false-positive rate — `git commit -m "fix .env loading"`, `rm -rf dist`,
`./node_modules/.bin/eslint src` and friends must all pass through.

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

The rate is now **0.87%**, and what remains is the guardrail working: `cat
.npmrc`, `ls node_modules`, `find dist -type f`. Run it after any change to
`bash.mjs` or a guardrail, and read the remaining blocks rather than watching
the number — each one should be a block you would defend.

`test/extraction.test.mjs` pins the classes replay uncovered so they cannot
come back.

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

## Wiring it up (when ready to dogfood)

Not done yet, deliberately. One command covers all four harnesses:

```bash
bash scripts/dev-link.sh            # dry run — read what it will touch
bash scripts/dev-link.sh --apply
node scripts/doctor.mjs             # verify

bash scripts/dev-unlink.sh --apply  # back it out
```

Then restart Claude Code and Codex; `/reload` in Pi and omp.

Both scripts are dry-run unless given `--apply`, are idempotent, back up every
file they edit, and accept `--only claude,pi` to wire a subset.

Tier A entries are **appended** to `hooks.PreToolUse` with `jq` (required), never
assigned — clobbering hooks you already have is the one unrecoverable mistake an
installer can make. Uninstall filters that array by command path, so hooks added
later survive. Tier B removes a symlink only when its target resolves inside this
checkout; a foreign file of the same name is reported and left alone.

**Emergency off-switch**, faster than uninstalling and effective on the next tool
call — no restart, no config surgery:

```bash
echo '{"guardrails":{"heavyPath":{"enabled":false}}}' > ~/.harness-kit.json
```

## Status against Phase 0

Done: core, both adapters, three guardrails, context injection, tests, doctor.
Remaining: the two-week dogfood, which is the actual gate into Phase 1.
