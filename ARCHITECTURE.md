# harness-kit — Architecture

One authored kit, four coding-agent harnesses, distributed over npm.

**Status:** design. No code yet.
**Last verified:** 2026-09-02 against locally installed CLIs.

---

## 1. Purpose

Package our guardrails, context injection, skills, and MCP wiring **once**, and run
them unmodified on Claude Code, Codex, Pi, and Oh-My-Pi (omp) — with a single
`npm update` propagating logic changes to every harness.

Non-goal: a lowest-common-denominator kit. Where a harness is more capable, the
adapter uses that capability; where it is less capable, it degrades explicitly and
visibly (`doctor` reports it), never silently.

---

## 2. Verified harness capabilities

All rows below were verified by inspecting the installed CLIs on 2026-09-02, not
inferred from documentation.

| | **Claude Code** | **Codex** `0.146.0` | **Pi** `0.84.2` | **omp** `18.1.2` |
|---|---|---|---|---|
| Interception model | process hook | **process hook** | in-process TS | in-process TS |
| Hook config | `.claude/settings.json` → `hooks` | `~/.codex/hooks.json` | — (extensions) | — (extensions) |
| Can block a tool call | ✅ | ✅ | ✅ | ✅ |
| Extension/plugin runtime | plugin dirs | plugin dirs | TS via jiti | TS via jiti |
| Plugin manifest | `.claude-plugin/plugin.json` | `.codex-plugin/plugin.json` | `package.json` `pi` key | `package.json` `omp`/`pi` key |
| Marketplace manifest | `.claude-plugin/marketplace.json` | `.agents/plugins/marketplace.json` | — (npm/git direct) | — (npm/git direct) |
| Marketplace CLI | `claude plugin marketplace add` | `codex plugin marketplace add` | `pi install npm:…` | `omp plugin install` |
| npm as a source | via git/marketplace | ✅ native `npm:` source | ✅ | ✅ |
| Skills | ✅ native | ✅ (`"skills": "./skills/"`) | ✅ Agent Skills std. | ✅ |
| MCP | ✅ `.mcp.json` | ✅ `.mcp.json` / `mcpServers` | ✅ settings | ✅ `mcp.json` |
| Subagents | ✅ | ✅ (`SubagentStart/Stop`) | ❌ | ✅ |
| Rules file | `CLAUDE.md` | `AGENTS.md` | `AGENTS.md` | `RULES.md` + `rules/*.mdc` |

### 2.1 Hook events

Claude Code and Codex expose a near-identical event set. Codex event names were
read from the `codex` binary (v0.146.0); some are not yet in public docs.

| Event | Claude Code | Codex |
|---|---|---|
| `PreToolUse` | ✅ | ✅ |
| `PostToolUse` | ✅ | ✅ |
| `UserPromptSubmit` | ✅ | ✅ |
| `SessionStart` / `SessionEnd` | ✅ | ✅ |
| `SubagentStart` / `SubagentStop` | ✅ | ✅ |
| `PreCompact` | ✅ | ✅ |
| `PostCompact` | — | ✅ |
| `Stop` | ✅ | ✅ |
| `PermissionRequest` | — | ✅ |

Pi/omp equivalents (event-bus names): `tool_call` (≈ PreToolUse, can block),
`tool_result` (≈ PostToolUse), `input` + `before_agent_start` (≈ UserPromptSubmit),
`session_start` / `session_shutdown`, `session_before_compact` / `session_compact`,
`context` (no Claude/Codex analogue — mutate the message list before every LLM call).

### 2.2 Hook wire format

Both process-tier harnesses read a JSON payload on stdin and accept a JSON
response on stdout under `hookSpecificOutput`:

```jsonc
// PreToolUse response
{ "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow" | "deny" | "ask",
    "permissionDecisionReason": "…",
    "additionalContext": "…"
} }
```

**Divergence:** Codex reserves `permissionDecision: "allow"` for responses that
also supply `updatedInput` (a rewritten tool call). Returning bare `"allow"` can
trip Codex hook validation.

**Therefore the universal contract is the exit code, not the JSON:**

| Outcome | Universal mechanism | Works on |
|---|---|---|
| Allow | `exit 0`, no stdout | Claude Code, Codex |
| **Block** | **`exit 2`, reason on stderr** | **Claude Code, Codex** |
| Inject context | `hookSpecificOutput.additionalContext` | Claude Code, Codex |

