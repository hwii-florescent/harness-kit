#!/usr/bin/env bash
#
# Undo scripts/dev-link.sh for every harness, in one command.
#
# Removes only what points into THIS checkout:
#   Tier A  every hook entry, under any event, whose command names this
#           checkout's src/tier-a/guard.mjs — anything else is kept, including
#           your own hooks that happen to run other scripts from this repo
#   Tier B  the registration made by `pi install` / `omp install`
#
# Dry run unless you pass --apply. Backs up every file it edits.
#
# Usage:
#   bash scripts/dev-unlink.sh                # show what would change
#   bash scripts/dev-unlink.sh --apply
#   bash scripts/dev-unlink.sh --apply --only codex

set -euo pipefail

KIT="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The exact path substring that marks a hook entry as this kit's own — must
# match dev-link.sh's $GUARD_PATH exactly. A plain "contains $KIT" test is a
# path-prefix false positive across sibling worktrees (e.g. ../bristleworm and
# ../bristleworm-2, one a strict prefix of the other): from the shorter path,
# the longer worktree's entry would read as "already wired" and never install;
# from the longer path, unlink would delete the shorter worktree's entry too.
GUARD_PATH="$KIT/src/tier-a/guard.mjs"

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
  # mktemp both picks a name unique enough to survive a link+unlink within the
  # same second (plain second-granularity timestamps collide, and `cp -p`
  # with no `-n` would then silently overwrite the earlier backup) and creates
  # it atomically, so there is no race between choosing the name and using it.
  b="$(mktemp "$f.harness-kit-bak.$(date +%Y%m%d%H%M%S).XXXXXX")"
  cp -p "$f" "$b"
  say "$DIM  backup: $b$RST"
}

