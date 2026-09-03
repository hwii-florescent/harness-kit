# BACKLOG.md — open problems, with the evidence for each

Work identified but not yet done. Every claim here was read off a shipping
artifact or demonstrated by running code; the command that proves each one is
included so it can be re-checked rather than believed.

Companion to [EVIDENCE.md](./EVIDENCE.md) (what is verified vs assumed) and
[AGENTS.md](./AGENTS.md) (traps).

**Nothing in this file is implemented.**

---

## 1. A block must be overridable by user approval

### The requirement

If the user tells the agent to do the thing, the guardrail must get out of the
way. "Read `.env` for me", "read `package.json` so you know what to install" —
these are legitimate instructions, and today the kit refuses them with no way
through short of editing a config file. This applies to **every** guardrail and
hook in the kit, not just `secret`.

### Why it cannot work today

The verdict is a pure function of the payload and the config. There is no
channel through which user intent could reach it.

```
src/core/index.mjs:36    checkTool(payload, opts)   opts = { cwd, config, overrides }
src/tier-a/guard.mjs:22  EXIT_ALLOW = 0 / EXIT_BLOCK = 2 — the only two outcomes
src/tier-b/shared.mjs:23 pi.on('tool_call', (event, ctx) => …) — synchronous;
                         returns { block: true, reason } or undefined
```

The handler never sees the conversation, so telling the agent "I approve this"
changes nothing: the agent retries, the hook re-runs on the same payload, and
the same block comes back. The agent cannot grant the exemption either — the
hook is out-of-process on Tier A and, on Tier B, it runs before the tool and
ignores anything the model says.

Verify: `grep -n 'checkTool(' src/core/index.mjs src/tier-*/*.mjs`

### What each harness natively supports

All four already have an approval channel. None of them is currently used.

**Claude Code 2.1.259** — proven from the shipping binary's own embedded docs:

```
hookSpecificOutput:
  permissionDecision      "allow", "deny", or "ask"   (PreToolUse only)
  permissionDecisionReason
  updatedInput            modified tool input          (PreToolUse only)
systemMessage             message displayed to the user
```

`"ask"` is the mechanism this requirement wants: it hands the decision to the
user instead of refusing. Claude Code also supports `prompt` and `agent` hook
types alongside `command`, and a separate `PermissionRequest` event.

Verify:
```bash
B=~/.local/share/claude/versions/2.1.259
strings -n 6 "$B" | grep -m 1 -B 25 -A 20 '`permissionDecision` - "allow", "deny", or "ask"'
```

**Codex 0.146.0** — the schema and the runtime disagree, and the runtime wins.
The embedded JSON schema `pre-tool-use.command.output` defines
`PreToolUsePermissionDecisionWire` as `["allow","deny","ask"]`, but the binary
carries these rejection strings:

```
PreToolUse hook returned unsupported permissionDecision:ask
PreToolUse hook returned unsupported permissionDecision:allow
PreToolUse hook returned updatedInput without permissionDecision:allow
PreToolUse hook returned permissionDecision:deny without a non-empty permissionDecisionReason
PreToolUse hook exited with code 2 but did not write a blocking reason to stderr
```

So on Codex: **`ask` is not available**, `allow` is accepted only when it
carries `updatedInput`, `deny` requires a reason, and exit 2 + stderr is a
supported block. This confirms the reasoning already recorded at
`src/tier-a/guard.mjs:10-13` — that comment was correct.

Codex has a distinct `PermissionRequest` hook event (present in the live
`~/.codex/hooks.json`, with `PermissionRequestDecisionWire` /
`PermissionRequestBehaviorWire` in the binary). Whether it can be used to
approve a PreToolUse block is **not established** — its `updatedInput`,
`updatedPermissions` and `interrupt:true` are all listed as unsupported in this
version. Investigate before designing around it.

