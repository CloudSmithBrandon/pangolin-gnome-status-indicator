#!/usr/bin/env bash
# Integration test: run the real extension in a headless GNOME Shell against
# a deterministic CLI stub, then assert on the extension's observable
# behavior (which stub commands were invoked, how many times, in what order).
#
# Scenarios covered:
#   A. auto-connect fires exactly once and follows up with rapid polling
#   B. keepalive re-runs `up` after the tunnel "drops" — rate-limited
#   C. no JavaScript errors during any of it
#
# Usage: bash test/integration-test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
UUID="pangolin-indicator@yetanother.at"
WORK="$(mktemp -d)"
STUB_DIR="$WORK/bin"
SCENARIO="$WORK/scenario"
CALLS="$WORK/calls.log"
SHELL_LOG="$WORK/shell.log"

mkdir -p "$STUB_DIR" "$WORK/data/gnome-shell/extensions/$UUID/schemas" "$WORK/config"
cp "$HERE/stub/pangolin" "$STUB_DIR/pangolin"
chmod +x "$STUB_DIR/pangolin"
cp "$ROOT"/{metadata.json,extension.js,prefs.js,status.js,net.js} \
    "$WORK/data/gnome-shell/extensions/$UUID/" 2>/dev/null
cp "$ROOT"/schemas/*.gschema.xml "$WORK/data/gnome-shell/extensions/$UUID/schemas/"
glib-compile-schemas "$WORK/data/gnome-shell/extensions/$UUID/schemas/" || exit 1

export PATH="$STUB_DIR:$PATH"
export XDG_DATA_HOME="$WORK/data"
export XDG_CONFIG_HOME="$WORK/config"
export STUB_LOG="$CALLS"
export STUB_SCENARIO="$SCENARIO"
: > "$CALLS"
echo "negotiating" > "$SCENARIO"    # start mid-negotiation: auto-connect must act

FAILURES=0
assert() { # assert <desc> <condition-result>
    if [ "$2" = "0" ]; then
        printf '  \033[32m[ok]\033[0m      %s\n' "$1"
    else
        printf '  \033[31m[FAIL]\033[0m    %s\n' "$1"
        FAILURES=$((FAILURES+1))
    fi
}

# Settings: auto-connect + keepalive both on, so both paths are exercised.
INNER="$WORK/inner.sh"
cat > "$INNER" <<INNER_EOF
set -x
export PATH="$STUB_DIR:\$PATH"
export XDG_DATA_HOME="$WORK/data" XDG_CONFIG_HOME="$WORK/config"
export GSETTINGS_SCHEMA_DIR="$WORK/data/gnome-shell/extensions/$UUID/schemas"
export STUB_LOG="$CALLS" STUB_SCENARIO="$SCENARIO"
gsettings set org.gnome.shell enabled-extensions "['$UUID']"
READBACK=\$(gsettings get org.gnome.shell enabled-extensions)
echo "enabled-extensions readback: \$READBACK"
case "\$READBACK" in *"$UUID"*) ;; *) echo "FATAL: extension not enabled"; exit 3 ;; esac
gsettings set org.gnome.shell.extensions.$UUID autoconnect true
gsettings set org.gnome.shell.extensions.$UUID keepalive true
timeout 75 gnome-shell --headless > "$SHELL_LOG" 2>&1 &
SHELL_PID=\$!
sleep 25
echo connected > "$SCENARIO"
sleep 15
echo negotiating > "$SCENARIO"
wait \$SHELL_PID
INNER_EOF

dbus-run-session -- bash "$INNER" 2>&1 | grep -vE 'SpiRegistry|KEYRING|CalendarServer|portal is not running|geolocation'

echo "=== integration assertions"

# A1: auto-connect ran the stub `up` (autoconnect delay is 10s)
grep -qE '^[0-9.]+ up( |$)' "$CALLS"
assert "auto-connect invoked 'up'" $?

# A2: exactly ONE up during the first 30s (no double-start churn)
EARLY=$(awk -v t="$(head -1 "$CALLS" | cut -d' ' -f1)" '$1 < t+30 && $2 == "up"' "$CALLS" | wc -l)
[ "$EARLY" -eq 1 ]
assert "no double-start: exactly one 'up' in the first 30s" $?

# A3: rapid polling followed the connect (status --json called repeatedly)
S=$(grep -c 'status --json' "$CALLS")
[ "$S" -ge 5 ]
assert "status polled rapidly after connect ($S polls)" $?

# B: keepalive kicked after the drop at t=40s (rate-limited to one kick/30s)
LATE_UPS=$(awk '$1 > 40 && $2 == "up"' "$CALLS" | wc -l)
[ "$LATE_UPS" -ge 1 ] && [ "$LATE_UPS" -le 2 ]
assert "keepalive re-ran 'up' after the drop, rate-limited ($LATE_UPS)" $?

# C: clean run
E=$(grep -c 'JS ERROR' "$SHELL_LOG")
[ "$E" -eq 0 ]
assert "no JavaScript errors in the shell ($E)" $?

# NM monitor must degrade gracefully in an environment without NM signals
E2=$(grep -ci 'networkmanager' "$SHELL_LOG")
echo "  [info]    NM mentions in log: $E2 (0 expected in headless)"

echo
if [ "$FAILURES" -eq 0 ]; then
    echo "integration: all assertions passed"
else
    echo "integration: $FAILURES assertion(s) failed"
    echo "--- stub calls:"; tail -20 "$CALLS"
    echo "--- shell log errors:"; grep -iE 'error|pangolin' "$SHELL_LOG" | tail -10
fi
rm -rf "$WORK"
exit "$FAILURES"
