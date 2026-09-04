#!/usr/bin/env bash
#
# Build a throwaway $HOME for exercising the Tier A wiring scripts.
#
# dev-link.sh and dev-unlink.sh edit ~/.claude/settings.json and
# ~/.codex/hooks.json. Those files belong to running agent sessions — this
# machine's own Claude Code hook lives there — so an --apply against the real
# $HOME can take every session on the box down. That is not hypothetical: it
# happened twice while this kit was being built, and the second time the guard
# blocked its own repair.
#
# So: never test wiring against the real $HOME. Build one here instead.
#
#   eval "$(bash scripts/sandbox-home.sh)"        # sets and exports SANDBOX_HOME
#   HOME="$SANDBOX_HOME" bash scripts/dev-link.sh --apply --only claude,codex
#
# The sandbox is seeded with a COPY of the real config when one exists, so the
# foreign hooks other tools install are present and the "must survive
# byte-identical" property is actually being tested rather than assumed. Pass
# --hostile to also seed the malformed shapes that broke the jq predicates:
# a non-string command, an entry that is a bare string, a junk Notification
# array. Those are regression fixtures, not hypotheticals — each one was a
# real finding.
#
# Everything lives under .local/, which is gitignored. Safe to delete anytime.

set -euo pipefail

KIT="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOSTILE=0
[[ "${1:-}" == "--hostile" ]] && HOSTILE=1

SANDBOX="$KIT/.local/sandbox-home/$(date +%Y%m%d%H%M%S)$$"
mkdir -p "$SANDBOX/.claude" "$SANDBOX/.codex"

# Seed from the real config so foreign hooks are represented. Read-only on the
# source, always — this script must never write outside $SANDBOX.
for pair in ".claude/settings.json" ".claude/settings.local.json" ".codex/hooks.json"; do
  if [[ -f "$HOME/$pair" ]]; then
    cp "$HOME/$pair" "$SANDBOX/$pair"
  fi
done
[[ -f "$SANDBOX/.claude/settings.json" ]] || printf '{}\n' > "$SANDBOX/.claude/settings.json"

if [[ $HOSTILE -eq 1 ]]; then
  # Shapes that made `jq -e` exit 5, which the `2>/dev/null` swallowed into
  # "not wired" — after which --apply appended a duplicate hook every run.
  # Order matters: `any` short-circuits, so the malformed entry must sort
  # BEFORE a real one to be reached.
  tmp="$(mktemp)"
  jq '
    .hooks.PreToolUse = ([
       "a bare string entry",
       { "matcher": "Bash", "hooks": [ { "type": "command", "command": 12345 } ] },
       { "matcher": "Bash", "hooks": [ "a bare string hook" ] }
     ] + (.hooks.PreToolUse // []))
    | .hooks.Notification = "not even an array"
  ' "$SANDBOX/.claude/settings.json" > "$tmp"
  mv "$tmp" "$SANDBOX/.claude/settings.json"
fi

printf 'SANDBOX_HOME=%q\n' "$SANDBOX"
printf 'export SANDBOX_HOME\n'
printf '# seeded from %s%s\n' "$HOME" "$([[ $HOSTILE -eq 1 ]] && printf ' (+hostile fixtures)')" >&2
