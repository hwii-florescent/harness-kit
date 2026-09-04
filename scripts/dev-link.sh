#!/usr/bin/env bash
#
# Wire this checkout into every harness on THIS machine, in one command.
#
#   Tier A (Claude Code, Codex)  a PreToolUse entry appended to their JSON config
#   Tier B (Pi, omp)             registered via `pi install` / `omp install`
#
# Everything it writes is OUTSIDE the repo. It is a dry run unless you pass
# --apply, it backs up every file it edits, and it is idempotent — re-running it
# on an already-wired harness does nothing. Idempotence for Tier A is checked
# per hook event (see wire_tier_a below), so adding a new required event later
# still installs it even on a machine that was already wired for an older one.
#
# Reverse it with scripts/dev-unlink.sh.
#
# Usage:
#   bash scripts/dev-link.sh                  # show what would change
#   bash scripts/dev-link.sh --apply          # change it
#   bash scripts/dev-link.sh --apply --only pi,omp
#
# Requires jq for Tier A. Tier B uses each agent's own package manager.

set -euo pipefail

KIT="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The exact path substring that marks a hook entry as this kit's own, shared
# with dev-unlink.sh's removal filter and doctor.mjs. A plain "contains $KIT"
# test is a path-prefix false positive across sibling worktrees (e.g.
# ../bristleworm and ../bristleworm-2, one a strict prefix of the other) —
# matching the guard script's full path is unambiguous.
GUARD_PATH="$KIT/src/tier-a/guard.mjs"
GUARD="node \"$GUARD_PATH\""

# Claude Code dispatches on tool name, so scope the hook rather than paying a
# process spawn on tools the kit has no opinion about. Codex entries carry no
# matcher; unknown tools normalise to KIND.OTHER and are allowed immediately.
MATCHER="Bash|Read|Write|Edit|MultiEdit|NotebookEdit|Glob|Grep"

# Print the header comment (everything between the shebang and the first
# blank/code line) as --help text. Range-independent so a header that grows
# or shrinks never silently truncates the output the way a hardcoded
# `sed -n 'N,Mp'` line range did.
print_help() {
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$1"
}

APPLY=0
ONLY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --only)  ONLY="${2:-}"; shift ;;
    --only=*) ONLY="${1#*=}" ;;
    -h|--help) print_help "${BASH_SOURCE[0]}"; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 64 ;;
  esac
  shift
done

# ── output ──────────────────────────────────────────────────────────────────

if [[ -t 1 ]]; then
  DIM=$'\033[2m'; GRN=$'\033[32m'; YLW=$'\033[33m'; RED=$'\033[31m'; RST=$'\033[0m'
else
  DIM=""; GRN=""; YLW=""; RED=""; RST=""
fi

say()  { printf '  %s\n' "$*"; }
ok()   { printf '  %s%s%s %s\n' "$GRN" "●" "$RST" "$*"; }
skip() { printf '  %s○ %s%s\n' "$DIM" "$*" "$RST"; }
warn() { printf '  %s!%s %s\n' "$YLW" "$RST" "$*"; }
fail() { printf '  %s✗%s %s\n' "$RED" "$RST" "$*"; }
plan() { if [[ $APPLY -eq 1 ]]; then ok "$*"; else printf '  %swould:%s %s\n' "$DIM" "$RST" "$*"; fi; }

CHANGED=0
FAILED=0

selected() {
  [[ -z "$ONLY" ]] && return 0
  [[ ",$ONLY," == *",$1,"* ]]
}

have() { command -v "$1" >/dev/null 2>&1; }

backup() {
  local f="$1" b
  # mktemp both picks a name unique enough to survive a link+unlink within the
  # same second (plain second-granularity timestamps collide, and `cp -p`
  # with no `-n` would then silently overwrite the earlier backup) and creates
  # it atomically, so there is no race between choosing the name and using it.
  b="$(mktemp "$f.harness-kit-bak.$(date +%Y%m%d%H%M%S).XXXXXX")"
  cp -p "$f" "$b"
  say "$DIM  backup: $b$RST"
}

# One backup per file per run, however many hook events end up being appended
# to it. Without this, wiring two events to the same file in one --apply would
# take a second backup of the file this run already edited, instead of a
# backup of what the user actually had before this run touched anything.
BACKED_UP=""
backup_once() {
  local f="$1"
  case ",$BACKED_UP," in
    *",$f,"*) return 0 ;;
  esac
  BACKED_UP="$BACKED_UP,$f"
  backup "$f"
}

