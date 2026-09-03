# harness-kit — Architecture

One authored kit, four coding-agent harnesses.

**Status:** Phase 0 implemented and wired locally. Not published.
**Last verified:** 2026-09-03, against the installed CLIs and by running real agents.

Companion documents: [SCOPE.md](./SCOPE.md) for phasing, [AGENTS.md](./AGENTS.md)
for orientation if you are picking this up cold.

---

## 1. Purpose

Package our guardrails, context injection, skills, and MCP wiring **once**, and run
them unmodified on Claude Code, Codex, Pi, and Oh-My-Pi (omp).

Non-goal: a lowest-common-denominator kit. Where a harness is more capable, the
adapter uses that capability; where it is less capable, it degrades explicitly and
visibly (`doctor` reports it), never silently.

That last word carries most of the weight. Every serious defect found so far has
been a silent one — a guardrail reporting itself active while absent. See §11.

---

## 2. Verified harness capabilities

Verified against installed CLIs, and — where marked — by running the agent and
observing what it actually does.

| | **Claude Code** `2.1.259` | **Codex** `0.146.0` | **Pi** `0.84.2` | **omp** `18.1.6` |
|---|---|---|---|---|
| Interception model | process hook | process hook | in-process ESM | in-process ESM |
| Hook config | `~/.claude/settings.json` → `hooks` | `~/.codex/hooks.json` | — (extensions) | — (extensions) |
| Can block a tool call | ✅ verified | ✅ | ✅ verified | ✅ verified |
| Extension registration | — | — | `pi install <path>` | `omp install <path>` |
| Plugin manifest | `.claude-plugin/plugin.json` | `.codex-plugin/plugin.json` | `package.json` `pi` key | `package.json` `omp` key |
| Marketplace manifest | `.claude-plugin/marketplace.json` | `.agents/plugins/marketplace.json` | — (npm/git direct) | — (npm/git direct) |
| npm as a source | via git/marketplace | ✅ native `npm:` source | ✅ | ✅ |
| Skills | ✅ native | ✅ (`"skills": "./skills/"`) | ✅ Agent Skills std. | ✅ |
| MCP | ✅ `.mcp.json` | ✅ `.mcp.json` / `mcpServers` | ✅ settings | ✅ `mcp.json` |
| Subagents | ✅ | ✅ | ❌ | ✅ |
| Rules file | `CLAUDE.md` | `AGENTS.md` | `AGENTS.md` | `RULES.md` + `rules/*.mdc` |

### 2.1 Hook events

Claude Code and Codex expose a near-identical event set.

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
`tool_result` (≈ PostToolUse), `before_agent_start` (≈ UserPromptSubmit),
`session_start` / `session_shutdown`, `context` (no Claude/Codex analogue).

The kit uses exactly two: **`PreToolUse` / `tool_call`** and
**`UserPromptSubmit` / `before_agent_start`**.

### 2.2 Hook wire format

Both process-tier harnesses read JSON on stdin and accept a JSON response on
stdout under `hookSpecificOutput`.

**Divergence:** Codex reserves `permissionDecision: "allow"` for responses that
also supply `updatedInput`. A bare `"allow"` can trip its hook validation.

**Therefore the universal contract is the exit code, not the JSON:**

| Outcome | Universal mechanism | Works on |
|---|---|---|
| Allow | `exit 0`, no stdout | Claude Code, Codex |
| **Block** | **`exit 2`, reason on stderr** | **Claude Code, Codex** |
| Inject context | `hookSpecificOutput.additionalContext` | Claude Code, Codex |

One shim, byte-identical, no per-harness branching in the blocking path.

---

## 3. The core insight: two tiers, not four adapters

```
                    ┌─────────────────────────────┐
                    │      core/  (pure ESM)      │
                    │  no harness imports at all  │
                    │  checkTool() · buildContext │
                    └──────────┬──────────────────┘
                               │
             ┌─────────────────┴──────────────────┐
             ▼                                    ▼
   ┌───────────────────────┐         ┌────────────────────────┐
   │ Tier A — process hook │         │ Tier B — extension     │
   │ stdin JSON → exit 0|2 │         │ pi.on("tool_call", …)  │
   ├───────────────────────┤         ├────────────────────────┤
   │ Claude Code           │         │ Pi                     │
   │ Codex                 │         │ omp                    │
   └───────────────────────┘         └────────────────────────┘
```

Tier A is 69 lines; Tier B is 48, plus two entry points of a dozen lines each.
Everything else is shared.