Phase 1 uses **exit 2 + stderr exclusively** for blocking. One shim binary, byte
identical, works on both harnesses. JSON responses are used only for context
injection, where the shapes agree.

---

## 3. The core insight: two tiers, not four adapters

The four harnesses collapse into **two integration tiers**:

```
                    ┌─────────────────────────────┐
                    │      core/  (pure ESM)      │
                    │  no harness imports at all  │
                    │  checkTool() · buildCtx()   │
                    └──────────┬──────────────────┘
                               │
             ┌─────────────────┴──────────────────┐
             ▼                                    ▼
   ┌───────────────────────┐         ┌────────────────────────┐
   │ Tier A — process hook │         │ Tier B — TS extension  │
   │ stdin JSON → exit 0|2 │         │ pi.on("tool_call", …)  │
   ├───────────────────────┤         ├────────────────────────┤
   │ Claude Code           │         │ Pi                     │
   │ Codex                 │         │ omp                    │
   └───────────────────────┘         └────────────────────────┘
```

Two adapters, ~60 lines each. Everything else is shared.

---

## 4. Package layout

```
harness-kit/                          # published as @<org>/harness-kit
├── package.json                      # bin + exports + "pi" key + "omp" key
├── src/
│   ├── core/                         # ← the only place logic lives
│   │   ├── index.mjs                 # public: checkTool, buildContext, loadConfig
│   │   ├── config.mjs                # global → project → local merge
│   │   └── guardrails/
│   │       ├── secret.mjs            # .env, *.pem, id_rsa, credentials…
│   │       ├── heavy-path.mjs        # node_modules, dist, .git… (gitignore syntax)
│   │       └── broad-glob.mjs        # **/*.ts at repo root, etc.
│   ├── tier-a/                       # process hooks
│   │   └── guard.cjs                 # stdin JSON → core → exit 0|2
│   ├── tier-b/                       # in-process extensions
│   │   ├── shared.ts                 # the real body, harness-parameterised
│   │   ├── pi.ts                     # 8-line re-export
│   │   └── omp.ts                    # 8-line re-export
│   └── cli/                          # ── Phase 1 ──
│       ├── kit.mjs                   # init · update · doctor
│       └── guard.mjs                 # `hk-guard` — core behind a CLI (CI, git hooks)
├── scripts/                          # ── Phase 0 ──
│   ├── dev-link.sh                   # wire all four harnesses to this checkout
│   ├── dev-unlink.sh                 # back it all out
│   └── doctor.mjs                    # promoted to `hk doctor` in Phase 1
├── plugins/                          # ── Phase 1 ── generated, committed, published
│   ├── claude/.claude-plugin/plugin.json + hooks/hooks.json
│   └── codex/.codex-plugin/plugin.json + hooks.json
├── content/                          # ── Phase 2+ ── authored once, neutral
│   ├── skills/*/SKILL.md
│   └── rules/*.md
├── ARCHITECTURE.md
└── SCOPE.md
```

### package.json

Phase 0 needs only `exports` (so the adapters can `import` the core by path).
`bin`, the `pi`/`omp` keys, and publishing metadata arrive in Phase 1.

```jsonc
{
  "name": "@<org>/harness-kit",
  "bin": { "hk": "./src/cli/kit.mjs", "hk-guard": "./src/cli/guard.mjs" },
  "exports": {
    "./core":   "./src/core/index.mjs",
    "./guard":  "./src/tier-a/guard.cjs",
    "./pi":     "./src/tier-b/pi.ts",
    "./omp":    "./src/tier-b/omp.ts"
  },
  "pi":  { "extensions": ["./src/tier-b/pi.ts"] },
  "omp": { "extensions": ["./src/tier-b/omp.ts"] }
}
```

---

## 5. The core contract

Everything narrows to one pure function. No I/O, no process exit, no harness types.

```js
// src/core/index.mjs
/**
 * @param {{ tool: string, input: object, cwd: string }} call
 * @returns {{ blocked: boolean, reason?: string, rule?: string }}
 */
export function checkTool(call) { … }
```

Adapters are responsible only for **normalising the call** into that shape and
**translating the verdict** into their harness's dialect. All four harnesses name
their tools differently; normalisation is a lookup table in each adapter:

| Concept | Claude Code | Codex | Pi / omp |
|---|---|---|---|
| shell | `Bash` | `Bash` (incl. `exec_command`) | `bash` |
| read | `Read` | `read` | `read` |
| write | `Write` | `apply_patch` | `write` |
| edit | `Edit` | `apply_patch` | `edit` |
| glob | `Glob` | — | `glob` |

---

## 6. Adapter implementations

### Tier A — `src/tier-a/guard.cjs`

```js
#!/usr/bin/env node
const { checkTool } = require('@<org>/harness-kit/core');
try {
  const p = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  const v = checkTool({
    tool:  p.tool_name ?? p.toolName,
    input: p.tool_input ?? p.input ?? {},
    cwd:   p.cwd ?? process.cwd(),
  });
  if (v.blocked) { console.error(v.reason); process.exit(2); }   // universal block
} catch (e) { /* fail-open */ }
process.exit(0);
```

Wired identically on both harnesses:

```jsonc
// .claude/settings.json
{ "hooks": { "PreToolUse": [{ "matcher": "Bash|Read|Write|Edit|Glob",
  "hooks": [{ "type": "command", "command": "npx -y hk-guard" }] }] } }

// ~/.codex/hooks.json
{ "hooks": { "PreToolUse": [{ "command": "npx -y hk-guard" }] } }
```

### Tier B — `src/tier-b/shared.ts`

```ts
import { checkTool } from '@<org>/harness-kit/core';

export function install(pi: any) {
  pi.on('tool_call', (event: any, ctx: any) => {
    const v = checkTool({ tool: event.toolName, input: event.input, cwd: ctx.cwd });
    if (v.blocked) return { block: true, reason: v.reason };
  });
}
```

`pi.ts` and `omp.ts` are `export default (pi) => install(pi)`. They differ only in
which type package they import — and omp runs Pi-authored extensions through a
compatibility shim regardless, so a single file may well serve both. **Verify
during Milestone 1 whether we need two files or one.**

---

## 7. Fail-open, always

Every adapter wraps its entire body in try/catch and exits 0 / returns undefined
on any error. A crashed guardrail must never brick a session. Crashes append one
JSON line to `~/.harness-kit/crash.jsonl`; `hk doctor` surfaces them.

Rationale: a guardrail that hard-fails is worse than one that is briefly absent —
users disable the whole kit after one bad day.

---

## 8. Distribution

The kit is wired the same way at every maturity level; only the **source** of the
code changes. Phase 0 points the wiring at a local checkout, Phase 1 points it at
published artifacts. Nothing built in Phase 0 is discarded.

### 8.0 Phase 0 — local (us only)

No npm publish, no marketplace, no `npm link`. Symlinks and absolute paths only —
they avoid npm's global state and are trivially reversible.

| Harness | Wiring | Reload |
|---|---|---|
| Pi | symlink `~/.pi/agent/extensions/harness-kit.ts` → `<repo>/src/tier-b/pi.ts` | `/reload` |
| omp | symlink `~/.omp/agent/extensions/harness-kit.ts` → `<repo>/src/tier-b/omp.ts` | `/reload` |
| Claude Code | `~/.claude/settings.json` → `node <repo>/src/tier-a/guard.cjs` | next tool call |
| Codex | `~/.codex/hooks.json` → `node <repo>/src/tier-a/guard.cjs` | next tool call |

Applied by `scripts/dev-link.sh`, reversed by `scripts/dev-unlink.sh`.

Pi and omp auto-discover extensions in those directories, so the symlink is the
whole integration. Both process-tier harnesses re-exec the shim per tool call, so
an edit is live immediately.

**This loop is faster than the published one** — edit, reload, done; no publish, no
version bump, no cache invalidation. It stays the permanent dev environment even
after Phase 1 ships.

### 8.1 Phase 1 — published (other people)

**One npm package, four install paths.** The logic is never copied into a project;
only wiring is generated, and the wiring points into `node_modules`.

| Harness | Command | Files written into the project |
|---|---|---|
| Pi | `pi install npm:@<org>/harness-kit` | none — reads the `pi` key |
| omp | `omp plugin install @<org>/harness-kit` | none — reads the `omp` key |
| Claude Code | `hk init --harness claude` | `.claude/settings.json` (merged) |
| Codex | `hk init --harness codex` | `~/.codex/hooks.json` (merged) |