# Likewise, don't repeat a "not installed" line for the same harness just
# because it is wired for more than one hook event.
REPORTED_MISSING=""
report_missing_once() {
  local key="$1" name="$2"
  case ",$REPORTED_MISSING," in
    *",$key,"*) return 0 ;;
  esac
  REPORTED_MISSING="$REPORTED_MISSING,$key"
  skip "$name — not installed"
}

# ── Tier A: Claude Code, Codex ──────────────────────────────────────────────
#
# Both already ship other PreToolUse hooks in practice, so this APPENDS to the
# array rather than assigning it. Clobbering a user's existing hooks is the one
# unrecoverable mistake an installer can make.
#
# Idempotence is checked per hook event, not by grepping the whole file for
# $KIT. "Does $KIT appear anywhere in this file" is true the moment ANY event
# is wired, so a later change that requires a second event (e.g. Stage 3's
# UserPromptSubmit hook) would forever read as "already wired" / "Nothing to
# do" and could never be installed on a machine wired for an earlier version.
# Checking `.hooks[$event]` specifically means each event is judged on its own,
# so wire_tier_a can be called once per (harness, event) pair below, and a new
# event is added by adding one more call — this function does not change.
#
# jq is already required to write Tier A config at all (see the check below),
# so the idempotence check leans on it too rather than approximating with grep.
# It matches on $GUARD_PATH, not $KIT (see its definition above) — a plain
# substring of $KIT is a path-prefix false positive across sibling worktrees.
#
# Every shape under `.hooks[$event]` is type-guarded before `contains()`: a
# neighbouring entry that is a bare string/number, a non-string `command`, a
# `hooks` item that is a string, or an array where a string was expected must
# read as "doesn't match" rather than make jq itself error. `jq -e` degrades
# any such error to exit 5, which the surrounding `if` treats identically to
# "false" — so an ungated crash here reads as "not wired" and this function
# appends a duplicate entry on every single run.

wire_tier_a() {
  local key="$1" name="$2" bin="$3" file="$4" event="$5" entry="$6"

  selected "$key" || return 0

  if ! have "$bin"; then
    report_missing_once "$key" "$name"
    return 0
  fi

  if ! have jq; then
    fail "$name — jq is required for Tier A (brew install jq)"
    FAILED=1
    return 0
  fi

  # An unparseable config is not ours to repair, and a rewrite would destroy it.
  if [[ -f "$file" ]] && ! jq -e . "$file" >/dev/null 2>&1; then
    fail "$name — $file is not valid JSON, left untouched"
    FAILED=1
    return 0
  fi

  if [[ -f "$file" ]] && jq -e --arg guard "$GUARD_PATH" --arg event "$event" '
        ((.hooks[$event] // []) | if type == "array" then . else [] end) | any(
          [ .command?, ((.hooks? // []) | .[]? | .command?) ]
            | map(select(type == "string") | contains($guard)) | any
        )
      ' "$file" >/dev/null 2>&1; then
    ok "$name — already wired ($event)"
    return 0
  fi

  plan "$name — append $event hook to $file"
  CHANGED=1
  [[ $APPLY -eq 1 ]] || return 0

  mkdir -p "$(dirname "$file")"
  if [[ -f "$file" ]]; then
    backup_once "$file"
  else
    printf '{}\n' > "$file"
    # The file this run just created has nothing worth restoring, but it must
    # still count as "handled" — otherwise a second event wired to the same
    # file in this run backs up the half-wired intermediate state instead of
    # skipping (there is no earlier real backup to defer to; see backup_once).
    BACKED_UP="$BACKED_UP,$file"
  fi

  local tmp
  tmp="$(mktemp)"
  if jq --arg cmd "$GUARD" --arg matcher "$MATCHER" --arg event "$event" "$entry" "$file" > "$tmp"; then
    mv "$tmp" "$file"
  else
    rm -f "$tmp"
    fail "$name — jq failed, $file unchanged"
    FAILED=1
  fi
}

# ── Tier B: Pi, omp ─────────────────────────────────────────────────────────
#
# Both register extensions through their own package manager, which records the
# entry in their settings and links the checkout under their plugin directory.
# The entry points come from the `pi` and `omp` keys in package.json.
#
# Those directories ARE auto-discovered, and symlinks ARE followed — but a loose
# file is only picked up when its name ends in `.ts` or `.js`. This script first
# linked `harness-kit.mjs`, which the filter skips in silence, so the guardrail
# never loaded — `pi list` reporting "No packages installed" while doctor
# reported "wired" was the tell. Manifest-declared paths skip that filter, which
# is why the package-manager route carries our `.mjs` entry points fine.

tier_b_installed() {
  case "$1" in
    pi)  pi list 2>/dev/null | grep -qF "$KIT" ;;
    omp) omp plugin list 2>/dev/null | grep -q 'harness-kit' ;;
  esac
}

wire_tier_b() {
  local key="$1" name="$2" bin="$3"

  selected "$key" || return 0

  if ! have "$bin"; then
    skip "$name — not installed"
    return 0
  fi

  if tier_b_installed "$key"; then
    ok "$name — already wired"
    return 0
  fi

  plan "$name — $bin install $KIT"
  CHANGED=1
  [[ $APPLY -eq 1 ]] || return 0

  if ! "$bin" install "$KIT" >/dev/null 2>&1; then
    fail "$name — $bin install failed"
    FAILED=1
  fi
}

# ── run ─────────────────────────────────────────────────────────────────────

printf '\n%sharness-kit%s dev-link  %s(%s)%s\n\n' "$GRN" "$RST" "$DIM" "$KIT" "$RST"
[[ $APPLY -eq 0 ]] && { say "${DIM}DRY RUN — pass --apply to make changes${RST}"; echo; }

# Claude Code's entry carries a timeout and statusMessage so a hung or slow
# guard.mjs doesn't sit on Claude Code's 60s default with no label in the
# spinner. Codex already set its own timeout when this entry was first added.
wire_tier_a claude "Claude Code" claude "$HOME/.claude/settings.json" PreToolUse \
  '.hooks[$event] = ((.hooks[$event] // []) + [{
     matcher: $matcher,
     hooks: [{ type: "command", command: $cmd, timeout: 10, statusMessage: "Checking harness-kit guardrails" }]
   }])'

