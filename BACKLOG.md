# BACKLOG.md — open problems, with the evidence for each

Work identified but not yet done. Every claim here was read off a shipping
artifact or demonstrated by running code; the command that proves each one is
included so it can be re-checked rather than believed.

Companion to [EVIDENCE.md](./EVIDENCE.md) (what is verified vs assumed) and
[AGENTS.md](./AGENTS.md) (traps).

**Every open item below is unresolved. Implemented behavior is described only to
define the boundary of the remaining work.**

---

## 1. Codex approval remains an open issue

The core decision is implemented, and Claude Code, Pi, and omp now expose a
one-shot approval path at their adapter boundary:

- Claude Code's interactive/default `PreToolUse` response is
  `permissionDecision:"ask"`.
- Pi and omp use `await ctx.ui.confirm(...)` only when `ctx.hasUI === true`.
- A declined, cancelled, timed-out, headless, or Codex call remains blocked.
- Persistent exceptions use `guardrails.secret.allow`,
  `guardrails.heavyPath.allow`, or `enabled:false` on the guardrail that fires.

Codex is the unresolved case, not a reason to weaken the other three.

### Codex 0.146.0 facts

The installed runtime rejects `permissionDecision:"ask"` from a `PreToolUse`
command hook even though its embedded output schema lists `"ask"`:

```
PreToolUse hook returned unsupported permissionDecision:ask
PreToolUse hook returned unsupported permissionDecision:allow
PreToolUse hook returned updatedInput without permissionDecision:allow
PreToolUse hook exited with code 2 but did not write a blocking reason to stderr
```

Codex also exposes a distinct `PermissionRequest` event, but this does not
provide a proven way to force a user decision for an arbitrary guardrail
verdict from `PreToolUse`. Its documented decision fields include unsupported
combinations in this version, so the kit does not synthesize or route through
that event.

The hook intentionally ignores `transcript_path`. It is an unstable,
model-authored conversation surface and is not an authenticated approval
channel; reading it would create a prompt-injection path.

### Current decision

Keep Codex strict: exit 2 with the actionable reason on stderr and no stdout.
Do not emit `permissionDecision:"ask"` or infer approval from a transcript.
Until Codex documents and demonstrates a usable approval channel, users who
explicitly authorize a blocked operation must use configuration:

```json
{
  "guardrails": {
    "secret": { "allow": ["fixtures/*"] },
    "heavyPath": { "allow": ["vendor"] },
    "broadGlob": { "enabled": false }
  }
}
```

Verify the runtime facts:

```bash
CB=~/.codex/packages/standalone/current/bin/codex
strings -n 6 "$CB" | grep -m 12 'permissionDecision'
strings -n 4 "$CB" | grep -m 1 -B 30 -A 40 '"permissionDecision": {'
```

---

## 2. Codex: envelope now proven, live behaviour still unobserved

The Codex payload envelope and decision contract are proven from the shipping
binary. Live hook execution remains unobserved:

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
- The `PermissionRequest` event's usable approval surface in a future release
  (see §1).

The capture recipe in `EVIDENCE.md` still applies and is still worth running —
it is now a check of *behaviour* rather than of *shape*.

---

## 3. Shell variables are invisible to the guardrail

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
