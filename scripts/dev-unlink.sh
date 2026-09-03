#!/usr/bin/env bash
#
# Undo scripts/dev-link.sh for every harness, in one command.
#
# Removes only what points into THIS checkout:
#   Tier A  PreToolUse entries whose command names $KIT — other hooks are kept
#   Tier B  symlinks whose target is inside $KIT — a foreign file is left alone
#
# Dry run unless you pass --apply. Backs up every file it edits.
#
# Usage:
#   bash scripts/dev-unlink.sh                # show what would change
#   bash scripts/dev-unlink.sh --apply
#   bash scripts/dev-unlink.sh --apply --only codex

set -euo pipefail

KIT="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

APPLY=0
ONLY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --only)  ONLY="${2:-}"; shift ;;
    --only=*) ONLY="${1#*=}" ;;
    -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 64 ;;
  esac
  shift
done

if [[ -t 1 ]]; then
  DIM=$'\033[2m'; GRN=$'\033[32m'; YLW=$'\033[33m'; RED=$'\033[31m'; RST=$'\033[0m'
else
  DIM=""; GRN=""; YLW=""; RED=""; RST=""
fi

say()  { printf '  %s\n' "$*"; }
ok()   { printf '  %s●%s %s\n' "$GRN" "$RST" "$*"; }
skip() { printf '  %s○ %s%s\n' "$DIM" "$*" "$RST"; }
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

# ── Tier A ──────────────────────────────────────────────────────────────────
#
# Filter the PreToolUse array rather than resetting it: by now the user may have
# added hooks of their own, and those must survive an uninstall.

unwire_tier_a() {
  local key="$1" name="$2" file="$3"

  selected "$key" || return 0

  if [[ ! -f "$file" ]]; then
    skip "$name — $file absent"
    return 0
  fi

  if ! grep -qF "$KIT" "$file" 2>/dev/null; then
    skip "$name — not wired"
    return 0
  fi

  if ! have jq; then
    fail "$name — jq is required to unwire Tier A (brew install jq)"
    FAILED=1
    return 0
  fi

  if ! jq -e . "$file" >/dev/null 2>&1; then
    fail "$name — $file is not valid JSON, left untouched"
    FAILED=1
    return 0
  fi

  plan "$name — remove harness-kit PreToolUse entry from $file"
  CHANGED=1
  [[ $APPLY -eq 1 ]] || return 0

  backup "$file"

  local tmp
  tmp="$(mktemp)"
  # Drop an entry when any command it carries names this checkout. Commands are
  # read from both shapes: nested under .hooks, and bare on the entry.
  if jq --arg kit "$KIT" '
        .hooks.PreToolUse = ((.hooks.PreToolUse // []) | map(select(
          ([ .command // empty, (.hooks[]?.command // empty) ]
             | map(contains($kit)) | any) | not
        )))
      ' "$file" > "$tmp"; then
    mv "$tmp" "$file"
  else
    rm -f "$tmp"
    fail "$name — jq failed, $file unchanged"
    FAILED=1
  fi
}

# ── Tier B ──────────────────────────────────────────────────────────────────

unwire_tier_b() {
  local key="$1" name="$2" dir="$3"
  local link="$dir/harness-kit.mjs"

  selected "$key" || return 0

  if [[ ! -L "$link" ]]; then
    if [[ -e "$link" ]]; then
      fail "$name — $link is a regular file, not ours, left alone"
      FAILED=1
    else
      skip "$name — not wired"
    fi
    return 0
  fi

  local target
  target="$(readlink "$link")"
  case "$target" in
    "$KIT"/*)
      plan "$name — remove $link"
      CHANGED=1
      [[ $APPLY -eq 1 ]] && rm -f "$link"
      ;;
    *)
      fail "$name — $link points outside the kit ($target), left alone"
      FAILED=1
      ;;
  esac
}

# ── run ─────────────────────────────────────────────────────────────────────

printf '\n%sharness-kit%s dev-unlink  %s(%s)%s\n\n' "$YLW" "$RST" "$DIM" "$KIT" "$RST"
[[ $APPLY -eq 0 ]] && { say "${DIM}DRY RUN — pass --apply to make changes${RST}"; echo; }

unwire_tier_a claude "Claude Code" "$HOME/.claude/settings.json"
unwire_tier_a codex  "Codex"       "$HOME/.codex/hooks.json"
unwire_tier_b pi     "Pi"          "$HOME/.pi/agent/extensions"
unwire_tier_b omp    "omp"         "$HOME/.omp/agent/extensions"

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
