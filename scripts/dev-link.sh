#!/usr/bin/env bash
#
# Wire this checkout into every harness on THIS machine, in one command.
#
#   Tier A (Claude Code, Codex)  canonical nested PreToolUse hooks with explicit modes
#   Tier B (Pi, omp)             registered via `pi install` / `omp install`
#
# Everything it writes is OUTSIDE the repo. It is a dry run unless you pass
# --apply, backs up every file it edits, and migrates recognized old entries
# without clobbering unrelated hooks.
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
LEGACY_GUARD="node \"$KIT/src/tier-a/guard.mjs\""
CLAUDE_GUARD="$LEGACY_GUARD --harness claude"
CODEX_GUARD="$LEGACY_GUARD --harness codex"

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
# A first install appends a canonical nested group. Reruns normalize this
# checkout's legacy or mode-bearing commands in place and remove duplicates,
# while preserving unrelated groups and handlers.

wire_tier_a() {
  local key="$1" name="$2" bin="$3" file="$4" expected="$5"

  selected "$key" || return 0

  if ! have "$bin"; then
    skip "$name — not installed"
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

  local state nested_count direct_count canonical_count
  if [[ -f "$file" ]]; then
    state="$(jq -r \
      --arg expected "$expected" \
      --arg legacy "$LEGACY_GUARD" \
      --arg claude "$CLAUDE_GUARD" \
      --arg codex "$CODEX_GUARD" '
        def command_of($value):
          if ($value | type) == "object" then $value.command else null end;
        def is_guard($command):
          ($command | type) == "string"
          and ($command == $legacy or $command == $claude or $command == $codex);
        def pretool:
          (.hooks? // {}) as $hooks
          | if ($hooks | type) == "object"
              and (($hooks.PreToolUse? // []) | type) == "array"
            then ($hooks.PreToolUse // [])
            else []
            end;
        def handlers($group):
          if ($group | type) == "object"
              and (($group.hooks? // []) | type) == "array"
          then ($group.hooks // [])
          else []
          end;
        [ pretool[]? | handlers(.)[]? | select(is_guard(command_of(.))) ] as $nested
        | [ pretool[]? | select(is_guard(command_of(.))) ] as $direct
        | [
            ($nested | length),
            ($direct | length),
            ([$nested[] | select(
              (type == "object") and .type == "command" and .command == $expected
            )] | length)
          ]
        | @tsv
      ' "$file")"
    IFS=$'\t' read -r nested_count direct_count canonical_count <<< "$state"
  else
    nested_count=0
    direct_count=0
    canonical_count=0
  fi

  if [[ "$nested_count" == 1 && "$direct_count" == 0 && "$canonical_count" == 1 ]]; then
    ok "$name — already wired"
    return 0
  fi

  plan "$name — normalize PreToolUse hook in $file"
  CHANGED=1
  [[ $APPLY -eq 1 ]] || return 0

  mkdir -p "$(dirname "$file")"

  local tmp
  tmp="$(mktemp)"
  local source="$file"
  if [[ ! -f "$source" ]]; then
    source="$(mktemp)"
    printf '{}' > "$source"
  fi
  if ! jq \
    --arg key "$key" \
    --arg expected "$expected" \
    --arg legacy "$LEGACY_GUARD" \
    --arg claude "$CLAUDE_GUARD" \
    --arg codex "$CODEX_GUARD" \
    --arg matcher "$MATCHER" '
      def command_of($value):
        if ($value | type) == "object" then $value.command else null end;
      def is_guard($command):
        ($command | type) == "string"
        and ($command == $legacy or $command == $claude or $command == $codex);
      def pretool:
        (.hooks? // {}) as $hooks
        | if ($hooks | type) == "object"
            and (($hooks.PreToolUse? // []) | type) == "array"
          then ($hooks.PreToolUse // [])
          else []
          end;
      def handlers($group):
        if ($group | type) == "object"
            and (($group.hooks? // []) | type) == "array"
        then ($group.hooks // [])
        else []
        end;
      def set_pretool($root; $groups):
        ($root.hooks? // {}) as $hooks
        | (if ($hooks | type) == "object" then $hooks else {} end) as $hook_config
        | $root
        | .hooks = ($hook_config | .PreToolUse = $groups);
      def has_handlers($group):
        ((($group.hooks? // null) | type) == "array"
          and (($group.hooks | length) > 0))
        or (($group | type) == "object" and ($group | has("command")));

      . as $root
      | pretool as $groups
      | [ pretool[]? | handlers(.)[]? | select(is_guard(command_of(.))) ] as $nested
      | [ pretool[]? | select(is_guard(command_of(.))) ] as $direct
      | if (($nested | length) + ($direct | length)) == 0 then
          set_pretool(
            $root;
            $groups + [{
              matcher: $matcher,
              hooks: [{
                type: "command",
                command: $expected
              } + (if $key == "codex" then { timeout: 10 } else {} end)]
            }]
          )
        else
          (reduce $groups[] as $group
            ({ seen_nested: false, seen_direct: false, out: [] };
             if ($group | type) != "object" then
               .out += [$group]
             else
               (handlers($group)) as $handlers
               | (reduce $handlers[] as $handler
                   ({ seen: .seen_nested, touched: false, hooks: [] };
                    if is_guard(command_of($handler)) then
                      .touched = true
                      | if .seen then
                          .
                        else
                          .seen = true
                          | .hooks += [(
                              $handler
                              | .type = "command"
                              | .command = $expected
                            )]
                        end
                    else
                      .hooks += [$handler]
                    end
                   )) as $handler_result
               | (is_guard(command_of($group))) as $direct_hit
               | ($direct_hit
                  and (($nested | length) == 0)
                  and .seen_direct == false) as $first_direct
               | if $direct_hit then .seen_direct = true else . end
               | (
                   if $first_direct then
                     ($group
                      | del(.command)
                      | .hooks = ([
                          { type: "command", command: $expected }
                          + (if $key == "codex" then { timeout: 10 } else {} end)
                        ] + $handler_result.hooks))
                   elif $direct_hit then
                     ($group | del(.command) | .hooks = $handler_result.hooks)
                   elif $handler_result.touched then
                     ($group | .hooks = $handler_result.hooks)
                   else
                     $group
                   end
                 ) as $candidate
               | if $handler_result.touched or $direct_hit then
                   if has_handlers($candidate) then .out += [$candidate] else . end
                 else
                   .out += [$candidate]
                 end
               | .seen_nested = $handler_result.seen
             end
            )
          ) as $state
          | set_pretool($root; $state.out)
        end
    ' "$source" > "$tmp"; then
    rm -f "$tmp"
    [[ "$source" == "$file" ]] || rm -f "$source"
    fail "$name — jq failed, $file unchanged"
    FAILED=1
    return 0
  fi

  if [[ -f "$file" ]] && cmp -s "$file" "$tmp"; then
    rm -f "$tmp"
    [[ "$source" == "$file" ]] || rm -f "$source"
    ok "$name — already wired"
    return 0
  fi

  [[ -f "$file" ]] && backup "$file"
  mv "$tmp" "$file"
  [[ "$source" == "$file" ]] || rm -f "$source"
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

wire_tier_a claude "Claude Code" claude "$HOME/.claude/settings.json" "$CLAUDE_GUARD"

wire_tier_a codex "Codex" codex "$HOME/.codex/hooks.json" "$CODEX_GUARD"

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
