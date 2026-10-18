#!/usr/bin/env bash
# Hook: show-presence (PostToolUse) — streams agent activity to the viewer's
# presence pipeline. Fire-and-forget POST /api/presence; degrade-safe: ANY
# failure / missing jq / no server → exit 0 silently. Never blocks the agent.
# Spec: .superpowers/specs/2026-07-23-show-your-work-design.md §3.
set +e

[ "${CORTEX_PRESENCE:-1}" = "0" ] && exit 0
command -v jq >/dev/null 2>&1 || exit 0

PAYLOAD="$(cat)"; [ -n "$PAYLOAD" ] || exit 0

# One jq for the envelope, joined on the unit separator: a non-whitespace IFS,
# so an empty field stays empty instead of collapsing into its neighbour.
IFS=$'\x1f' read -r TOOL SESSION CWD0 <<< "$(printf '%s' "$PAYLOAD" | jq -r '[.tool_name // "", .session_id // "", .cwd // ""] | join("\u001f")' 2>/dev/null)"
[ -n "$TOOL" ] && [ -n "$SESSION" ] || exit 0

ACTIVITY="" REF="" ROOT=""
STUDIED=() EDITED=()   # Bash only: repo-relative refs, one beacon per non-empty list
MAX_REFS=50            # the /api/presence schema's cap

