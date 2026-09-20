# Pangolin GNOME Status Indicator (async fork)

A GNOME Shell extension that adds a status indicator and quick toggle for the
[Pangolin](https://github.com/fosrl/pangolin) VPN client. Shows connection
status in the system panel and provides connect/disconnect controls from the
quick settings menu, plus a full settings window.

Fork of
[arminwinkt/pangolin-gnome-status-indicator](https://github.com/arminwinkt/pangolin-gnome-status-indicator).

## Features

- Connection status in the panel and quick settings, with server and site
  details in the tile menu
- Connect/disconnect from the quick settings tile
- Keep-alive: optionally reconnect automatically when the tunnel drops
- Open Dashboard menu entry for the enrolled server
- **Settings window** (gear entry in the tile menu) covering the CLI's
  tunnel flags: auto-connect at login, interface name, upstream DNS,
  DNS override, local-route preference, direct connections, MTU, log level
  and tunnel domains — every setting with plain-language help text
- **Auto-connect at login** (off/on in settings)
- **Update check** for the Pangolin CLI against the official releases, with
  a one-press install that runs in a visible terminal
- View Logs opens a live-following log stream in Ptyxis

## Changes in this fork

- **Fully asynchronous subprocess handling** (`Gio.Subprocess`), including the
  periodic status poll. The original used `GLib.spawn_command_line_sync`,
  which blocks the GNOME Shell process for the duration of the command —
  also the reason the original submission was rejected from
  extensions.gnome.org.
- The daemon's own `connected` flag from `status --json` is respected instead
  of assuming any running client is connected.
- All timer sources are tracked and removed on disable; in-flight subprocesses
  are cancelled through a shared `GCancellable`.
- Connect attempts are guarded against double-clicks, and the rapid poll that
  follows up/down is genuinely bounded — a failed connect can no longer spin
  a 2-second poll loop indefinitely.
- Installer is honest about GNOME's session-start code loading: one
  logout/login activates, the same rule GNOME's own EGO updates follow on
  Wayland.
- Subprocess/status helpers live in `status.js` with no Shell imports, so
  they are unit-testable outside the shell.

## Install

```bash
./install.sh
```

GNOME Shell only scans the extensions directory at startup, and GNOME 50
removed the `InstallBundle` D-Bus method, so the **first** activation needs
one logout/login. `install.sh` copies the files (compiling the GSettings
schema), marks the extension enabled, and tells you when that is the case.
Code updates are the same: GNOME imports extension code once per session, so
re-running `install.sh` after a change also needs one logout (on X11,
`Alt+F2 → r` suffices).

### One-time system setup

The Pangolin CLI performs its own privileged operations: when it cannot
create the tunnel unprivileged, the extension escalates through `pkexec`,
so you get GNOME's native password dialog — no `setcap` or `sudoers`
configuration is required.

If you previously ran the Pangolin CLI as an unattended systemd service
(e.g. `pangolin-cli.service`), remove it so it stops fighting the extension
over the tunnel state:

```bash
sudo systemctl disable --now pangolin-cli.service && \
  sudo rm /etc/systemd/system/pangolin-cli.service
```

`install.sh` detects a leftover service and prints this command for you.

## Uninstall

```bash
./uninstall.sh
```

## Requirements

- GNOME Shell 45+ (tested on 50.1)
- [Pangolin](https://github.com/fosrl/pangolin) VPN client installed and in
  your `PATH`
- `glib-compile-schemas` (present on GNOME systems; compiles the settings
  schema at install time)
- A polkit authentication agent (GNOME provides one) for the tunnel
  password dialog
- Any terminal emulator (ptyxis, gnome-terminal, GNOME Console or xterm)
  for View Logs, Sign In and CLI updates

## Tests

Unit tests for the subprocess/status/argument-builder helpers (run outside
the shell):

```bash
gjs -m test/status-test.mjs
```

Integration check in a sandboxed headless Shell:

```bash
TEST=$(mktemp -d)
mkdir -p "$TEST/data/gnome-shell/extensions/pangolin-indicator@yetanother.at/schemas" "$TEST/config"
cp metadata.json extension.js prefs.js status.js askpass.sh \
  "$TEST/data/gnome-shell/extensions/pangolin-indicator@yetanother.at/"
cp schemas/*.gschema.xml "$TEST/data/gnome-shell/extensions/pangolin-indicator@yetanother.at/schemas/"
glib-compile-schemas "$TEST/data/gnome-shell/extensions/pangolin-indicator@yetanother.at/schemas/"
export XDG_DATA_HOME="$TEST/data" XDG_CONFIG_HOME="$TEST/config"
dbus-run-session -- bash -c \
  "gsettings set org.gnome.shell enabled-extensions \"['pangolin-indicator@yetanother.at']\" && \
   timeout 25 gnome-shell --headless > /tmp/gs-headless.log 2>&1 & sleep 14; \
   gnome-extensions info pangolin-indicator@yetanother.at"
```

`State: ACTIVE` with no `JS ERROR` lines in the Shell log means the extension
loads cleanly on this GNOME version.
