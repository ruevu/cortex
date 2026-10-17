#!/usr/bin/env bash
# Hook: show-presence (PostToolUse) — streams agent activity to the viewer's
# presence pipeline. Fire-and-forget POST /api/presence; degrade-safe: ANY
# failure / missing jq / no server → exit 0 silently. Never blocks the agent.
# Spec: .superpowers/specs/2026-07-23-show-your-work-design.md §3.
set +e

[ "${CORTEX_PRESENCE:-1}" = "0" ] && exit 0
command -v jq >/dev/null 2>&1 || exit 0

PAYLOAD="$(cat)"; [ -n "$PAYLOAD" ] || exit 0

TOOL="$(printf '%s' "$PAYLOAD" | jq -r '.tool_name // empty' 2>/dev/null)"
SESSION="$(printf '%s' "$PAYLOAD" | jq -r '.session_id // empty' 2>/dev/null)"
[ -n "$TOOL" ] && [ -n "$SESSION" ] || exit 0

ACTIVITY="" REF="" ROOT=""
STUDIED=() EDITED=()   # Bash only: repo-relative refs, one beacon per non-empty list

# Bash: resolve one candidate path (relative to $1) to a repo-relative ref.
# The first file seen fixes ROOT; a file in any other repo is dropped, since one
# beacon names one checkout. Sets R (empty for a non-file or an out-of-scope
# path) rather than printing, because a $(…) subshell would lose ROOT.
bash_ref() {
  local d="$1" f="$2" r dd
  R=""
  case "$f" in /*) ;; "~"/*) f="$HOME/${f#"~/"}" ;; *) f="$d/$f" ;; esac
  [ -f "$f" ] || return 0
  dd="$(cd "$(dirname "$f")" 2>/dev/null && pwd -P)"; [ -n "$dd" ] || return 0
  f="$dd/$(basename "$f")"
  if [ -z "$ROOT" ]; then
    r="$(git -C "$dd" rev-parse --show-toplevel 2>/dev/null)"; [ -n "$r" ] || return 0
    ROOT="$(cd "$r" 2>/dev/null && pwd -P)"; [ -n "$ROOT" ] || return 0
  fi
  case "$f" in "$ROOT"/*) R="${f#"$ROOT"/}" ;; esac
}

case "$TOOL" in
  Read|Edit|Write|MultiEdit)
    FILE="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"
    [ -n "$FILE" ] || exit 0
    ROOT="$(git -C "$(dirname "$FILE")" rev-parse --show-toplevel 2>/dev/null)"
    [ -n "$ROOT" ] || exit 0
    # Canonicalize both sides (macOS /tmp → /private/tmp) so the prefix strip works.
    _R="$(cd "$ROOT" 2>/dev/null && pwd -P)"; [ -n "$_R" ] && ROOT="$_R"
    _D="$(cd "$(dirname "$FILE")" 2>/dev/null && pwd -P)"; [ -n "$_D" ] && FILE="$_D/$(basename "$FILE")"
    case "$FILE" in "$ROOT"/*) ;; *) exit 0 ;; esac   # scope filter: outside repo → drop
    REF="${FILE#"$ROOT"/}"
    case "$TOOL" in Read) ACTIVITY="studied" ;; *) ACTIVITY="edited" ;; esac
    ;;
  mcp__*cortex*__get_code_snippet|mcp__*cortex*__context_pack|mcp__*cortex*__search_graph|\
  mcp__*cortex*__trace_path|mcp__*cortex*__decision)
    ROOT="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.repo_path // empty' 2>/dev/null)"
    [ -n "$ROOT" ] || exit 0
    case "$TOOL" in
      *__trace_path)
        ACTIVITY="traced"
        REF="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.function_name // empty' 2>/dev/null)" ;;
      *__decision)
        ACTION="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.action // empty' 2>/dev/null)"
        case "$ACTION" in why|get) ;; *) exit 0 ;; esac   # reads only — writes self-emit server-side
        ACTIVITY="consulted"
        REF="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.qualified_name // .tool_input.decision_id // .tool_input.id // empty' 2>/dev/null)" ;;
      *)
        ACTIVITY="studied"
        REF="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.qualified_name // .tool_input.name_pattern // empty' 2>/dev/null)" ;;
    esac
    ;;
  Bash)
    # The file readers an agent reaches for instead of Read — `cat`, `sed`, `awk`
    # — are studied files like any other; `sed -i` is an edit. Everything else a
    # shell does is not presence, so anything unrecognised drops silently.
    CMD="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.command // empty' 2>/dev/null)"
    DIR="$(printf '%s' "$PAYLOAD" | jq -r '.cwd // empty' 2>/dev/null)"
    [ -n "$CMD" ] && [ -n "$DIR" ] || exit 0
    case "$CMD" in *cat*|*sed*|*awk*) ;; *) exit 0 ;; esac   # cheap pre-filter
    # Pad the separators into their own words, then let xargs tokenize with the
    # shell's quoting rules. A command it cannot parse (unbalanced quotes, a
    # heredoc body) tokenizes to nothing, which drops it — never a wrong ref.
    CMD="${CMD//$'\n'/ ; }"; CMD="${CMD//;/ ; }"; CMD="${CMD//|/ | }"; CMD="${CMD//&/ & }"
    TOKENS="$(printf '%s' "$CMD" | xargs printf '%s\n' 2>/dev/null)" || exit 0
    WORD="" INPLACE=0 SKIP=0
    while IFS= read -r T; do
      case "$T" in ';'|'&'|'|') WORD="" INPLACE=0 SKIP=0; continue ;; esac
      [ "$SKIP" = 1 ] && { SKIP=0; continue; }
      # Output redirection names a file written, not read: drop the operator
      # and, when detached (`> out`), the target after it.
      case "$T" in *'>') SKIP=1; continue ;; *'>'*) continue ;; esac
      if [ -z "$WORD" ]; then
        case "$T" in *=*) continue ;; esac   # FOO=bar prefix assignments
        WORD="${T##*/}"; continue            # /usr/bin/sed → sed
      fi
      case "$WORD" in
        cd)
          case "$T" in /*) DIR="$T" ;; "~") DIR="$HOME" ;; "~"/*) DIR="$HOME/${T#"~/"}" ;; *) DIR="$DIR/$T" ;; esac
          WORD="cd:done" ;;
        cat|sed|gsed|awk|gawk|nawk|mawk)
          case "$T" in
            -i*|--in-place*) [ "${WORD%sed}" != "$WORD" ] && INPLACE=1 ;;
            -*|'<') ;;
            *)
              bash_ref "$DIR" "${T#<}"
              if [ -n "$R" ]; then
                if [ "$INPLACE" = 1 ]; then EDITED+=("$R"); else STUDIED+=("$R"); fi
              fi ;;
          esac ;;
      esac
    done <<< "$TOKENS"
    [ "${#STUDIED[@]}" -gt 0 ] || [ "${#EDITED[@]}" -gt 0 ] || exit 0
    ;;
  *) exit 0 ;;
esac

[ -n "$ROOT" ] || exit 0
WORKSPACE="$(basename "$ROOT")"

# One beacon per activity; refs capped at the schema's 50.
beacon() {
  local a="$1"; shift
  [ "$#" -gt 0 ] || return 0
  printf '%s\n' "$@" | head -50 | jq -R . | jq -cs --arg s "$SESSION" --arg r "$ROOT" --arg w "$WORKSPACE" --arg a "$a" \
    '{session_id:$s, repo_path:$r, workspace:$w, activity:$a, refs:.}'
}
BODIES=()
if [ "$TOOL" = "Bash" ]; then
  [ "${#STUDIED[@]}" -gt 0 ] && BODIES+=("$(beacon studied "${STUDIED[@]}")")
  [ "${#EDITED[@]}" -gt 0 ] && BODIES+=("$(beacon edited "${EDITED[@]}")")
else
  [ -n "$ACTIVITY" ] && [ -n "$REF" ] || exit 0
  BODIES+=("$(beacon "$ACTIVITY" "$REF")")
fi

AUTH=()
[ -n "${CORTEX_API_TOKEN:-}" ] && AUTH=(-H "Authorization: Bearer ${CORTEX_API_TOKEN}")

# Everything network-shaped runs backgrounded — the hook returns immediately.
(
  if [ -n "${CORTEX_PRESENCE_URL:-}" ]; then
    BASES=("${CORTEX_PRESENCE_URL}")
  else
    SENTINEL="${TMPDIR:-/tmp}/cortex-presence-port-${SESSION}"
    CACHED="$(cat "$SENTINEL" 2>/dev/null)"
    if [ -n "$CACHED" ]; then
      BASES=("http://127.0.0.1:${CACHED}")
    else
      PORTS=("${CORTEX_VIEWER_PORT:-}" 3333 3334)
      BASES=()
      for P in "${PORTS[@]}"; do
        [ -n "$P" ] || continue
        if curl -sf --max-time 0.3 "http://127.0.0.1:${P}/api/health" >/dev/null 2>&1; then
          BASES=("http://127.0.0.1:${P}"); printf '%s' "$P" > "$SENTINEL" 2>/dev/null; break
        fi
      done
    fi
  fi
  for B in "${BASES[@]}"; do
    SENT=0
    for BODY in "${BODIES[@]}"; do
      curl -sf --max-time 0.5 -X POST -H 'content-type: application/json' "${AUTH[@]}" \
        -d "$BODY" "${B}/api/presence" >/dev/null 2>&1 && SENT=1
    done
    [ "$SENT" = 1 ] && break
    # A cached port that stopped answering: clear the sentinel for next time.
    [ -z "${CORTEX_PRESENCE_URL:-}" ] && rm -f "${TMPDIR:-/tmp}/cortex-presence-port-${SESSION}" 2>/dev/null
  done
) >/dev/null 2>&1 &

exit 0
