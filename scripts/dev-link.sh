#!/usr/bin/env bash
#
# Wire this checkout into every harness on THIS machine, in one command.
#
#   Tier A (Claude Code, Codex)  a PreToolUse entry appended to their JSON config
#   Tier B (Pi, omp)             registered via `pi install` / `omp install`
#
# Everything it writes is OUTSIDE the repo. It is a dry run unless you pass
# --apply, it backs up every file it edits, and it is idempotent — re-running it
# on an already-wired harness does nothing.
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
GUARD="node \"$KIT/src/tier-a/guard.mjs\""

# Claude Code dispatches on tool name, so scope the hook rather than paying a
# process spawn on tools the kit has no opinion about. Codex entries carry no
# matcher; unknown tools normalise to KIND.OTHER and are allowed immediately.
MATCHER="Bash|Read|Write|Edit|MultiEdit|NotebookEdit|Glob|Grep"

APPLY=0
ONLY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --only)  ONLY="${2:-}"; shift ;;
    --only=*) ONLY="${1#*=}" ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
  b="$f.harness-kit-bak.$(date +%Y%m%d%H%M%S)"
  cp -p "$f" "$b"
  say "$DIM  backup: $b$RST"
}

# ── Tier A: Claude Code, Codex ──────────────────────────────────────────────
#
# Both already ship other PreToolUse hooks in practice, so this APPENDS to the
# array rather than assigning it. Clobbering a user's existing hooks is the one
# unrecoverable mistake an installer can make.

wire_tier_a() {
  local key="$1" name="$2" bin="$3" file="$4" entry="$5"

  selected "$key" || return 0

  if ! have "$bin"; then
    skip "$name — not installed"
    return 0
  fi

  if [[ -f "$file" ]] && grep -qF "$KIT" "$file" 2>/dev/null; then
    ok "$name — already wired"
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

  plan "$name — append PreToolUse hook to $file"
  CHANGED=1
  [[ $APPLY -eq 1 ]] || return 0

  mkdir -p "$(dirname "$file")"
  if [[ -f "$file" ]]; then backup "$file"; else printf '{}\n' > "$file"; fi

  local tmp
  tmp="$(mktemp)"
  if jq --arg cmd "$GUARD" --arg matcher "$MATCHER" "$entry" "$file" > "$tmp"; then
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
# A symlink dropped into `~/.pi/agent/extensions/` does NOT work: neither agent
# scans that path. This script created exactly that at first and the guardrail
# silently never loaded — `pi list` reporting "No packages installed" while
# doctor reported "wired" was the tell.

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

wire_tier_a claude "Claude Code" claude "$HOME/.claude/settings.json" \
  '.hooks.PreToolUse = ((.hooks.PreToolUse // []) + [{
     matcher: $matcher,
     hooks: [{ type: "command", command: $cmd }]
   }])'

wire_tier_a codex "Codex" codex "$HOME/.codex/hooks.json" \
  '.hooks.PreToolUse = ((.hooks.PreToolUse // []) + [{
     hooks: [{ type: "command", command: $cmd, timeout: 10 }]
   }])'

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
