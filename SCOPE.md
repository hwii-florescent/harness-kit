# harness-kit — Scope

Phasing, boundaries, and acceptance criteria.
Companion to [ARCHITECTURE.md](./ARCHITECTURE.md).

**Status:** design. No code yet.

---

## Phase overview

| Phase | Theme | Audience | Ships |
|---|---|---|---|
| **0** | **Local workflow** | **us only** | Guardrails + context injection, wired locally on our own machines |
| **1** | Package & distribute | other people | The same code, published to npm + marketplaces/extensions |
| **2** | Skills | — | Neutral skill content + per-harness discovery |
| **3** | MCP | — | Server wiring + guardrail coverage over MCP tool calls |
| 4+ | Deferred | — | Agents, commands, rules, output styles, statusline |

Phases 0 and 1 build **the same guardrails**. They differ only in *distribution*:
Phase 0 wires local paths, Phase 1 wires published artifacts. Nothing from Phase 0
is thrown away — §8 of ARCHITECTURE.md shows the two wirings side by side.

Each phase is independently shippable. Phase 0 must not carry design debt for
later phases, but it also must not build for them speculatively.

---

## Phase 0 — Local workflow (dogfood)

**Goal:** guardrails that we actually run, every day, in our own projects, on all
four harnesses — with zero publishing infrastructure.

This is the real risk-retirement phase. If we won't run it ourselves for a
fortnight without switching it off, it is not ready for anyone else.

### Why local-first is not a compromise

The Phase 0 iteration loop is **faster than the published one** and stays the
permanent dev environment:

- Pi and omp auto-discover `~/.{pi,omp}/agent/extensions/*.ts` and hot-reload with
  `/reload` — edit a file, reload, done
- Claude Code and Codex re-exec the hook shim on every tool call — edit a file,
  next call picks it up
- No publish, no version bump, no cache invalidation anywhere

### Local wiring

| Harness | Mechanism | Effort |
|---|---|---|
| Pi | symlink → `~/.pi/agent/extensions/harness-kit.ts` | auto-discovered, `/reload`-able |
| omp | symlink → `~/.omp/agent/extensions/harness-kit.ts` | auto-discovered, `/reload`-able |
| Claude Code | absolute `node <repo>/src/tier-a/guard.cjs` in `~/.claude/settings.json` | one JSON merge |
| Codex | absolute `node <repo>/src/tier-a/guard.cjs` in `~/.codex/hooks.json` | one JSON merge |

Driven by one script, `scripts/dev-link.sh`, plus `scripts/dev-unlink.sh` to back
it all out. No `npm link` required — symlinks and absolute paths are enough, and
they avoid npm's global state.

### In scope

**Core** (`src/core/`)
- `checkTool(call) → verdict` — the single pure entry point
- Three guardrails:
  - `secret` — `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa`, `id_ed25519`, `credentials*`, `secrets.y?ml`; exempts `*.example` / `*.sample` / `*.template`
  - `heavy-path` — gitignore-syntax blocklist (`node_modules`, `dist`, `.git`, `.venv`, `target`, `vendor`, `coverage`) with `!` negation
  - `broad-glob` — `**`, `**/*`, `**/*.<ext>` at repo or worktree root
- Bash command analysis: unwrap `bash -c`, split on `&&`/`||`/`;`, strip env-var
  and `sudo`/`env` prefixes, allowlist build/tooling commands
- Layered config loader + JSON schema
- Fail-open wrapper + crash log

**Adapters**
- Tier A process hook (`guard.cjs`) — Claude Code + Codex, **exit 2 blocking only**
- Tier B TS extension (`shared.ts` + `pi.ts` / `omp.ts`) — Pi + omp
- Tool-name normalisation table per adapter

**Context injection** (the non-blocking half of "hooks")
- One shared context builder: project detection, active rules pointer, path
  conventions
- Claude Code / Codex: `hookSpecificOutput.additionalContext` on `UserPromptSubmit`
- Pi / omp: `before_agent_start`

