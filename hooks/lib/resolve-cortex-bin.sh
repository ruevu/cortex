#!/usr/bin/env bash
# Shared cortex CLI resolution — sourced by every hook that shells out to the
# CLI (check-index.sh, post-commit-refresh.sh, prefer-cortex.sh, brief-edit.sh)
# so they cannot disagree about WHICH Cortex they run. They used to: two hooks
# honoured $CORTEX_BIN and two ignored it, and the two that ignored it fell
# back to the open repo's own ./bin/cortex (T-085p).
#
# Resolution order:
#   1. $CORTEX_BIN — an embedding host's explicit choice. Mesh exports its
#      bundled sidecar CLI here, and its plugin root (the sidecar tarball)
#      ships no bin/cortex, so this is the ONLY way a Mesh session reaches the
#      Cortex it pinned. When set it is authoritative: if it is not
#      executable, resolution FAILS (with a reason) instead of falling through
#      to some other copy — a host that pinned a version must never silently
#      get a different one.
#   2. $CLAUDE_PLUGIN_ROOT/bin/cortex — the installed plugin's own launcher.
#   3. `cortex` on PATH.
#
# Deliberately NOT the open repo's ./bin/cortex. Inside a Cortex checkout that
# runs whatever version the checkout happens to hold — against the same
# .cortex/db the pinned sidecar serves — and outside one it does not exist.
# Either way it is never the Cortex the session was configured with.
#
# Usage:  . "$HOOK_DIR/lib/resolve-cortex-bin.sh"; resolve_cortex_bin
# Sets:   CORTEX_BIN_RESOLVED — absolute path, or empty when unresolvable
#         CORTEX_BIN_PROBLEM  — one-line reason when unresolvable, else empty
# Never fails; never prints.
resolve_cortex_bin() {
    CORTEX_BIN_RESOLVED=""
    CORTEX_BIN_PROBLEM=""

    if [ -n "${CORTEX_BIN:-}" ]; then
        case "$CORTEX_BIN" in
            /*) if [ -x "$CORTEX_BIN" ] && [ ! -d "$CORTEX_BIN" ]; then CORTEX_BIN_RESOLVED="$CORTEX_BIN"; fi ;;
            # Relative with a slash: anchor it to the directory the hook was
            # started in NOW — callers later `cd` to the checkout root, where
            # the same relative path would name a different file (or none).
            */*) if [ -x "$CORTEX_BIN" ] && [ ! -d "$CORTEX_BIN" ]; then
                     CORTEX_BIN_RESOLVED="$(cd "$(dirname "$CORTEX_BIN")" 2>/dev/null && pwd)/$(basename "$CORTEX_BIN")"
                 fi ;;
            *)   CORTEX_BIN_RESOLVED="$(command -v "$CORTEX_BIN" 2>/dev/null)" ;;
        esac
        [ -n "$CORTEX_BIN_RESOLVED" ] || CORTEX_BIN_PROBLEM="CORTEX_BIN is set but not executable: $CORTEX_BIN"
        return 0
    fi

    if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -x "$CLAUDE_PLUGIN_ROOT/bin/cortex" ]; then
        CORTEX_BIN_RESOLVED="$CLAUDE_PLUGIN_ROOT/bin/cortex"
        return 0
    fi

    CORTEX_BIN_RESOLVED="$(command -v cortex 2>/dev/null)"
    [ -n "$CORTEX_BIN_RESOLVED" ] || CORTEX_BIN_PROBLEM="no cortex CLI found (CORTEX_BIN unset, no bin/cortex under the plugin root, none on PATH)"
    return 0
}

# First meaningful line of a captured stderr file, for a one-line failure
# report. Skips npm/node chatter (`npm notice …`, `(node:123) Warning…`,
# `(Use \`node --trace-…`) and Chromium's own log lines
# (`[1119/105206.365849:ERROR:electron/…]`, printed by Mesh's Electron-as-node
# CLI on every run), and prefers a line naming an error — a Node crash prints
# `file:line` and the source excerpt before the `Error: …` line.
cortex_first_error_line() {
    [ -r "$1" ] || return 0
    awk '
        /^[[:space:]]*$/ || /^npm notice/ || /^\(node:[0-9]+\)/ || /^\(Use `node/ { next }
        /^\[[0-9]+\/[0-9.]+:[A-Z]+:/ { next }
        first == "" { first = $0 }
        /[Ee]rror/ && err == "" { err = $0 }
        END { line = (err != "" ? err : first); sub(/^[[:space:]]+/, "", line); print substr(line, 1, 200) }
    ' "$1" 2>/dev/null
}