wire_tier_a codex "Codex" codex "$HOME/.codex/hooks.json" PreToolUse \
  '.hooks[$event] = ((.hooks[$event] // []) + [{
     hooks: [{ type: "command", command: $cmd, timeout: 10 }]
   }])'

# SessionStart fires once per session and carries only the invariant
# guardrail-hook paragraph (see context.mjs's header for the split this
# feeds). Confirmed against both installed binaries before wiring it: Claude
# Code 2.1.260's embedded hook docs list SessionStart as a real event with the
# same `hookSpecificOutput.additionalContext` output shape UserPromptSubmit
# already uses below, and Codex 0.146.0 ships a
# `session-start.command.output` JSON Schema with an identical
# `{hookEventName: "SessionStart", additionalContext}` shape. No `$matcher` —
# same reasoning as UserPromptSubmit below, there is no tool to dispatch on.
wire_tier_a claude "Claude Code" claude "$HOME/.claude/settings.json" SessionStart \
  '.hooks[$event] = ((.hooks[$event] // []) + [{
     hooks: [{ type: "command", command: $cmd, timeout: 10, statusMessage: "Checking harness-kit guardrails" }]
   }])'

wire_tier_a codex "Codex" codex "$HOME/.codex/hooks.json" SessionStart \
  '.hooks[$event] = ((.hooks[$event] // []) + [{
     hooks: [{ type: "command", command: $cmd, timeout: 10 }]
   }])'

# UserPromptSubmit is deliberately NOT wired. A previous version of this
# script wired it (defect #1: guard.mjs had handled the event and emitted
# additionalContext since it was written, but nothing ever invoked it because
# no hook was registered) — but context.mjs's session/turn split (see its
# header) means phase 'turn' always returns '' today, so that wiring spawned
# a node process on every single turn whose only correct output is silence.
# A hook that can only ever produce nothing is indistinguishable from a
# broken one, which is exactly the silent-absence failure this repo exists to
# catch. This does NOT reopen defect #1: context injection is still closed,
# via the SessionStart wiring above — only the delivery event for the
# invariant paragraph changed, from every-turn to once-per-session.
#
# guard.mjs still handles UserPromptSubmit if it ever arrives — a hand-wired
# hook, or a machine still carrying the previous commit's entry (doctor.mjs
# reports that case; dev-unlink.sh cleans it up). Re-wiring it here, if a
# genuinely per-turn signal ever earns its cost, is one more wire_tier_a call
# per harness, same as any other event — this function does not change.

wire_tier_b pi  "Pi"  pi
wire_tier_b omp "omp" omp

echo
if [[ $APPLY -eq 0 ]]; then
  if [[ $CHANGED -eq 1 ]]; then
    say "Re-run with --apply to make these changes."
  else
    say "Nothing to do."
  fi
else
  say "Restart Claude Code and Codex; run /reload in Pi and omp."
  say "${DIM}Verify with: node scripts/doctor.mjs${RST}"
fi

[[ $FAILED -eq 1 ]] && { echo; say "${YLW}Some harnesses were skipped — see above.${RST}"; }
echo
exit 0