**Local tooling**
- `scripts/dev-link.sh` / `dev-unlink.sh`
- `scripts/doctor.mjs` — detect installed harnesses + versions, verify wiring,
  replay the crash log (becomes `hk doctor` in Phase 1)

**Tests**
- Golden fixtures: one payload per harness per guardrail, asserting identical verdicts
- Live smoke test: `-p` / print-mode run per harness proving a real block

### Out of scope for Phase 0

- npm publishing, semver, scopes, provenance
- Marketplace manifests of any kind
- `hk init` / `hk update`, ownership + checksum manifests, drift reporting
- Documentation written for anyone but us
- LICENSE, CONTRIBUTING, support policy
- Skills (Phase 2), MCP (Phase 3)
- Subagents, slash commands, prompt templates, rules files, output styles, statusline
- OpenCode (structurally Tier B; add only if actually needed)
- Migrating existing ClaudeKit content

### Acceptance criteria

1. `Read .env` is blocked on all four harnesses, with the same message.
2. `ls node_modules` is blocked; `npm run build` is **not** blocked, on all four.
3. `Glob **/*.ts` at repo root is blocked with a suggested narrower pattern.
4. Deleting `src/core/guardrails/secret.mjs` breaks exactly one test file.
5. Corrupting `core/index.mjs` fails open on every harness — no session bricked.
6. Editing a core file changes behaviour on all four harnesses with **no** re-link
   (at most a `/reload` on Pi/omp).
7. `scripts/doctor.mjs` correctly reports all four as wired, with versions.

### Exit criteria — the gate into Phase 1

Behavioural, not technical. All of:

- **Used daily for 2+ weeks** across at least 2 real projects, by everyone on the team
- **Zero forced disables** — not once did someone switch a guardrail off to get work done
- **False-positive rate at zero** for a full week (a legitimate call wrongly blocked is the failure mode that kills adoption)
- All seven acceptance criteria still green
- Someone other than the original author has linked it from scratch using only the README

If false positives are still appearing, stay in Phase 0 and tune. Shipping a noisy
guardrail to other people is worse than shipping nothing.

### Explicit non-goals

- Feature parity with ClaudeKit
- Any content authoring
- Perfect tool-name coverage — Bash/Read/Write/Edit/Glob is enough

---

## Phase 1 — Package & distribute

**Goal:** the Phase 0 guardrails, installable by someone who has never seen the
repo, in one command per harness.

No new guardrail behaviour. This phase is packaging, distribution, and the update
story — nothing else.

### In scope

**npm**
- Publish `@<org>/harness-kit`; `bin` entries `hk` and `hk-guard`
- `exports` map + `pi` / `omp` package.json keys (Pi and omp then need **zero**
  generated files)
- Semver discipline; changelog

**Marketplaces** (evaluate cost/benefit before committing)
- Claude Code: `.claude-plugin/plugin.json` + `hooks/hooks.json`, marketplace repo
  with `.claude-plugin/marketplace.json`
- Codex: `.codex-plugin/plugin.json` + `hooks.json`, `.agents/plugins/marketplace.json`
  (its marketplace accepts `npm:` sources directly, which may make this nearly free)
- If adopted, all four harnesses reach zero generated files

**CLI hardening**
- `hk init --harness <list>` — write/merge wiring, replacing `dev-link.sh`
- `hk update` — reconcile wiring, report drift
- `hk doctor` — promoted from `scripts/doctor.mjs`
- Ownership + checksum manifest at `~/.harness-kit/manifest.json`

**External-facing**
- README written for a stranger; per-harness install docs
- LICENSE, CONTRIBUTING, issue templates, support policy
- Licensing review of anything carried over from ClaudeKit

### Out of scope

- Any change to guardrail behaviour (that is a Phase 0 regression, fix it there)
- Skills (Phase 2), MCP (Phase 3)

### Acceptance criteria

1. A fresh machine installs on each harness in one command, no repo checkout.
2. `npm update` propagates a core change to all four harnesses with no re-init.
3. `hk doctor` on a fresh machine reports every wired harness with versions.
4. Someone outside the team installs it successfully from published docs alone.

