#!/usr/bin/env bash
# PostToolUse hook (fires only on `git commit*` via the hooks.json `if`):
# refresh the index incrementally so the graph tracks the new HEAD. Safe to run
# mid-session because the write path builds into a staging DB and publishes via a
# single WAL transaction (publishStagedDb): the live .cortex/db is never
# truncated or unlinked out-of-band, so the MCP server's open handle sees the new
# snapshot with no reopen. Gated by CORTEX_AUTO_REFRESH.
#
# A REFRESH only: it acts on a checkout that already has a graph and leaves
# every other repo alone. First indexes belong to the SessionStart / grep-gate
# auto-index paths, which carry the denylist, the CORTEX_AUTO_INDEX gate and
# the 60-minute sentinel — committing in a repo used to full-index it with
# none of those.
#
# Silent on success. When the refresh cannot run or fails, it tells the agent
# (PostToolUse additionalContext) instead of swallowing it: this hook used to
# end in `>/dev/null 2>&1 || true`, so a broken CLI meant the graph quietly
# stopped tracking HEAD for the rest of the session (T-085p). The CLI comes
# from the shared resolver — $CORTEX_BIN → plugin root → PATH, never the open
# repo's ./bin/cortex (hooks/lib/resolve-cortex-bin.sh).
set -u
[ "${CORTEX_AUTO_REFRESH:-1}" = "0" ] && exit 0

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
[ -n "$ROOT" ] || exit 0
[ -s "$ROOT/.cortex/db" ] || [ -s "$ROOT/.cortex/graph.db" ] || exit 0

# One-line JSON string body: escape backslashes and quotes, drop control chars.
json_escape() { printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

tell_agent() {
    printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"%s"}}\n' \
        "$(json_escape "⚠ cortex: $1 The graph no longer tracks HEAD; refresh it with index_repository(repo_path=\"$ROOT\").")"
}

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [ -z "$HOOK_DIR" ] || [ ! -r "$HOOK_DIR/lib/resolve-cortex-bin.sh" ]; then
    tell_agent "post-commit refresh skipped — hooks/lib/resolve-cortex-bin.sh is missing from the plugin."
    exit 0
fi
# shellcheck source=lib/resolve-cortex-bin.sh
. "$HOOK_DIR/lib/resolve-cortex-bin.sh"
resolve_cortex_bin
if [ -z "$CORTEX_BIN_RESOLVED" ]; then
    tell_agent "post-commit refresh skipped — $CORTEX_BIN_PROBLEM."
    exit 0
fi

# No predictable fallback path if mktemp fails: lose the error line instead.
ERR="$(mktemp 2>/dev/null)"
(cd "$ROOT" && "$CORTEX_BIN_RESOLVED" index >/dev/null 2>"${ERR:-/dev/null}")
RC=$?
LINE=""
[ -n "$ERR" ] && LINE="$(cortex_first_error_line "$ERR")" && rm -f "$ERR" 2>/dev/null
if [ "$RC" -ne 0 ]; then
    case "$LINE" in
        # Lost the per-repo index lock to an index already running (SessionStart,
        # the background auto-index, an MCP index_repository). Not a broken
        # graph: that index publishes shortly, and the freshness verdict on the
        # next read reports anything it missed.
        *"database is locked"*|*SQLITE_BUSY*) ;;
        *) tell_agent "post-commit refresh failed (exit $RC): ${LINE:-no error output} ($CORTEX_BIN_RESOLVED)." ;;
    esac
fi
exit 0
