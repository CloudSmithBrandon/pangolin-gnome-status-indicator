# Pangolin GNOME Status Indicator

A GNOME Shell extension that adds a status indicator and quick toggle for the
[Pangolin](https://github.com/fosrl/pangolin) VPN client. Shows connection
status in the system panel and provides connect/disconnect controls from the
quick settings menu, plus a full settings window.

## Features

- Connection status in the panel and quick settings, with server and site
  details in the tile menu
- Connect/disconnect from the quick settings tile
- Keep-alive: the tunnel reconnects automatically when it drops (on by
  default; disconnecting from the tile is always respected, and the setting
  can be turned off in preferences; retries back off if polkit
  authentication is cancelled, so you are never nagged with repeated
  password dialogs, and every failed attempt is journaled — View Logs)
- Open Dashboard menu entry for the enrolled server (https URLs only)
- **Settings window** (gear entry in the tile menu) covering the CLI's
  tunnel flags: auto-connect at login, interface name, upstream DNS,
  DNS override, local-route preference, direct connections, MTU, log level
  and tunnel domains — every setting with plain-language help text
- **Auto-connect at login**
- **Update check** for the Pangolin CLI against the official releases
  (redirect-based, so GitHub's unauthenticated API rate limit never
  interferes), with a one-press install that runs in a visible terminal
- View Logs opens a live-following log stream in your terminal emulator

## Credits

This is an extensively rewritten fork of
[arminwinkt/pangolin-gnome-status-indicator](https://github.com/arminwinkt/pangolin-gnome-status-indicator)
by **Armin Winkler**, who wrote the original extension. Thank you.

### Changes in this fork

- **Fully asynchronous subprocess handling** (`Gio.Subprocess`), including the
  periodic status poll. The original used `GLib.spawn_command_line_sync`,
  which blocks the GNOME Shell process for the duration of the command —
  also the reason the original submission was rejected from
  extensions.gnome.org.
- Privilege handling moved from `sudo` + `zenity` helpers to `pkexec`, so the
  native polkit dialog is used and no user-writable script is ever spawned
  with root privileges.
- The daemon's own `connected` flag from `status --json` is respected instead
  of assuming any running client is connected, and unknown status output
  fails closed (reported as disconnected) rather than optimistic.
- All timer sources are tracked and removed on disable; in-flight
  subprocesses are cancelled through a shared `GCancellable`.
- Connect attempts are guarded against double-clicks and against killing a
  client that is still negotiating; the rapid poll that follows up/down is
  genuinely bounded.
- Status interpretation and CLI argument building are unit-tested outside
  the shell, and a headless integration harness exercises login, drop and
  reconnect behavior in a sandboxed GNOME Shell session.
- Installer is honest about GNOME's session-start code loading: one
  logout/login activates, the same rule GNOME's own EGO updates follow on
  Wayland.

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

Removes the extension, the themed icon and the extension's settings.

## Requirements

- GNOME Shell 45+ (tested on 50.1)
- [Pangolin](https://github.com/fosrl/pangolin) VPN client installed and in
  your `PATH` — output shapes from CLI 0.16 and 0.17 are both handled
  (including 0.17's update banner before `--json` output). For the
  privileged tunnel path the CLI must be installed system-wide (e.g.
  `/usr/local/bin`): `pkexec` escalation refuses binaries resolved inside
  your home directory or writable by group/other.
- `glib-compile-schemas` (present on GNOME systems; compiles the settings
  schema at install time)
- A polkit authentication agent (GNOME provides one) for the tunnel
  password dialog
- Any terminal emulator (ptyxis, gnome-terminal, GNOME Console or xterm)
  for View Logs, Sign In and CLI updates

## Troubleshooting

- **The tile shows a broken/generic icon** — the icon is installed into your
  user hicolor directory and GNOME loads extension code at session start;
  run `./install.sh` once more and log out and back in.
- **The update check says "Up to date" but you know a release exists** —
  check the installed CLI version in Settings → Updates and compare with
  [github.com/fosrl/cli/releases](https://github.com/fosrl/cli/releases);
  the check needs working DNS and internet access.
- **Connect asks for a password, then fails** — View Logs (or
  `journalctl --user`) shows `refusing pkexec escalation`: the CLI was
  resolved inside your home directory or is group/other-writable.
  Reinstall it system-wide (the Pangolin installer defaults to
  `/usr/local/bin`).
- **Connecting takes 30–40 s and shows relay** — clients behind symmetric
  NAT or multi-homed machines cannot holepunch and fall back to a relay.
  This is expected Pangolin behavior; the tile shows *Connecting…* until
  negotiation finishes and never restarts a negotiating client.
- **The tunnel dies at logout** — systemd kills session processes at
  logout. With keep-alive on (default), the tunnel comes back at the next
  login; the `pangolin-cli.service` conflict above causes repeat drops.

## Security notes

- Privileged operations run the Pangolin CLI itself through `pkexec` —
  never a script. The CLI binary is installed by the Pangolin project's own
  installer (currently into `/usr/local/bin`, owned by your user); review
  that path when hardening multi-user machines.
- When the tunnel is escalated, `pkexec` runs the CLI as root with your
  `HOME` passed through, so the root process reads your user-owned
  enrollment configuration under your home directory. That is inherent to
  the CLI's design; this trust rests on the Pangolin CLI itself.
- Settings values are validated before they reach the CLI's argument list,
  so a malformed setting can only fall back to the CLI default, never add
  flags.
- The update check talks to `https://github.com/fosrl/cli` over HTTPS only
  (including after redirects) via libsoup — no external binaries, no
  credentials sent, nothing evaluated from the response body.

## Development

Unit tests for the subprocess/status/argument-builder helpers (run outside
the shell):

```bash
gjs -m test/status-test.mjs
```

Integration check — builds a sandboxed headless GNOME Shell session with a
stubbed CLI and asserts real behavior (COLD: auto-connect at login plus
keep-alive re-spawn after a drop; WARM: a live negotiating client is never
destructively restarted):

```bash
bash test/integration-test.sh
```

`integration: all assertions passed` is the release gate. Sandboxes are
kept under `.inttest-*/` on failure for debugging and cleaned up on success.

Build the extensions.gnome.org review zip (explicit allow-list: the harness
and installer scripts never ship):

```bash
./package.sh
```

## License

GPL-3.0-or-later — see [LICENSE](LICENSE). The fork parent carried no
license file at fork time; original work by Armin Winkler remains credited
above, and all rewrite work in this repository is released under the GPL.