---

## Phase 2 — Skills

**Goal:** author a skill once; every harness discovers it.

Starting position is strong: all four support the
[Agent Skills standard](https://agentskills.io/specification), so `SKILL.md`
content is portable **verbatim**. The work is discovery wiring, not translation.

In scope: `content/skills/` as the single source; per-harness discovery
(Claude Code native dir; Codex plugin `"skills": "./skills/"`; Pi `skills` setting
or `.agents/skills/`; omp `.omp/skills/`); a `harnesses:` frontmatter filter; skill
validation in `hk doctor`; decision on native plugin publishing (both Claude Code
and Codex carry skills in plugins, which would make this near-zero-config).

Out of scope: rewriting skills, Python venv bootstrapping, third-party skill
vendoring (licensing review required first).

Open question: prefer the shared `~/.agents/skills/` location — read by Pi today
and the emerging cross-harness convention — over four per-harness paths?

---

## Phase 3 — MCP

**Goal:** declare MCP servers once; optionally extend guardrails over MCP tool calls.

In scope: neutral server declarations emitted to `.mcp.json` (Claude Code, Codex),
Pi `settings.json`, omp `mcp.json`; extending `checkTool` to MCP tool names;
per-server enable/disable in config.

Out of scope: authoring MCP servers; credential management; the Gemini-CLI
delegation pattern from ClaudeKit (revisit only if context cost proves to be a
real problem).

Note: Codex's plugin manifest carries `mcpServers` directly, and its marketplace
supports `npm:` sources — Phase 3 may be substantially cheaper via plugin
distribution than via file generation.

---

## Phase 4+ — Deferred backlog

Not scheduled. Listed so Phase 0 does not accidentally design for them.

| Item | Note |
|---|---|
| Subagents | Claude Code + omp only; Pi has none, by design |
| Slash commands / prompt templates | Markdown formats are ~90% identical across the three that support it |
| Rules files | `CLAUDE.md` / `AGENTS.md` / omp `RULES.md` + `rules/*.mdc` |
| Output styles / coding levels | Claude Code only |
| Statusline | Claude Code, omp |
| Plan/report workflow | The largest ClaudeKit surface; port last, if at all |

---

## Sequencing (Phase 0)

**Step 1 — spike (highest risk first).**
Build `core/guardrails/secret.mjs` plus **only** the Claude Code and Pi adapters:
the two extremes, out-of-process vs in-process. Wire both by hand. If one core
module serves both cleanly, the design holds and the rest is mechanical.

**Step 2 — complete Tier A.** Add Codex. Confirm exit-2 blocking behaves identically.

**Step 3 — complete Tier B.** Add omp. Answer open question #2: one file or two?

**Step 4 — `dev-link.sh`.** Only now is it worth automating; by this point we know
what the four wirings actually look like.

**Step 5 — remaining guardrails.** `heavy-path`, `broad-glob`, bash allowlisting.

**Step 6 — context injection.**

**Step 7 — `doctor.mjs` + internal README.**

**Step 8 — dogfood.** Two weeks. Tune false positives. This is the longest step
and the one most likely to be cut short — don't.

Ship Step 1 before committing to the rest.

---

## Decisions needed

### Now (blocks Phase 0)

1. **Repo layout** — single package, or monorepo splitting `core` from adapters?
   Recommendation: single package; split only if `core` gains an outside consumer.
2. **Claude Code wiring scope** — project `.claude/settings.json` or user-level
   `~/.claude/settings.json`? Codex `hooks.json` is user-level only, so user-level
   keeps Phase 0 symmetric. Project-level is better for per-repo config later.
3. **Who dogfoods** — the exit criteria require more than one person.

### Later (blocks Phase 1, safe to defer)

4. **Package name / npm scope.**
5. **Public or private npm** — determines whether marketplace distribution is viable.
6. **Marketplace or npm-only** — Pi/omp are free via package keys; Claude Code and
   Codex marketplaces cost two manifests to maintain.
