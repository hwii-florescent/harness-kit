# harness-kit — Scope

Phasing, boundaries, and acceptance criteria.
Companion to [ARCHITECTURE.md](./ARCHITECTURE.md).

**Status: Phase 0 — built, wired locally, dogfood in progress.**
Not published. Phase 1 has not started and must not start until the Phase 0 exit
criteria below are met.

---

## Phase overview

| Phase | Theme | Audience | State |
|---|---|---|---|
| **0** | **Local workflow** | **us only** | **← we are here.** Built and wired; dogfooding |
| **1** | Package & distribute | other people | Not started |
| **2** | Skills | — | Not started |
| **3** | MCP | — | Not started |
| 4+ | Deferred | — | Backlog only |

Phases 0 and 1 build **the same guardrails**. They differ only in *distribution*:
Phase 0 wires local paths, Phase 1 wires published artifacts. Nothing from Phase 0
is thrown away — §8 of ARCHITECTURE.md shows the two wirings side by side.

---

## Phase 0 — Local workflow (dogfood)

**Goal:** guardrails we actually run, every day, in our own projects, on all four
harnesses — with zero publishing infrastructure.

This is the real risk-retirement phase. If we won't run it ourselves for a
fortnight without switching it off, it is not ready for anyone else.

### Where it stands

**Done.** Core, both adapters, three guardrails, context injection, live config
layering, fail-open behavior, 274 tests, `doctor`, `replay`, and
`dev-link`/`dev-unlink`. Tier A wiring now carries explicit harness modes;
Tier B interactive sessions can approve one exact blocked call.

**Remaining: the dogfood itself.** That is a calendar item, not a code item, and
it is the actual gate into Phase 1. Codex live behavior remains unverified.

### Local wiring

| Harness | Mechanism | Reload |
|---|---|---|
| Claude Code | `jq` migration to canonical nested `hooks.PreToolUse` with `--harness claude` | restart |
| Codex | `jq` migration to canonical nested `hooks.PreToolUse` with `--harness codex` | restart |
| Pi | `pi install <repo>` | `/reload` |
| omp | `omp install <repo>` or `omp plugin install <repo>` | `/reload` |

Driven by `scripts/dev-link.sh --apply`, reversed by `scripts/dev-unlink.sh --apply`.
Both dry-run by default, idempotent, and back up every file they edit.

Do not hand-place a loose `.mjs` in the ambient extension directories —
auto-discovery accepts only `.ts`/`.js` there. Use the explicit package
manifest entry points or `-e` for ad-hoc runs.

### In scope — and its state

| | State |
|---|---|
| `checkTool(payload, opts) → verdict` | ✅ — one global decision |
| `secret` guardrail | ✅ incl. globs, patch bodies, interpreter `-c`, second-command reach |
| `heavyPath` guardrail | ✅ unbounded-read rule |
| `broadGlob` guardrail | ✅ incl. omp's `{path}` shape |
| Bash command analysis | ✅ role-aware; the largest file in `core/` |
| Layered config loader | ✅ re-reads global, project, and local layers every call |
| Fail-open + crash log | ✅ three layers |
| Tier A adapter | ✅ Claude `PreToolUse ask`; Codex and non-prompting Claude exit 2 |
| Tier B adapter | ✅ shared async handler; one exact-call UI approval, no-UI block |
| Context injection | ✅ — and must not name the guardrails, see ARCHITECTURE.md §11 |
| `doctor` | ✅ defensive Tier A inspection plus package-manager checks |
| `replay` | ✅ false-positive rate against real history |
| Tests | ✅ 274, zero dependencies |

### Out of scope for Phase 0

- npm publishing, semver, scopes, provenance
- Marketplace manifests of any kind
- `hk init` / `hk update`, ownership + checksum manifests, drift reporting
- Documentation written for anyone but us
- LICENSE, CONTRIBUTING, support policy
- Skills (Phase 2), MCP (Phase 3)
- Subagents, slash commands, prompt templates, rules files, output styles, statusline
- OpenCode (structurally Tier B; add only if actually needed)

### Acceptance criteria

| # | Criterion | State |
|---|---|---|
| 1 | `Read .env` blocked on all four, same message | ⚠️ verified live on Claude Code, Pi, omp; **Codex synthetic only** |
| 2 | `ls node_modules` blocked, `npm run build` not, on all four | ✅ |
| 3 | `Glob **/*.ts` at root blocked with a narrower suggestion | ✅ incl. omp's shape |
| 4 | Guardrail modularity — removing one breaks a bounded, obvious set of tests | ⚠️ reworded; `secret` now spans three test files by design (unit, extraction, tool-shapes) |
| 5 | Corrupting `core/index.mjs` fails open everywhere | ✅ 31 hostile payloads, 9 failure drills |
| 6 | Editing a core file changes behaviour on all four with no re-link | ✅ |
| 7 | `doctor` reports structural wiring/registration and versions; live loading is checked separately | ✅ |

`doctor` is deliberately not a claim that a Tier B extension handler loaded:
package-manager registration is necessary but the live block/pass smoke is the
execution proof. Codex's live block remains the only open technical acceptance
item.
Criterion 1 is the one open technical item: **Codex has never been exercised
live.** Its payloads here have only ever been synthetic. Close this before
treating the dogfood as covering all four.

### Exit criteria — the gate into Phase 1

Behavioural, not technical. All of:

