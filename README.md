# Pangolin GNOME Status Indicator (async fork)

A GNOME Shell extension that adds a status indicator and quick toggle for the
[Pangolin](https://github.com/fosrl/pangolin) VPN client. Shows connection
status in the system panel and provides connect/disconnect controls from the
quick settings menu.

Fork of
[arminwinkt/pangolin-gnome-status-indicator](https://github.com/arminwinkt/pangolin-gnome-status-indicator).

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
- Updates to an already-activated extension apply live through the shell's
  `ReloadExtension` D-Bus method — no restart needed after the first install.
- Subprocess/status helpers live in `status.js` with no Shell imports, so
  they are unit-testable outside the shell.

## Install

```bash
./install.sh
```

GNOME Shell only scans the extensions directory at startup, and GNOME 50
removed the `InstallBundle` D-Bus method, so the **first** activation needs
one logout/login. `install.sh` copies the files, marks the extension enabled,
and tells you when that is the case.

Once the shell knows the extension, re-running `install.sh` reloads it live
(`ReloadExtension`) — no logout needed. `./uninstall.sh` removes it live too.

Note: extensions installed from extensions.gnome.org load live because the
shell downloads and registers them in one step (`InstallRemoteExtension`);
that service only accepts extensions published on the EGO site.

## Uninstall

```bash
./uninstall.sh
```

## Requirements

- GNOME Shell 45+ (tested on 50.1)
- [Pangolin](https://github.com/fosrl/pangolin) VPN client installed and in
  your `PATH`
- `sudo` and `zenity` (graphical password prompt when connecting — creating
  the TUN device requires root)
- `ptyxis` (for the "Open Logs" action)

## Tests

Unit tests for the subprocess/status helpers (run outside the shell):

```bash
gjs -m test/status-test.mjs
```

Integration check in a sandboxed headless Shell:

```bash
TEST=$(mktemp -d)
mkdir -p "$TEST/data/gnome-shell/extensions/pangolin-indicator@yetanother.at" "$TEST/config"
cp metadata.json extension.js status.js stylesheet.css askpass.sh \
  "$TEST/data/gnome-shell/extensions/pangolin-indicator@yetanother.at/"
export XDG_DATA_HOME="$TEST/data" XDG_CONFIG_HOME="$TEST/config"
dbus-run-session -- bash -c \
  "gsettings set org.gnome.shell enabled-extensions \"['pangolin-indicator@yetanother.at']\" && \
   timeout 25 gnome-shell --headless > /tmp/gs-headless.log 2>&1 & sleep 14; \
   gnome-extensions info pangolin-indicator@yetanother.at"
```

`State: ACTIVE` with no `JS ERROR` lines in the Shell log means the extension
loads cleanly on this GNOME version.
