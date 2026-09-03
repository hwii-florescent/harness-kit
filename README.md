# harness-kit

One guardrail core, four coding-agent harnesses.

**Phase 0 — local only.** Nothing is published, and nothing is wired into any
harness on this machine yet. See [SCOPE.md](./SCOPE.md) for phasing and
[ARCHITECTURE.md](./ARCHITECTURE.md) for the design.

```bash
npm test              # 169 tests, no dependencies
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
test/                169 tests; payloads.mjs holds the four dialects
scripts/             doctor.mjs (read-only) · dev-link.sh (not yet run)
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