# The shared "does this entry belong to this kit" predicate, used both to gate
# unwire_tier_a (fix parity with the removal filter below — the gate used to
# be a bare `grep -qF "$KIT"`, which could disagree with the filter, e.g. when
# $KIT text appears outside a hook command such as in
# permissions.additionalDirectories: every run would then report a change,
# take a backup, and rewrite the file removing nothing) and to select entries
# to drop in the removal filter itself.
#
# Every shape is type-guarded before `contains()`: a neighbouring entry that
# is a bare string/number, a non-string `command`, a `hooks` item that is a
# string, or a non-array event value must read as "doesn't match" rather than
# make jq itself error — jq -e degrades any such error to exit 5, which reads
# as "not wired" wherever the caller only checks the if-condition, and inside
# the with_entries sweep below it would abort removal for every event, not
# just the malformed one.
read -r -d '' KIT_ENTRY_PREDICATE <<'JQ' || true
[ .command?, ((.hooks? // []) | .[]? | .command?) ]
  | map(select(type == "string") | contains($guard)) | any
JQ

# ── Tier A ──────────────────────────────────────────────────────────────────
#
# Filter each hook-event array rather than resetting it: by now the user may
# have added hooks of their own, and those must survive an uninstall.
#
# dev-link.sh wires this kit under whichever hook event a given feature needs
# (PreToolUse today; a later stage adds more, e.g. UserPromptSubmit) — see the
# per-event idempotence note in dev-link.sh. Unlink must remove this kit's
# entry from every event it might be under, not just PreToolUse, or a later
# event would survive an uninstall silently. Rather than hardcode the event
# names here (and having to revisit this file each time dev-link.sh gains one),
# walk every key under `.hooks` and filter each one the same way.

unwire_tier_a() {
  local key="$1" name="$2" file="$3"

  selected "$key" || return 0

  if [[ ! -f "$file" ]]; then
    skip "$name — $file absent"
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

  # Same predicate as the removal filter below, not a bare `grep -qF "$KIT"`:
  # a mismatched gate would report a change, take a backup, and rewrite the
  # file (reformatting it to jq's style) while removing nothing, whenever
  # $KIT text appears somewhere the filter doesn't look (e.g. inside
  # permissions.additionalDirectories).
  if ! jq -e --arg guard "$GUARD_PATH" '
        [ (.hooks // {}) | to_entries[] | .value | (if type == "array" then .[] else empty end) ]
        | any('"$KIT_ENTRY_PREDICATE"')
      ' "$file" >/dev/null 2>&1; then
    skip "$name — not wired"
    return 0
  fi

  plan "$name — remove harness-kit hook entries from $file"
  CHANGED=1
  [[ $APPLY -eq 1 ]] || return 0

  backup "$file"

  local tmp
  tmp="$(mktemp)"
  # Drop an entry when any command it carries names this checkout. Commands are
  # read from both shapes: nested under .hooks, and bare on the entry. Applied
  # to every array under .hooks (PreToolUse, UserPromptSubmit, …) so a new hook
  # event dev-link.sh starts wiring is covered here with no further edit. Only
  # touches `.hooks` when the key already exists — a file with none must not
  # gain an empty "hooks": {} from an uninstall that had nothing to remove.
  if jq --arg guard "$GUARD_PATH" '
        if has("hooks") then
          .hooks |= with_entries(
            .value |= (if type == "array" then map(select(
              ('"$KIT_ENTRY_PREDICATE"') | not
            )) else . end)
          )
        else . end
      ' "$file" > "$tmp"; then
    mv "$tmp" "$file"
  else
    rm -f "$tmp"
    fail "$name — jq failed, $file unchanged"
    FAILED=1
  fi
}

# ── Tier B ──────────────────────────────────────────────────────────────────
#
# Removal goes through each agent's own package manager, matching how dev-link
# installs. Nothing to hand-delete: the settings entry and the linked checkout
# are both theirs to manage.

tier_b_installed() {
  case "$1" in
    pi)  pi list 2>/dev/null | grep -qF "$KIT" ;;
    omp) omp plugin list 2>/dev/null | grep -q 'harness-kit' ;;
  esac
}

unwire_tier_b() {
  local key="$1" name="$2" bin="$3"

  selected "$key" || return 0

  if ! have "$bin"; then
    skip "$name — not installed"
    return 0
  fi

  if ! tier_b_installed "$key"; then
    skip "$name — not wired"
    return 0
  fi

  plan "$name — remove harness-kit from $bin"
  CHANGED=1
  [[ $APPLY -eq 1 ]] || return 0

  local done=1
  case "$key" in
    pi)  pi remove "$KIT" >/dev/null 2>&1 || done=0 ;;
    omp) omp plugin uninstall harness-kit >/dev/null 2>&1 || done=0 ;;
  esac
  [[ $done -eq 1 ]] || { fail "$name — removal command failed"; FAILED=1; }
}

# ── run ─────────────────────────────────────────────────────────────────────

printf '\n%sharness-kit%s dev-unlink  %s(%s)%s\n\n' "$YLW" "$RST" "$DIM" "$KIT" "$RST"
[[ $APPLY -eq 0 ]] && { say "${DIM}DRY RUN — pass --apply to make changes${RST}"; echo; }

# Both Claude Code settings files, not just settings.json. doctor.mjs reads
# settings.json AND settings.local.json when deciding whether this kit is
# wired, so removing from only the first left an asymmetry you could get stuck
# in: an entry in settings.local.json kept doctor reporting the kit as wired
# (or kept nagging about a stale entry) with no command able to clear it.
# unwire_tier_a already skips files that do not exist, so listing both is safe
# on a machine that only has one.
unwire_tier_a claude "Claude Code" "$HOME/.claude/settings.json"
unwire_tier_a claude "Claude Code" "$HOME/.claude/settings.local.json"
unwire_tier_a codex  "Codex"       "$HOME/.codex/hooks.json"
unwire_tier_b pi     "Pi"          pi
unwire_tier_b omp    "omp"         omp

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
