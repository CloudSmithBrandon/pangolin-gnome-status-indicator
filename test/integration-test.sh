#!/usr/bin/env bash
# Integration test: run the real extension in a headless GNOME Shell against
# a deterministic CLI stub, then assert on the extension's observable
# behavior (which stub commands were invoked, how many times, in what order).
#
# Two scenarios per run:
#   COLD: starts disconnected, no client process alive
#         -> auto-connect MUST spawn `up` exactly once
#   WARM: starts mid-negotiation with a live client process
#         -> `up` must NEVER be re-spawned (no destructive restart)
#
# The dconf database is PRE-SEEDED with `dconf compile` before the session
# starts (INI-style keyfile: groups are paths): runtime gsettings writes in
# a fresh dbus-run-session are a flush race, and gnome-shell reads the
# database file directly. autoconnect/keepalive default to true in the
# schema; only enabled-extensions needs seeding.
#
# Usage: bash test/integration-test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
UUID="pangolin-indicator@yetanother.at"

FAILURES=0

ok()   { printf '  \033[32m[ok]\033[0m      %s\n' "$1"; }
fail() { printf '  \033[31m[FAIL]\033[0m    %s\n' "$1"; FAILURES=$((FAILURES+1)); }
warn() { printf '  \033[33m[warn]\033[0m    %s\n' "$1"; }
info() { printf '  [info]    %s\n' "$1"; }
assert() { # assert <desc> <rc: 0=pass>
    if [ "$2" = "0" ]; then ok "$1"; else fail "$1"; fi
}

run_scenario() { # run_scenario <MODE>
    local MODE="$1"
    local WORK="$ROOT/.inttest-$MODE"
    rm -rf "$WORK"
    local STUB_DIR="$WORK/bin" SCENARIO="$WORK/scenario" CALLS="$WORK/calls.log" SHELL_LOG="$WORK/shell.log" INNER="$WORK/inner.sh"
    echo
    echo "=== scenario: $MODE"

    mkdir -p "$STUB_DIR" "$WORK/data/gnome-shell/extensions/$UUID/schemas" "$WORK/config/dconf" "$WORK/keyfile/org.gnome/shell"
    cp "$HERE/stub/pangolin" "$HERE/stub/pgrep" "$STUB_DIR/"
    chmod +x "$STUB_DIR/pangolin" "$STUB_DIR/pgrep"
    cp "$ROOT"/metadata.json "$ROOT"/extension.js "$ROOT"/prefs.js "$ROOT"/status.js "$ROOT"/net.js \
        "$WORK/data/gnome-shell/extensions/$UUID/"
    cp -r "$ROOT/icons" "$WORK/data/gnome-shell/extensions/$UUID/icons"
    cp "$ROOT"/schemas/*.gschema.xml "$WORK/data/gnome-shell/extensions/$UUID/schemas/"
    if ! glib-compile-schemas "$WORK/data/gnome-shell/extensions/$UUID/schemas/" 2>/dev/null; then
        fail "schema compile failed"
        return 1
    fi

    printf "['%s']" "$UUID" > "$WORK/keyfile/org.gnome/shell/enabled-extensions"
    dconf compile "$WORK/config/dconf/user" "$WORK/keyfile"

    : > "$CALLS"
    cat > "$INNER" <<INNER_EOF
set -x
export PATH="$STUB_DIR:\$PATH"
export XDG_DATA_HOME="$WORK/data" XDG_CONFIG_HOME="$WORK/config"
export STUB_LOG="$CALLS" STUB_SCENARIO="$SCENARIO"
if [ "$MODE" = "WARM" ]; then echo negotiating > "$SCENARIO"; else echo disconnected > "$SCENARIO"; fi
timeout 75 gnome-shell --headless > "$SHELL_LOG" 2>&1 &
SHELL_PID=\$!
sleep 6
gnome-extensions enable pangolin-indicator@yetanother.at
sleep 14
echo connected > "$SCENARIO"
sleep 25
if [ "$MODE" = "WARM" ]; then echo negotiating > "$SCENARIO"; else echo disconnected > "$SCENARIO"; fi
wait \$SHELL_PID
INNER_EOF

    dbus-run-session -- bash "$INNER" > "$WORK/inner.log" 2>&1
    local inner_rc=$?

    echo "  --- assertions"
    local ups status_calls errs
    ups=$(awk '$2 == "up"' "$CALLS" 2>/dev/null | wc -l)
    status_calls=$(grep -c 'status --json' "$CALLS" 2>/dev/null || true)
    status_calls=${status_calls:-0}
    errs=$(grep -c 'JS ERROR' "$SHELL_LOG" 2>/dev/null || true)
    errs=${errs:-0}
    # Errors inside the status-apply chain are logged by extension.js
    # (applyStatus wrapper) but swallowed by the poll's empty catch, so they
    # never reach the shell log as JS ERROR. A UI bug must fail the run.
    apply_errs=$(grep -c 'status apply failed' "$SHELL_LOG" 2>/dev/null || true)
    apply_errs=${apply_errs:-0}

    if [ "$inner_rc" -ne 0 ] && [ "$inner_rc" -ne 124 ]; then
        fail "inner script exited $inner_rc — tail:"
        sed 's/^/        /' "$WORK/inner.log" 2>/dev/null | tail -6
    fi

    if [ "$MODE" = "COLD" ]; then
        [ "$ups" -ge 2 ]
        assert "COLD: 'up' at login AND keepalive re-spawn after the drop ($ups)" $?
    else
        [ "$ups" -eq 0 ]
        assert "WARM: no destructive 'up' while a client is alive ($ups)" $?
    fi

    [ "$status_calls" -ge 4 ]
    assert "status polled ($status_calls polls)" $?

    [ "$errs" -eq 0 ]
    assert "no JavaScript errors ($errs)" $?

    [ "$apply_errs" -eq 0 ]
    assert "no swallowed status-apply errors ($apply_errs)" $?

    if [ "$FAILURES" -gt 0 ]; then
        warn "artifacts kept in $WORK for debugging"
        info "pangolin mentions in shell.log: $(grep -ic pangolin "$SHELL_LOG" 2>/dev/null)"
        info "inner.log trace head:"
        sed 's/^/        /' "$WORK/inner.log" 2>/dev/null | head -8
    else
        rm -rf "$WORK"
    fi
}

run_scenario COLD
run_scenario WARM

echo
if [ "$FAILURES" -eq 0 ]; then
    echo "integration: all assertions passed"
else
    echo "integration: $FAILURES assertion(s) failed"
fi
exit "$FAILURES"