- **Used daily for 2+ weeks** across at least 2 real projects
- **Zero forced disables** — not once did someone switch a guardrail off to get work done
- **Replay below 0.5%** and every remaining block one you would defend on inspection
- All acceptance criteria green, including Codex live
- Someone other than the original author has wired it from scratch using only the README

Read the remaining blocks; do not just watch the number. `npm run replay --verbose`
lists them, and it reports which in-scope tools the corpus never exercised — a
clean rate on an unexercised path means nothing.

If false positives are still appearing, stay in Phase 0 and tune. Shipping a
noisy guardrail is worse than shipping nothing.

### Explicit non-goals

- Feature parity with ClaudeKit
- Any content authoring
- Perfect tool coverage — but note that *unrecognised* is not *safe*: see
  ARCHITECTURE.md §6

---

## Phase 1 — Package & distribute

**Goal:** the Phase 0 guardrails, installable by someone who has never seen the
repo, in one command per harness.

No new guardrail behaviour. Packaging, distribution, and the update story only.

**In scope:** publish `@<org>/harness-kit` with `bin` entries `hk` and `hk-guard`;
`exports` + `pi`/`omp` keys (Pi and omp then need zero generated files); semver and
changelog; optional marketplace manifests for Claude Code and Codex; `hk init`,
`hk update`, `hk doctor`; ownership + checksum manifest; README for a stranger;
LICENSE, CONTRIBUTING, support policy.

**Out of scope:** any change to guardrail behaviour — that is a Phase 0
regression, fix it there. Skills (Phase 2), MCP (Phase 3).

**Acceptance criteria**

1. A fresh machine installs on each harness in one command, no repo checkout.
2. `npm update` propagates a core change to all four harnesses with no re-init.
3. `hk doctor` on a fresh machine reports every wired harness with versions.
4. Someone outside the team installs it successfully from published docs alone.

---

## Phase 2 — Skills

**Goal:** author a skill once; every harness discovers it.

All four support the [Agent Skills standard](https://agentskills.io/specification),
so `SKILL.md` content is portable verbatim. The work is discovery wiring, not
translation.

In scope: `content/skills/` as the single source; per-harness discovery; a
`harnesses:` frontmatter filter; skill validation in `hk doctor`.

Open question: prefer the shared `~/.agents/skills/` location — read by Pi today
and the emerging cross-harness convention — over four per-harness paths?

---

## Phase 3 — MCP

**Goal:** declare MCP servers once; optionally extend guardrails over MCP tool calls.

In scope: neutral server declarations emitted to `.mcp.json` (Claude Code, Codex),
Pi settings, omp `mcp.json`; extending `checkTool` to MCP tool names; per-server
enable/disable.

Note that extending guardrails over MCP means a new family of payload shapes,
which ARCHITECTURE.md §6 says to *capture*, not guess.

Out of scope: authoring MCP servers; credential management.

---

## Phase 4+ — Deferred backlog

Not scheduled. Listed so Phase 0 does not accidentally design for them.

| Item | Note |
|---|---|
| Subagents | Claude Code + Codex + omp; Pi has none, by design |
| Slash commands / prompt templates | Markdown formats ~90% identical across the three that support it |
| Rules files | `CLAUDE.md` / `AGENTS.md` / omp `RULES.md` + `rules/*.mdc` |
| Output styles / coding levels | Claude Code only |
| Statusline | Claude Code, omp |
| Plan/report workflow | The largest ClaudeKit surface; port last, if at all |

---

## Sequencing (Phase 0)

Steps 1–7 are complete. Step 8 is the work.

| # | Step | State |
|---|---|---|
| 1 | Spike: `secret` + Claude Code and Pi adapters — the two extremes | ✅ |
| 2 | Complete Tier A: add Codex, confirm exit-2 parity | ✅ code; ⚠️ never run live |
| 3 | Complete Tier B: add omp; one file or two? | ✅ one shared implementation |
| 4 | `dev-link.sh` | ✅ rewritten twice — see ARCHITECTURE.md §8.0 |
| 5 | Remaining guardrails + bash allowlisting | ✅ |
| 6 | Context injection | ✅ |
| 7 | `doctor.mjs` + internal README | ✅ plus `replay.mjs` |
| **8** | **Dogfood. Two weeks. Tune false positives.** | **← current** |

Step 8 is the longest and the one most likely to be cut short. Don't.

---

## Decisions

### Resolved during Phase 0

| Decision | Outcome |
|---|---|
| Repo layout | Single package. Split only if `core` gains an outside consumer. |
| Claude Code wiring scope | User level (`~/.claude/settings.json`), matching Codex, keeping Phase 0 symmetric. |
| One Tier B file or two | One implementation (`shared.mjs`), two thin entry points. |
| Language | `.mjs` throughout — no build step, no type packages. |
| Core blocking decision | One global verdict; adapters translate it per harness. |
| Interactive approval scope | Exact tool call, one use, no persisted approval state. |
| Config reload | Read all active layers on every call, including long-lived Tier B sessions. |

### Still needed

**Now (blocks the Phase 0 exit)**

1. **Who dogfoods** — the exit criteria require more than one person, and
   currently there is one.
2. **Codex live verification** — acceptance criterion 1 is not closed.

**Later (blocks Phase 1, safe to defer)**

3. Package name and npm scope.
4. Public or private npm — determines whether marketplace distribution is viable.
5. Marketplace or npm-only — Pi/omp are free via package keys; Claude Code and
   Codex cost a manifest each.