Consequence: `npm update @<org>/harness-kit` upgrades the guardrails **on all four
harnesses at once**, with no reinstall.

The only structural difference from Phase 0 is the path in the wiring —
`<repo>/src/...` becomes `npx -y hk-guard` / a `node_modules` resolution. The
adapters, the core, and the hook payloads are byte-identical.

### Optional: native plugin distribution (evaluate in Phase 2)

Claude Code and Codex both have marketplace systems whose plugin formats are
near-mirrors. Publishing a marketplace repo would drop Claude Code and Codex to
**zero generated files** too, at the cost of maintaining two manifests:

| | Claude Code | Codex |
|---|---|---|
| Manifest | `.claude-plugin/plugin.json` | `.codex-plugin/plugin.json` |
| Hooks | `hooks/hooks.json` | `hooks.json` (`"hooks": "./hooks.json"`) |
| Skills | `skills/` | `"skills": "./skills/"` |
| MCP | `.mcp.json` | `.mcp.json` / `mcpServers` |
| Path variable | `${CLAUDE_PLUGIN_ROOT}` | plugin-relative |
| Marketplace | `.claude-plugin/marketplace.json` | `.agents/plugins/marketplace.json` |
| Sources | git-subdir | local, git-subdir, **npm**, url |

Deferred: it is additive, and Phase 1 must not block on it.

---

## 9. Configuration

Single file, layered, JSON-schema validated. `~/.harness-kit.json` → project
`.harness-kit.json` → `.harness-kit.local.json`.

```jsonc
{
  "guardrails": {
    "secret":     { "enabled": true, "allow": ["*.example", "*.sample"] },
    "heavyPath":  { "enabled": true, "patterns": ["node_modules", "dist", ".git"] },
    "broadGlob":  { "enabled": true }
  },
  "harnesses": { "claude": true, "codex": true, "pi": true, "omp": true }
}
```

Read by `core/config.mjs` — identical on every harness. No per-harness config.

---

## 10. Update & ownership (Phase 1)

Generated wiring files are tracked in `~/.harness-kit/manifest.json` with a
checksum and an `ownership: kit | user` flag. `hk update` rewrites kit-owned files
whose checksum is unchanged, leaves user-modified files alone, and reports drift.

This matters far less than in a copy-based kit, because Phase 1 generates only two
small wiring files — everything substantive lives in `node_modules`.

Not needed in Phase 0: `dev-link.sh` owns the wiring outright and `dev-unlink.sh`
reverses it, so there is no drift to reconcile.

---

## 11. Known risks

| Risk | Mitigation |
|---|---|
| **omp release velocity** (v18, compiled binary, frequent releases) | Target only the documented extension event API; pin nothing internal; `hk doctor` version-checks |
| **Codex `permissionDecision: "allow"` validation** | Use exit-2 blocking exclusively in Phase 1 |
| **Codex hook events read from binary strings**, not public docs | Treat anything past `PreToolUse`/`PostToolUse`/`SessionEnd` as unverified until exercised |
| Tool-name drift across harnesses | Normalisation table in each adapter, covered by fixtures |
| Pi has no subagents | Scope agent content with `harnesses:` frontmatter (Phase 4+) |
| Guardrail bug blocks legitimate work | Fail-open + per-guardrail config kill switch + `hk doctor` |

---

## 12. Open questions

**Blocking Phase 0**

1. Does one `tier-b` file serve both Pi and omp, or are two needed? omp runs
   Pi-authored extensions through a compatibility shim, so one file may suffice.
   Step 3 of the Phase 0 sequence answers this.
2. Claude Code wiring at project (`.claude/settings.json`) or user
   (`~/.claude/settings.json`) level? Codex's `hooks.json` is user-level only, so
   user-level keeps Phase 0 symmetric; project-level is better for per-repo config
   later.
3. Repo layout: single package, or monorepo splitting `core` from adapters?
   Recommendation: single package until `core` gains an outside consumer.

**Blocking Phase 1, safe to defer**

4. Package name and npm scope.
5. Public or private npm — determines whether marketplace distribution is viable.
6. Native plugin/marketplace distribution, or npm-only? Pi and omp are free via
   package.json keys; Claude Code and Codex each cost a manifest to maintain.