**Answered:** one Tier B implementation serves both Pi and omp (`shared.mjs`);
`pi.mjs` and `omp.mjs` are thin re-exports differing only in a crash-log label.
They are kept separate so future divergence has a home.

---

## 4. Package layout

Actual, as built.

```
harness-kit/
├── package.json              exports + "pi" key + "omp" key; zero dependencies
├── AGENTS.md                 read this first if you are new here
├── src/core/                 ← all logic; no harness imports anywhere
│   ├── index.mjs             checkTool() — the single entry point
│   ├── normalize.mjs         four payload dialects → one canonical shape
│   ├── bash.mjs              shell analysis; the hardest file in the repo
│   ├── config.mjs            defaults ← global ← project ← local
│   ├── context.mjs           the non-blocking half of hooks
│   ├── log.mjs               fail-open crash breadcrumbs
│   └── guardrails/           secret · heavy-path · broad-glob
├── src/tier-a/guard.mjs      Claude Code + Codex
├── src/tier-b/               shared.mjs + pi.mjs + omp.mjs
├── test/                     203 tests, node --test, no framework
└── scripts/                  doctor · replay · dev-link · dev-unlink
```

**`.mjs` throughout, not `.cjs` + `.ts`.** Both process harnesses run
`node <file>`, so CJS buys nothing; Pi and omp load `.ts/.js/.mjs/.cjs`, so plain
ESM means no build step and no type packages in Phase 0.

### package.json keys that matter

```jsonc
{
  "exports": {
    "./core":  "./src/core/index.mjs",
    "./guard": "./src/tier-a/guard.mjs",
    "./pi":    "./src/tier-b/pi.mjs",
    "./omp":   "./src/tier-b/omp.mjs"
  },
  "pi":  { "extensions": ["./src/tier-b/pi.mjs"] },
  "omp": { "extensions": ["./src/tier-b/omp.mjs"] }
}
```

The `pi` and `omp` keys are **load-bearing in Phase 0**, not Phase 1 packaging
metadata — see §8.0.

---

## 5. The core contract

```js
/**
 * @param {object} payload  Raw hook/event payload from ANY harness, unmodified.
 * @param {object} [opts]   { cwd, config, overrides }
 * @returns {{ blocked: boolean, guardrail?, rule?, target?, reason? }}
 */
export function checkTool(payload, opts = {})
```

Adapters do not normalise. They hand the raw payload straight through, and
`normalize.mjs` owns every dialect. This is deliberate: normalisation logic in
two adapters drifts, and the drift is silent.

Guardrails are pure `check(call, config) → null | verdict`. No harness imports,
no `process.exit`, no stdout.

---

## 6. Payload normalisation — where the bodies are buried

This section exists because **four of the six defects found so far were the same
mistake**: assuming a payload shape instead of capturing it.

A tool whose shape the normaliser does not recognise is **not a safe default**.
It becomes `KIND.OTHER` with no paths, every guardrail sees nothing, the call
passes, and `doctor` still reports "wired".

### Shapes actually observed

| Concept | Claude Code | Codex | Pi | omp |
|---|---|---|---|---|
| shell | `Bash` `{command}` | `shell` `{command}` | `bash` `{command}` | `bash` `{command}` |
| read | `Read` `{file_path}` | `read` `{path}` | `read` `{path}` | `read` `{path}` |
| edit | `Edit` `{file_path}` | `apply_patch` `{input}` | `edit` `{path,…}` | `edit` `{input}` **hashline** |
| glob | `Glob` `{pattern,path}` | — | `glob` `{pattern}` | `glob` `{path}` ← pattern in `path` |
| grep | `Grep` `{pattern,path}` | — | `grep` `{pattern,path}` | `grep` `{pattern,path,case,gitignore}` |

Two of those cost real bugs:

**omp's hashline editor** sends the whole patch as one `input` string with the
target named inside it and no path field at all:

```
*** Begin Patch
[README.md#F613]
PUT 3.=3:
+some text now
*** End Patch
```

`normalize()` returned `paths: []` for every omp edit. Editing `.env` was
invisible. Patch bodies are now parsed for targets in three formats: hashline
`[path#F123]`, apply_patch `*** Update File:`, unified diff `+++ b/path`. Only
`input`/`patch`/`diff`/`edits` are scanned — `content` and `text` hold whole
files on a Write, and a document quoting a diff would name paths nobody touches.

**omp's glob** carries the pattern in `path` with no `pattern` field, so
`broadGlob` never fired on omp while working everywhere else. The path is split
at its first wildcard segment so `src/**/*.ts` reaches the guardrail as pattern
`**/*.ts` under searchPath `src` — the pair every other harness sends.