Verify:
```bash
CB=~/.codex/packages/standalone/current/bin/codex
strings -n 6 "$CB" | grep -m 12 'permissionDecision'
strings -n 4 "$CB" | grep -m 1 -B 30 -A 40 '"permissionDecision": {'
```

**Pi 0.84.2** — proven from its shipped docs, `docs/extensions.md`:

```typescript
const ok = await ctx.ui.confirm("Delete?", "This cannot be undone");
const choice = await ctx.ui.select("Pick one:", ["A", "B", "C"]);
// both accept { timeout: ms }; on timeout confirm() returns false,
// select() returns undefined
```

Three further facts from the same document, all load-bearing for a design:

- The `tool_call` handler **may be async**, so it can await a dialog.
- `event.input` is **mutable**, and "mutations to `event.input` affect the
  actual tool execution" — so an approved call could be narrowed rather than
  merely allowed.
- `ctx.hasUI` is **false in print mode (`-p`) and JSON mode**. The docs say to
  guard `select`, `confirm`, `input` and `editor` with it. **There is no
  interactive approval in a headless run.**

Verify: `sed -n '/^## Custom UI/,+40p' \
  /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`

**omp 18.1.6** — the same surface, proven from the binary. Inside
`initHooksAndCustomTools()`:

```js
select:    (r, i, a) => this.showCollabAwareSelector(r, i, a),
confirm:   (r, i, a) => this.showHookConfirm(r, i, a),
input:     (r, i, a) => this.showHookInput(r, i, a),
askDialog: (r, i)    => this.showAskDialog(r, i),
notify:    (r, i)    => this.showHookNotify(r, i),
```

The `showHook*` naming and the enclosing function name establish that this
dialog surface exists **for hooks and extensions specifically**. omp also has
`ctx.hasUI` (`t?.hasUI === true && t.ui !== undefined`) and an extra
`askDialog` that pi does not document.

Verify:
```bash
strings -n 5 ~/.local/bin/omp | grep -m 1 -B 6 -A 14 'confirm: ('
```

### Constraints any design must respect

These are consequences of the facts above, not opinions:

1. **Codex cannot ask.** Three harnesses can prompt; Codex must be served some
   other way — a config grant, a pre-authorised list, or leaving it strict.
2. **No prompting in headless runs.** `ctx.hasUI` is false under `-p`, which is
   exactly how the smoke tests in AGENTS.md run. An approval design must have a
   defined non-interactive behaviour, and "fail open" and "fail closed" are
   different products.
3. **The conversation is not visible to the hook.** The only user-intent signal
   in the payload is Codex's `permission_mode`
   (`"default" | "acceptEdits" | "plan" | "dontAsk" | "bypassPermissions"`,
   a required field — see §3), plus `transcript_path`.
4. **Reading the transcript to infer approval is a prompt-injection surface.**
   `transcript_path` is a required Codex field, so a hook *could* read back the
   conversation and look for the user granting permission. But the transcript
   contains model-authored text, so anything that greps it for approval can be
   talked into approving itself. If this route is taken, only genuine user turns
   may count, and that boundary must be proven from the transcript format, not
   assumed.
5. **An approval must be scoped and expire.** "This time" and "always" are
   different grants, and a grant that silently persists is the failure mode
   `AGENTS.md` already warns about with the `~/.harness-kit.json` off-switch.

### Open questions

- Does a grant live in memory (per session) or on disk (per project)? Tier A is
  a fresh process per call and can hold nothing in memory — see §2.
- Is the unit of approval the exact payload, the path, or the rule that fired?
- Does an approval on one harness carry to another? (Nothing shares state today.)
- What happens on Codex, where no prompt is possible?

---

## 2. The documented escape hatch is a no-op on Pi and omp

**This is a proven bug, not a design question.**

`src/core/config.mjs:43` memoises the merged config in a module-level `Map`
keyed by cwd, with no mtime check and no TTL. `clearConfigCache()` at
`config.mjs:89` is exported and documented as a "test helper", but **nothing
calls it** — not `src/`, not `scripts/`, not the test suite. There is currently
no way, anywhere in the kit, to make a running process re-read its config.