# Resolve one candidate path to a repo-relative ref. Relative paths resolve
# against $1, then against the session cwd: a hook payload's cwd may already be
# where a `cd` in the command left the shell, so applying that `cd` again would
# miss. An unset ROOT is fixed by the first file found; a file outside ROOT is
# dropped, since one beacon names one checkout. Sets R (empty on a miss) rather
# than printing, because a $(…) subshell would lose ROOT.
file_ref() {
  local d="$1" f="$2" r dd
  R=""
  case "$f" in
    /*) ;;
    "~"/*) f="$HOME/${f#"~/"}" ;;
    *) if [ -f "$d/$f" ]; then f="$d/$f"; else f="$CWD0/$f"; fi ;;
  esac
  [ -f "$f" ] || return 0
  dd="$(cd "$(dirname "$f")" 2>/dev/null && pwd -P)"; [ -n "$dd" ] || return 0
  f="$dd/$(basename "$f")"
  if [ -z "$ROOT" ]; then
    r="$(git -C "$dd" rev-parse --show-toplevel 2>/dev/null)"; [ -n "$r" ] || return 0
    ROOT="$(cd "$r" 2>/dev/null && pwd -P)"; [ -n "$ROOT" ] || return 0
  fi
  case "$f" in "$ROOT"/*) R="${f#"$ROOT"/}" ;; esac
}

# Bash: drop heredoc bodies. Their lines are data, not commands — a script
# written with `cat > x.sh <<EOF` must not read as the commands inside it.
# Here-strings (`<<<`) introduce no body and are masked before matching.
strip_heredocs() {
  local line probe trimmed delim="" re='<<-?[[:space:]]*["'"'"']?([A-Za-z_][A-Za-z0-9_]*)'
  while IFS= read -r line || [ -n "$line" ]; do
    if [ -n "$delim" ]; then
      trimmed="${line#"${line%%[![:space:]]*}"}"   # <<- allows leading tabs
      if [ "$line" = "$delim" ] || [ "$trimmed" = "$delim" ]; then delim=""; fi
      continue
    fi
    probe="${line//<<</ }"
    if [[ $probe =~ $re ]]; then delim="${BASH_REMATCH[1]}"; fi
    printf '%s\n' "$line"
  done
}

case "$TOOL" in
  Read|Edit|Write|MultiEdit)
    FILE="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"
    [ -n "$FILE" ] || exit 0
    file_ref "$(dirname "$FILE")" "$FILE"     # scope filter: outside repo → no R
    [ -n "$R" ] || exit 0
    REF="$R"
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
    # — are studied files like any other; in-place `sed`/`gawk` is an edit.
    # Everything else a shell does is not presence, and drops silently.
    [ -n "$CWD0" ] || exit 0
    CMD="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.command // empty' 2>/dev/null)"
    [ -n "$CMD" ] || exit 0
    # Cheap pre-filter: a reader must appear as a command WORD, not a substring.
    PRE='(^|[[:space:];&|(/])(cat|sed|gsed|awk|gawk|nawk|mawk)([[:space:]]|$)'
    [[ $CMD =~ $PRE ]] || exit 0
    CMD="$(printf '%s\n' "$CMD" | strip_heredocs)"
    # Fd redirects (`2>&1`, `>&2`, `&>f`) carry an `&` that is not a separator;
    # mask them so padding cannot split them. The masked token still contains
    # `>` and is dropped as a redirect below.
    CMD="${CMD//>&/>__FD__}"; CMD="${CMD//&>/__FD__>}"; CMD="${CMD//<&/<__FD__}"
    # Pad the separators into their own words, then let xargs tokenize with the
    # shell's quoting rules. A command it cannot parse (unbalanced quotes)
    # tokenizes to nothing, which drops it — never a wrong ref.
    CMD="${CMD//$'\n'/ ; }"; CMD="${CMD//;/ ; }"; CMD="${CMD//|/ | }"; CMD="${CMD//&/ & }"
    CMD="${CMD//(/ ( }"; CMD="${CMD//)/ ) }"
    TOKENS="$(printf '%s' "$CMD" | xargs printf '%s\n' 2>/dev/null)" || exit 0
    # Seed the checkout from the session's cwd, so a stray operand in another
    # repo cannot claim the beacon and drop the session's own files.
    _R="$(git -C "$CWD0" rev-parse --show-toplevel 2>/dev/null)"
    [ -n "$_R" ] && ROOT="$(cd "$_R" 2>/dev/null && pwd -P)"
    DIR="$CWD0" WORD="" INPLACE=0 SKIP=0 AWKINC=0 CUR=() SEEN=$'\n' TOTAL=0
    # A command's files are classed when the command ENDS, so `-i` counts
    # wherever it sits among the operands.
    flush() {
      local f
      for f in "${CUR[@]}"; do
        if [ "$INPLACE" = 1 ]; then EDITED+=("$f"); else STUDIED+=("$f"); fi
      done
      CUR=() WORD="" INPLACE=0 SKIP=0 AWKINC=0
    }
    while IFS= read -r T; do
      case "$T" in ';'|'&'|'|'|'('|')') flush; continue ;; esac
      [ "$SKIP" = 1 ] && { SKIP=0; continue; }
      case "$T" in
        # Heredoc / here-string operators: what follows is data, not a file.
        '<<'|'<<-'|'<<<') SKIP=1; continue ;;
        '<<'*) continue ;;
        # Output redirection names a file written, not read: drop the operator
        # and, when detached (`> out`), the target after it.
        *'>') SKIP=1; continue ;;
        *'>'*) continue ;;
      esac
      if [ -z "$WORD" ]; then
        case "$T" in *=*) continue ;; esac   # FOO=bar prefix assignments
        WORD="${T##*/}"; continue            # /usr/bin/sed → sed
      fi
      case "$WORD" in
        cd)
          case "$T" in /*) DIR="$T" ;; "~") DIR="$HOME" ;; "~"/*) DIR="$HOME/${T#"~/"}" ;; *) DIR="$DIR/$T" ;; esac
          WORD="cd:done" ;;
        cat|sed|gsed|awk|gawk|nawk|mawk)
          if [ "$AWKINC" = 1 ]; then
            AWKINC=0; case "$T" in inplace|inplace.awk) INPLACE=1 ;; esac; continue
          fi
          case "$WORD:$T" in
            *sed:--in-place*) INPLACE=1 ;;
            *sed:--*) ;;
            *sed:-*i*) INPLACE=1 ;;                         # -i, -Ei, -ni, -i.bak
            *awk:-i|*awk:--include) AWKINC=1 ;;             # gawk -i inplace
            *awk:-iinplace*|*awk:--include=inplace*) INPLACE=1 ;;
            *:-*|*:'<') ;;
            *)
              [ "$TOTAL" -lt "$MAX_REFS" ] || continue
              file_ref "$DIR" "${T#<}"
              [ -n "$R" ] || continue
              case "$SEEN" in *$'\n'"$R"$'\n'*) continue ;; esac
              SEEN="$SEEN$R"$'\n'; TOTAL=$((TOTAL + 1)); CUR+=("$R") ;;
          esac ;;
      esac
    done <<< "$TOKENS"
    flush
    [ "${#STUDIED[@]}" -gt 0 ] || [ "${#EDITED[@]}" -gt 0 ] || exit 0
    ;;
  *) exit 0 ;;
esac

[ -n "$ROOT" ] || exit 0
WORKSPACE="$(basename "$ROOT")"

# One beacon per activity. Refs travel as positional args, never re-split.
beacon() {
  local a="$1"; shift
  [ "$#" -gt 0 ] || return 0
  jq -cn --arg s "$SESSION" --arg r "$ROOT" --arg w "$WORKSPACE" --arg a "$a" \
    '{session_id:$s, repo_path:$r, workspace:$w, activity:$a, refs:$ARGS.positional}' --args "$@"
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