### Capture, do not guess

Before trusting any harness, capture its tools:

```js
// load with `omp -e spy.mjs` / `pi -e spy.mjs`
export default function (pi) {
  pi.on('tool_call', (e) => console.error(e.toolName, Object.keys(e.input ?? {})));
}
```

**Codex is the remaining unverified surface.** Its Tier A payloads have only
ever been synthetic here. Spy on a real Codex session before treating the
dogfood as covering all four.

---

## 7. What the guardrails actually enforce

| Guardrail | Concern | Fires on |
|---|---|---|
| `secret` | credentials entering model context | any access — reading, copying, editing |
| `heavyPath` | context economy | **unbounded** reads only |
| `broadGlob` | context economy | broad pattern **and** root-ish search path |

The distinction between the first two is load-bearing and easy to erase by
accident:

- `secret` uses **permissive** path extraction and no bounded-read filter.
  Copying a `.env` is an exfiltration risk even though it prints nothing, and
  `find . -name .env -exec cat` reaches it through a second command.
- `heavyPath` uses **role-aware** extraction and only fires on unbounded reads.
  `rm -rf dist` costs no context. `ls node_modules/ws/package.json` prints one
  line. `sed -n '30,60p'` prints thirty. Blocking those is noise; blocking
  `ls node_modules` and `cat dist/bundle.js` is the job.

### A word's role, not its spelling

`bash.mjs` is the largest file in `core/` because deciding *which strings in a
command are paths* is the whole problem. Every heavy-path blocklist entry —
`build`, `dist`, `out`, `target`, `coverage` — is also an ordinary English word
and a common search term.

```
grep -rn "build" src            "build" is the search term, not a directory
grep -vE "node_modules|dist/"   an exclusion; blocked for naming what it excludes
find . -name .git -type d       a predicate value, not a path
echo "checking build output"    prose
```

Treating every operand as a path blocked **1 in 25** real calls. Extraction is
now command-aware: quote-respecting tokenizer, heredoc bodies dropped,
per-family flag sets (`-c` is *count* to grep and *comment* to git), and the
pattern operand of `grep`/`sed`/`awk` skipped.

The same mistake survived separately in the structured-tool path: both
guardrails read a Grep tool's `pattern` field as a path, so searching *for* the
word `build` was blocked as reading a `build` directory. `pattern` is now
consulted only for non-GREP kinds — a glob names files, a grep pattern does not.

---

## 8. Distribution

The kit is wired the same way at every maturity level; only the **source** of
the code changes. Nothing built in Phase 0 is discarded.

### 8.0 Phase 0 — local (us only)

| Harness | Wiring | Reload |
|---|---|---|
| Claude Code | `~/.claude/settings.json` → append to `hooks.PreToolUse` | restart |
| Codex | `~/.codex/hooks.json` → append to `hooks.PreToolUse` | restart |
| Pi | `pi install <repo>` — registers in settings, links the checkout | `/reload` |
| omp | `omp install <repo>` — same | `/reload` |

Applied by `scripts/dev-link.sh --apply`, reversed by `scripts/dev-unlink.sh --apply`.
Both are dry-run by default and idempotent.

> **Do not drop a symlink into `~/.pi/agent/extensions/` or
> `~/.omp/agent/extensions/`.** Neither agent scans those paths. An earlier
> version of `dev-link.sh` did exactly that; the directory existed only because
> the script created it, `pi list` reported "No packages installed", omp read a
> `.env` unimpeded — and `doctor` reported "wired", because it was looking for
> the symlink it had just made. Registration goes through each agent's own
> package manager, and `doctor` now asks `pi list` / `omp plugin list` rather
> than inspecting the filesystem.

Tier A entries are **appended** with `jq`, never assigned. Both files carry other
hooks in practice; clobbering them is the one unrecoverable installer mistake.
Uninstall filters the array by command path so hooks added later survive.

Because Tier B registration links the checkout rather than copying it, and Tier A
re-execs the shim per tool call, an edit to `core/` is live everywhere with no
re-link — at most a `/reload`.

### 8.1 Phase 1 — published (other people)

**One npm package, four install paths.** Logic is never copied into a project;
only wiring is generated, pointing into `node_modules`.

| Harness | Command | Files written into the project |
|---|---|---|
| Pi | `pi install npm:@<org>/harness-kit` | none — reads the `pi` key |
| omp | `omp plugin install @<org>/harness-kit` | none — reads the `omp` key |
| Claude Code | `hk init --harness claude` | `~/.claude/settings.json` (merged) |
| Codex | `hk init --harness codex` | `~/.codex/hooks.json` (merged) |