The tests do not need it because they pass `overrides`, which `loadConfig`
applies *after* the cache lookup (`config.mjs:85`), so the stale-cache path is
never exercised by `npm test`. That is why 215 passing tests say nothing about
this bug.

Verify: `grep -rn 'clearConfigCache' src/ scripts/ test/`   (one hit: the definition)

The consequence differs by tier, because the tiers differ in process lifetime:

| Tier | Process | Effect of editing `~/.harness-kit.json` mid-session |
|---|---|---|
| A — Claude Code, Codex | fresh `node` per tool call | takes effect on the next call |
| B — Pi, omp | one long-lived process per session | **no effect until `/reload` or restart** |

Demonstrated:

```
before config written : BLOCK
after  config written : BLOCK   <- same long-lived process (Tier B)
fresh process         : allow   <- Tier A does this per tool call
```

Reproduce by calling `checkTool` twice in one process with a `.harness-kit.json`
written between the calls.

Two documentation claims are therefore wrong for half the harnesses:

- `AGENTS.md:42` — "The escape hatch, effective on the next tool call with no restart"
- `README.md:180` — "effective on the next tool call — no restart, no config surgery"

This also directly constrains §1: **any override stored in the config file is
invisible to a running Pi or omp session** until the cache problem is fixed.
Fixing it is a prerequisite, not a follow-up.

Candidate fixes: stat the config files and invalidate on mtime change; drop the
cache entirely and measure whether it matters; or expose an explicit
invalidation the Tier B adapter calls per tool call.

---

## 3. Codex: envelope now proven, live behaviour still unobserved

`EVIDENCE.md` recorded Codex as wholly assumed. That is now **partly out of
date** — the payload contract has been verified from the shipping binary's
embedded JSON schema, `pre-tool-use.command.input`:

```
required: cwd, hook_event_name, model, permission_mode, session_id,
          tool_input, tool_name, tool_use_id, transcript_path, turn_id
hook_event_name : const "PreToolUse"
tool_name       : string
tool_input      : any
permission_mode : "default" | "acceptEdits" | "plan" | "dontAsk" | "bypassPermissions"
```

This **confirms the assumption at `src/core/normalize.mjs:9`** — Codex does send
`tool_name` and `tool_input` at the top level with `cwd` and `hook_event_name`,
which is what the normaliser expects. The guess was right.

Verify:
```bash
strings -n 4 ~/.codex/packages/standalone/current/bin/codex \
  | grep -m 1 -B 78 '"title": "pre-tool-use.command.input"'
```

What remains unverified for Codex:

- **No end-to-end run has ever been observed.** That the hook fires, that exit 2
  actually blocks the call, and that the reason reaches the user are all still
  inferred. `SCOPE.md` acceptance criterion 1 stays open.
- The `PermissionRequest` event's usable surface (see §1).

The capture recipe in `EVIDENCE.md` still applies and is still worth running —
it is now a check of *behaviour* rather than of *shape*.

---

## 4. Shell variables are invisible to the guardrail

`heavyPath` and `secret` inspect the command string as written, before the shell
expands anything. `ls "$PI/dist"` is tokenised as the literal `$PI/dist`, so a
variable that expands into `node_modules` is never seen.

This produces both directions of error, and makes a verdict depend on whether
the agent happened to inline a path or use a variable — which is stylistic.

Deliberately **not** fixed: resolving expansions correctly means reimplementing
shell semantics (`$(…)`, `${VAR:-…}`, `~`, arrays, `eval`) from an environment
the hook cannot fully observe, and getting it 90% right yields a guardrail that
is confidently wrong rather than visibly limited.

Exposure is bounded: `secret` runs permissively across all commands and matches
on basenames, and the cost of a `heavyPath` miss is a larger context window, not
a leaked credential.

**Action: document as a known limit in AGENTS.md** so it is not rediscovered.
