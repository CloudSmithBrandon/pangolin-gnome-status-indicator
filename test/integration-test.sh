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
# Settings use the GSettings KEYFILE backend (GSETTINGS_BACKEND=keyfile):
# a fresh dbus-run-session's dconf-service cannot reliably flush runtime
# writes, so the session reads settings from a plain keyfile we pre-seed.
# autoconnect/keepalive default true; only enabled-extensions is needed.
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

    mkdir -p "$STUB_DIR" "$WORK/data/gnome-shell/extensions/$UUID/schemas" "$WORK/config/gsettings"
    cp "$HERE/stub/pangolin" "$STUB_DIR/pangolin"
    chmod +x "$STUB_DIR/pangolin"
    cp "$ROOT"/metadata.json "$ROOT"/extension.js "$ROOT"/prefs.js "$ROOT"/status.js "$ROOT"/net.js \
        "$WORK/data/gnome-shell/extensions/$UUID/"
    cp "$ROOT"/schemas/*.gschema.xml "$WORK/data/gnome-shell/extensions/$UUID/schemas/"
    if ! glib-compile-schemas "$WORK/data/gnome-shell/extensions/$UUID/schemas/" 2>/dev/null; then
        fail "schema compile failed"
        return 1
    fi

    # Keyfile backend settings: enabled-extensions is the only key needed
    # (autoconnect/keepalive default to true in the schema).
    cat > "$WORK/config/gsettings/keys" <<KEYS_EOF
[org/gnome/shell]
enabled-extensions=['$UUID']

[org/gnome/shell/extensions/$UUID]
autoconnect=true
keepalive=true
KEYS_EOF

    cat > "$INNER" <<INNER_EOF
set -x
export PATH="$STUB_DIR:\$PATH"
export XDG_DATA_HOME="$WORK/data" XDG_CONFIG_HOME="$WORK/config"
export GSETTINGS_BACKEND=keyfile
export STUB_LOG="$CALLS" STUB_SCENARIO="$SCENARIO"
if [ "$MODE" = "WARM" ]; then echo negotiating > "$SCENARIO"; else echo disconnected > "$SCENARIO"; fi
timeout 60 gnome-shell --headless > "$SHELL_LOG" 2>&1 &
SHELL_PID=\$!
sleep 25
echo connected > "$SCENARIO"
sleep 15
if [ "$MODE" = "WARM" ]; then echo negotiating > "$SCENARIO"; else echo disconnected > "$SCENARIO"; fi
wait \$SHELL_PID
INNER_EOF

    dbus-run-session -- bash "$INNER" > "$WORK/inner.log" 2>&1
    local inner_rc=$?

    echo "  --- assertions"
    local ups status_calls errs
    ups=$(awk '$2 == "up"' "$CALLS" 2>/dev/null | wc -l)
    status_calls=$(grep -c 'status --json' "$CALLS" 2>/dev/null)
    errs=$(grep -c 'JS ERROR' "$SHELL_LOG" 2>/dev/null)

    if [ "$inner_rc" -ne 0 ]; then
        fail "inner script exited $inner_rc — tail:"
        sed 's/^/        /' "$WORK/inner.log" 2>/dev/null | tail -6
    fi

    if [ "$MODE" = "COLD" ]; then
        [ "$ups" -eq 1 ]
        assert "COLD: auto-connect spawned 'up' exactly once ($ups)" $?
    else
        [ "$ups" -eq 0 ]
        assert "WARM: no destructive 'up' while a client is alive ($ups)" $?
    fi

    [ "$status_calls" -ge 4 ]
    assert "status polled ($status_calls polls)" $?

    [ "$errs" -eq 0 ]
    assert "no JavaScript errors ($errs)" $?

    if [ "$FAILURES" -gt 0 ]; then
        warn "artifacts kept in $WORK for debugging"
        if [ -f "$SHELL_LOG" ]; then
            info "shell.log error tail:"
            grep -iE 'error|pangolin' "$SHELL_LOG" | tail -6 | sed 's/^/        /'
        fi
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