The only structural change from Phase 0 is the path in the wiring. Adapters,
core, and payload handling are byte-identical.

### Optional: native plugin distribution (evaluate in Phase 2)

Claude Code and Codex marketplace formats are near-mirrors. Publishing a
marketplace repo would drop both to zero generated files, at the cost of two
manifests. Additive; Phase 1 must not block on it.

---

## 9. Configuration

Single file, layered: `~/.harness-kit.json` → project `.harness-kit.json` →
`.harness-kit.local.json`. Read by `core/config.mjs`, identical on every
harness. **No per-harness configuration exists anywhere in the kit.**

```jsonc
{
  "guardrails": {
    "secret":    { "enabled": true, "allow": ["fixtures/*"] },
    "heavyPath": { "enabled": true, "patterns": ["node_modules", "dist"], "allow": [] },
    "broadGlob": { "enabled": true }
  }
}
```

Config is read per call, so a change takes effect on the next tool call with no
restart. That makes it the emergency off-switch:

```bash
echo '{"guardrails":{"heavyPath":{"enabled":false}}}' > ~/.harness-kit.json
```

`HK_NO_GLOBAL_CONFIG=1` stops the loader reading `~`; the test suite sets it so
runs are hermetic.

---

## 10. Fail-open, always

Three independent layers catch errors and allow: `index.mjs`, `guard.mjs`,
`shared.mjs`. A crash appends one JSON line to `<kit>/.local/crash.jsonl`
(`HK_LOG_DIR` overrides; Phase 1 moves it to `~/.harness-kit/`) and the call
proceeds. `doctor` replays the log.

Rationale, and it is a product decision rather than a coding habit: a guardrail
that hard-fails is worse than one briefly absent, because users disable the
whole kit after one bad day. Failing open is worth more than the calls it lets
through.

Note the limit — fail-open covers *crashes*, not *correct-but-wrong blocks*. For
those the config kill switch is the escape hatch.

---

## 11. Known risks

| Risk | Mitigation |
|---|---|
| **Silent absence** — a guardrail reporting active while never loading | `doctor` asks each agent's package manager, never the filesystem; live block test per harness before trusting a wiring change |
| **Unrecognised tool shape** — new tool ⇒ `KIND.OTHER` ⇒ no guardrail | Capture payloads with the spy extension (§6) before trusting; `test/tool-shapes.test.mjs` pins real captures |
| **Replay blind spots** — a clean rate on paths a corpus never exercised | `replay.mjs` lists in-scope tools the corpus never hit and says the rate is silent about them |
| **False positives** | Role-aware extraction; bounded-read rule; replay against real history after every guardrail change |
| **Context injection causing pre-emptive refusal** | The injected text must not name the guardrails — see below |
| **omp release velocity** (compiled binary, frequent releases) | Target only the documented extension event API; `doctor` version-checks |
| **Codex payloads never captured live** | Spy on a real Codex session before Phase 1 |
| **Codex `permissionDecision: "allow"` validation** | Exit-2 blocking exclusively |

### The injected-context trap

An earlier `context.mjs` listed the active guardrails
(`"Guardrails active: secret, heavyPath, broadGlob"`). Agents then **simulated**
the rules instead of relying on them: asked to run `grep -rn "build" src`, omp
saw the word `build`, concluded heavy-path would object, and refused. Its own
thought line read *"Reporting blocked command due to build path"*. Nothing had
blocked it.

That failure is worse than a false block: no hook fires, nothing is logged, no
reason is shown, and the work silently does not happen. The injected text now
says a hook exists, says what a block looks like, and tells the agent **not to
anticipate one**. Do not reintroduce guardrail names there.

---

## 12. Open questions

**Resolved during Phase 0**

- One Tier B file serves both Pi and omp. ✅ (`shared.mjs`)
- Claude Code wiring at user level, matching Codex, keeping Phase 0 symmetric. ✅
- Single package, not a monorepo. ✅ Split only if `core` gains an outside consumer.

**Still open — blocking Phase 1**

1. Package name and npm scope.
2. Public or private npm — determines whether marketplace distribution is viable.
3. Native plugin/marketplace distribution, or npm-only? Pi and omp are free via
   package.json keys; Claude Code and Codex each cost a manifest.
4. Whether `heavyPath` should allow `cat` of a single small file inside a
   generated tree. `cat` is unbounded by definition and guardrails do not touch
   the disk, so it stays blocked today; `heavyPath.allow` is the escape hatch.
   Revisit if it proves annoying in practice.
