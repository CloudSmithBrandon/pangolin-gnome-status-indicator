// Pangolin VPN Status — GNOME Shell quick settings indicator.
//
// Fork of arminwinkt/pangolin-gnome-status-indicator with fully asynchronous
// subprocess handling (Gio.Subprocess instead of GLib.spawn_command_line_sync),
// tracked timer sources, and cancellation on disable, so the shell never
// blocks on a status poll.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';

import {CLI_RELEASES_URL, fetchFinalUrl} from './net.js';

import {
    buildUpArgs,
    compareVersions,
    execAsync,
    extractVersion,
    interpretStatus,
    parseAuthStatus,
    shortHost,
    summarizePeers,
    terminalArgv,
    versionFromReleaseRedirect,
} from './status.js';

const PANGOLIN_BINARY = 'pangolin';
const STATUS_POLL_INTERVAL = 30;
const RAPID_POLL_INTERVAL = 2;
const RAPID_POLL_MAX_ATTEMPTS = 30;
const AUTOCONNECT_DELAY = 10;
const UPDATE_CHECK_DELAY = 20;
// Seconds between keepalive reconnect attempts; also the rate limit that
// keeps the drop-observation kick and the poll-time kick from churning.
const KEEPALIVE_KICK_INTERVAL = 30;

// Server URLs come from the enrolled server (parsed CLI output); only ever
// hand a plain https URI to the platform launcher — never file:// or a
// custom handler scheme. Module scope: used from both the menu action and
// updateStatus.
const dashboardOpenable = url => typeof url === 'string' && url.startsWith('https://');

const PangolinToggle = GObject.registerClass(
class PangolinToggle extends QuickSettings.QuickMenuToggle {
    _init(extension) {
        super._init({
            title: 'Pangolin',
            gicon: extension.brandGicon,
            toggleMode: true,
        });

        this._extension = extension;
        this._connected = false;
        this._busy = false;

        this.menu.setHeader(null, 'Pangolin', 'Disconnected');

        this._statusSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._statusSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this.menu.addAction('View Logs', () => {
            this._extension.launchTerminal([PANGOLIN_BINARY, 'logs', 'client', '-f', '-n', '200']);
        });

        this._signInItem = this.menu.addAction('Sign In…', () => {
            this._extension.launchTerminal([PANGOLIN_BINARY, 'login']);
        });
        this._signInItem.visible = false;

        // The server URL ultimately comes from the enrolled server (parsed
        // from CLI output); only ever hand an https URI to the platform
        // launcher — never a file:// or handler scheme.
        this._dashboardItem = this.menu.addAction('Open Dashboard', () => {
            if (dashboardOpenable(this._serverUrl))
                Gio.AppInfo.launch_default_for_uri(this._serverUrl, null);
        });
        this._dashboardItem.visible = false;
        this.menu.addAction('Settings…', () => {
            this.menu.close();
            Main.extensionManager.openExtensionPrefs(this._extension.uuid, this._extension.metadata.name, {});
        }, 'emblem-system-symbolic');

        this.connect('clicked', () => this._onToggle());
    }

    _onToggle() {
        if (this._busy || this._extension.isTunnelBusy())
            return;
        if (this._connected)
            this._disconnect();
        else
            this._connect();
    }

    _connect() {
        this._busy = true;
        this._setStatusConnecting();

        // Settings-built argv; escalates through pkexec (native polkit
        // password dialog) when the CLI cannot run unprivileged.
        this._extension.startTunnel()
            .then(ok => {
                if (ok) {
                    this._extension.requestRapidPoll();
                    // A deliberate user connect resets the keepalive
                    // backoff so a later drop is retried promptly.
                    this._extension._kickBackoff = 0;
                } else {
                    // User-initiated: silence here would look like the tile
                    // lying. Auto-connect/keepalive retries stay silent.
                    Main.notify('Pangolin VPN',
                        'Could not start the tunnel — see View Logs for details.');
                }
            })
            .catch(() => {})
            .finally(() => {
                this._busy = false;
            });
    }

    _disconnect() {
        this._connected = false;
        this.checked = false;
        this.subtitle = 'Disconnecting...';
        this.menu.setHeader(null, 'Pangolin', 'Disconnecting...');
        this._updateStatusSection(null);

        this._extension.stopTunnel()
            .then(() => this._extension.requestRapidPoll())
            .catch(() => {});
    }

    _setStatusConnecting() {
        this._connected = false;
        this.checked = false;
        this.subtitle = 'Connecting...';
        this.menu.setHeader(null, 'Pangolin', 'Connecting...');
        this._updateStatusSection(null);
    }

    updateStatus({connected, data, auth}) {
        this._connected = connected;
        this.checked = connected;
        this._serverUrl = auth?.serverUrl ?? null;
        this._dashboardItem.visible = connected && dashboardOpenable(this._serverUrl);

        if (connected) {
            const summary = summarizePeers(data);
            const sites = summary.sites.filter(s => s.connected).map(s => s.name);
            const host = shortHost(auth?.serverUrl) ?? data?.orgId ?? 'Connected';
            const subtitle = sites.length > 0 ? `${host} · ${sites.join(', ')}` : host;
            this.subtitle = subtitle;
            this.menu.setHeader(null, 'Pangolin', subtitle);
        } else if (auth && !auth.loggedIn) {
            this.subtitle = 'Not signed in';
            this.menu.setHeader(null, 'Pangolin', 'Not signed in');
        } else {
            this.subtitle = 'Disconnected';
            this.menu.setHeader(null, 'Pangolin', 'Disconnected');
        }

        this._signInItem.visible = !connected && auth?.loggedIn === false;
        this._updateStatusSection({connected, data, auth});
    }

    _updateStatusSection({connected, data, auth}) {
        this._statusSection.removeAll();

        if (!connected || !data)
            return;

        const summary = summarizePeers(data);
        const rows = [];
        if (auth?.serverUrl)
            rows.push(['Server', auth.serverUrl]);
        if (auth?.user)
            rows.push(['User', auth.user]);
        if (data.orgId)
            rows.push(['Org', data.orgId]);

        for (const site of summary.sites.filter(s => s.connected)) {
            const rtt = site.rtt !== null ? `, ${site.rtt} ms` : '';
            const relay = site.isRelay ? ' (relay)' : '';
            rows.push(['Site', `${site.name}${relay}${rtt}`]);
        }

        if (summary.tunnelIps.length > 0)
            rows.push(['Tunnel IP', summary.tunnelIps.join(', ')]);
        if (data.version) {
            const remote = this._extension.lastRemoteVersion();
            const stale = remote && compareVersions(remote, data.version) > 0;
            rows.push(['CLI', `v${data.version}` + (stale ? ` — v${remote} available` : '')]);
        }

        for (const [key, value] of rows) {
            this._statusSection.addMenuItem(new PopupMenu.PopupMenuItem(
                `${key}: ${value}`, {reactive: false}));
        }
    }
});

const PangolinIndicator = GObject.registerClass(
class PangolinIndicator extends QuickSettings.SystemIndicator {
    _init(extension) {
        super._init();

        this._indicator = this._addIndicator();
        this._indicator.gicon = extension.brandGicon;

        this._toggle = new PangolinToggle(extension);
        this.quickSettingsItems.push(this._toggle);
    }

    applyStatus(status) {
        this._indicator.visible = status.connected;
        this._toggle.updateStatus(status);
    }

    destroy() {
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});

export default class PangolinStatusExtension extends Extension {
    enable() {
        this._cancellable = new Gio.Cancellable();
        this._pollSource = null;
        this._rapidSource = null;
        this._autoConnectSource = null;
        this._updateSource = null;
        this._pollInFlight = false;
        this._rapidAttempts = 0;
        this._auth = null;
        this._tunnelBusy = false;
        this._desiredConnected = null;
        this._lastSeenConnected = null;
        this._lastKeepaliveKick = 0;
        // Grows after consecutive failed keepalive escalations so a
        // cancelled polkit dialog cannot re-prompt every tick.
        this._kickBackoff = 0;
        this._settings = this.getSettings();

        this._indicator = new PangolinIndicator(this);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);

        this._startPolling();
        this._installNetworkMonitor();

        if (this._settings.get_boolean('autoconnect')) {
            this._autoConnectSource = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, AUTOCONNECT_DELAY, () => {
                this._autoConnectSource = null;
                this._autoConnect();
                return GLib.SOURCE_REMOVE;
            });
        }

        if (this._settings.get_boolean('check-updates-at-login')) {
            this._updateSource = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, UPDATE_CHECK_DELAY, () => {
                this._updateSource = null;
                this.checkForUpdates(true).catch(() => {});
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    disable() {
        this._cancellable?.cancel();
        this._cancellable = null;

        if (this._nmProxy) {
            if (this._nmSignal)
                this._nmProxy.disconnect(this._nmSignal);
            this._nmProxy = null;
        }

        this._removeSource('_pollSource');
        this._removeSource('_rapidSource');
        this._removeSource('_autoConnectSource');
        this._removeSource('_updateSource');

        this._indicator?.destroy();
        this._indicator = null;
    }

    /** Build the `pangolin up` argv from the current GSettings values. */
    getUpArgs() {
        const s = this._settings;
        return buildUpArgs({
            interfaceName: s.get_string('interface-name'),
            mtu: s.get_int('mtu'),
            logLevel: s.get_string('log-level'),
            upstreamDns: s.get_string('upstream-dns'),
            overrideDns: s.get_boolean('override-dns'),
            preferLocalRoutes: s.get_boolean('prefer-local-routes'),
            holepunch: s.get_boolean('holepunch'),
            matchDomains: s.get_string('match-domains'),
        });
    }

    isTunnelBusy() {
        return this._tunnelBusy === true;
    }

    /** Latest CLI release seen by the update check, for menu display. */
    lastRemoteVersion() {
        return this._settings?.get_string('last-remote-version') ?? '';
    }

    /**
     * The brand icon ships inside the extension directory and is loaded by
     * direct path: this never depends on icon-theme search paths, which do
     * not reliably include extension files. The `-symbolic` basename lets
     * Shell recolor it with the theme.
     */
    get brandGicon() {
        return Gio.icon_new_for_string(
            GLib.build_filenamev([this.path, 'icons', 'pangolin-vpn-symbolic.svg']));
    }

    /**
     * Start the tunnel with the configured flags. Tries unprivileged first
     * (current CLI builds internally escalate even with file capabilities,
     * so this usually fails) and falls back to pkexec (polkit dialog),
     * carrying the same settings flags either way.
     */
    startTunnel() {
        if (this._tunnelBusy)
            return Promise.resolve(false);
        this._tunnelBusy = true;
        this._desiredConnected = true;

        // The tile can lag reality during relay negotiation (30-40s). A
        // fresh check here prevents a stale "disconnected" view from
        // replacing a healthy running tunnel.
        return this.getStatus()
            .then(status => {
                if (status.connected) {
                    this.requestRapidPoll();
                    return true;
                }
                // A client process can still be alive while it negotiates a
                // relay path; spawning `up` again would kill and restart it.
                // Any user's client counts, including a root-run one: the
                // CLI coordinates through a shared control socket, so a
                // foreign client is adopted, never duplicated or killed.
                return execAsync(['pgrep', '-f', '(^|/)pangolin (up|watchdog)( |$)'], this._cancellable, 3000)
                    .then(r => {
                        if ((r.ok && r.stdout.trim() !== '')) {
                            this.requestRapidPoll();
                            return true;
                        }
                        return this.runCommand(this.getUpArgs())
                            .then(ok => ok ? true : this.runCommand(this.getUpArgs(), {escalate: true}));
                    })
                    .catch(() => this.runCommand(this.getUpArgs())
                        .then(ok => ok ? true : this.runCommand(this.getUpArgs(), {escalate: true})));
            })
            .finally(() => {
                this._tunnelBusy = false;
            });
    }

    /** Stop the tunnel; the control socket allows this unprivileged. */
    stopTunnel() {
        if (this._tunnelBusy)
            return Promise.resolve(false);
        this._tunnelBusy = true;
        this._desiredConnected = false;

        return this.runCommand([PANGOLIN_BINARY, 'down'])
            .finally(() => {
                this._tunnelBusy = false;
            });
    }

    _autoConnect() {
        if (this._tunnelBusy || this._cancellable === null)
            return;

        this.getStatus().then(status => {
            if (this._cancellable === null || status.connected)
                return;
            this.startTunnel()
                .then(ok => {
                    if (ok)
                        this.requestRapidPoll();
                })
                .catch(() => {});
        }).catch(() => {});
    }

    /**
     * Compare the installed CLI with the latest GitHub release.
     * Resolves {local, remote, updateAvailable}; remote is null when the
     * release check could not be completed.
     */
    checkForUpdates(notifyWhenAvailable) {
        const localP = execAsync([PANGOLIN_BINARY, 'version'], this._cancellable)
            .then(r => extractVersion(r.stdout));
        // /releases/latest redirects to /tag/<version>: the final URL carries
        // the version and is not subject to the JSON API's rate limits.
        const remoteP = fetchFinalUrl(CLI_RELEASES_URL, this._cancellable)
            .then(url => versionFromReleaseRedirect(url))
            .catch(() => null);

        return Promise.all([localP, remoteP]).then(([local, remote]) => {
            if (remote === null || local === null)
                return {local, remote, updateAvailable: false};

            this._settings?.set_string('last-remote-version', remote);
            const updateAvailable = compareVersions(remote, local) > 0;
            if (updateAvailable && notifyWhenAvailable)
                this._notifyUpdate(remote);
            return {local, remote, updateAvailable};
        });
    }

    _notifyUpdate(remote) {
        this._notifyWithActions(
            'Pangolin CLI update available',
            `Version ${remote} is ready to install.`,
            [
                ['Install', () => this.launchTerminal([PANGOLIN_BINARY, 'update'])],
                ['Settings', () => Main.extensionManager.openExtensionPrefs(this.uuid, this.metadata.name, {})],
            ]);
    }

    /**
     * Post a notification with action buttons. MessageTray's constructor and
     * show APIs changed shape across GNOME 45/46, so both are supported and
     * anything unexpected falls back to a plain notification.
     */
    _notifyWithActions(title, body, actions) {
        try {
            const [major] = Config.PACKAGE_VERSION.split('.').map(Number);
            let source;
            let notification;
            if (major >= 46) {
                source = new MessageTray.Source({title: 'Pangolin VPN', iconName: 'pangolin-vpn-symbolic'});
                notification = new MessageTray.Notification({source, title, body});
            } else {
                source = new MessageTray.Source('Pangolin VPN', 'pangolin-vpn-symbolic');
                notification = new MessageTray.Notification(source, title, body);
            }
            for (const [label, callback] of actions)
                notification.addAction(label, callback);
            Main.messageTray.add(source);
            if (typeof source.showNotification === 'function')
                source.showNotification(notification);
            else
                source.notify(notification);
        } catch {
            Main.notify(title, body);
        }
    }

    /**
     * Query `pangolin status --json`; resolves with {connected, data}.
     * Rejects only on spawn failure or cancellation.
     */
    async getStatus() {
        return interpretStatus(
            await execAsync([PANGOLIN_BINARY, 'status', '--json'], this._cancellable));
    }

    /**
     * Query `pangolin auth status`; resolves with {loggedIn, serverUrl, user}.
     * Rejects only on spawn failure or cancellation.
     */
    async getAuthStatus() {
        return parseAuthStatus(
            await execAsync([PANGOLIN_BINARY, 'auth', 'status'], this._cancellable));
    }

    /**
     * Combined status: tunnel state plus the last known auth snapshot.
     * The auth probe is only refreshed during full polls; rapid ticks reuse
     * the cache so connecting stays snappy.
     */
    async _fetchStatus() {
        // Auth rarely changes while connected: probe it on the first poll,
        // whenever it looked signed-out, and every 5th poll after that.
        this._pollCount = (this._pollCount ?? 0) + 1;
        const authStale = !this._auth?.loggedIn;
        if (authStale || this._pollCount % 5 === 1) {
            const auth = await this.getAuthStatus().catch(() => null);
            if (auth !== null)
                this._auth = auth;
        }
        return {...(await this.getStatus()), auth: this._auth};
    }

    /** Run `argv`; with escalate, spawn through pkexec (polkit dialog). */
    runCommand(argv, {escalate = false} = {}) {
        let finalArgv;
        try {
            // Resolve argv[0] to an absolute path explicitly: GIO's
            // PATH-search behavior differs across launcher APIs, and an
            // absolute path makes both branches behave identically.
            const program = GLib.find_program_in_path(argv[0]);
            if (!program)
                return Promise.resolve(false);
            // Vet the file that would actually execute, not the PATH-hit
            // string: canonicalize resolves symlinks, so a link planted at
            // a root-owned PATH location pointing into $HOME (or any
            // user-writable target) cannot smuggle past this guard.
            const real = GLib.canonicalize_filename(program, null);
            if (real.startsWith(`${GLib.get_home_dir()}/`)) {
                if (escalate) {
                    // A user-writable binary would run as root the moment
                    // the user types their polkit password. Refuse instead
                    // of executing it (the EGO rule is: no user-writable
                    // code ever runs with privileges). The unprivileged
                    // branch still works, so the CLI itself is unaffected.
                    console.warn(`pangolin-indicator: refusing pkexec escalation of ${real} — ` +
                        'reinstall the CLI system-wide (e.g. /usr/local/bin)');
                    return Promise.resolve(false);
                }
                console.warn(`pangolin-indicator: ${argv[0]} resolved inside your home directory ` +
                    '(/usr/local/bin is the expected install location)');
            }
            if (escalate) {
                // Code that runs as root must be modifiable by its owner
                // alone: refuse group/other-writable targets. A vanished
                // file fails closed.
                try {
                    const info = Gio.File.new_for_path(real).query_info(
                        Gio.FILE_ATTRIBUTE_UNIX_MODE, Gio.FileQueryInfoFlags.NONE, null);
                    if ((info.get_attribute_uint32(Gio.FILE_ATTRIBUTE_UNIX_MODE) & 0o022) !== 0) {
                        console.warn(`pangolin-indicator: refusing pkexec escalation of ` +
                            `group/other-writable ${real} — fix its permissions or reinstall system-wide`);
                        return Promise.resolve(false);
                    }
                } catch {
                    console.warn(`pangolin-indicator: refusing pkexec escalation — cannot stat ${real}`);
                    return Promise.resolve(false);
                }
                // polkit (pkexec) instead of `sudo -A`: the authentication
                // dialog is native, and no user-writable helper script is
                // ever spawned with privileges (EGO requirement). The user's
                // HOME is passed through so the CLI (running as root) still
                // reads the USER's enrollment configuration.
                finalArgv = ['pkexec', 'env', `HOME=${GLib.get_home_dir()}`,
                             program, ...argv.slice(1)];
            } else {
                finalArgv = [program, ...argv.slice(1)];
            }
            const launcher = new Gio.SubprocessLauncher();
            const proc = launcher.spawnv(finalArgv);
            return new Promise(resolve => {
                proc.wait_check_async(this._cancellable, (p, res) => {
                    try {
                        resolve(p.wait_check_finish(res));
                    } catch {
                        resolve(false);
                    }
                });
            });
        } catch (e) {
            // argv, not finalArgv: a failure before assignment must not
            // replace the original error with a TypeError of its own.
            log(`pangolin-indicator: failed to run ${argv.join(' ')}: ${e.message}`);
            return Promise.resolve(false);
        }
    }

    /**
     * Event-driven fast path: NetworkManager tells us when the tunnel
     * interface (or the network around it) changes state, so we refresh the
     * status immediately instead of waiting for the next poll tick. Polling
     * stays the source of truth; this only cuts latency. Best-effort: if
     * NetworkManager is unavailable the regular poll still covers us.
     */
    _installNetworkMonitor() {
        const proxy = new Gio.DBusProxy({
            g_connection: Gio.bus_get_sync(Gio.BusType.SYSTEM, this._cancellable),
            g_name: 'org.freedesktop.NetworkManager',
            g_object_path: '/org/freedesktop/NetworkManager',
            g_interface_name: 'org.freedesktop.NetworkManager',
        });
        proxy.init_async(GLib.PRIORITY_DEFAULT, this._cancellable, (p, res) => {
            try {
                p.init_finish(res);
            } catch {
                return; // NM not reachable; the poll loop still runs
            }
            this._nmProxy = p;
            this._nmDevicePath = null;
            this._nmNonTunnelDevices = new Set();
            this._nmSignal = p.connect('g-signal', (emitter, sender, signal, params) => {
                if (signal === 'DeviceStateChanged')
                    this._onDeviceStateChanged(params.deepUnpack()[0]);
            });
        });
    }

    _onDeviceStateChanged(devicePath) {
        if (devicePath === this._nmDevicePath) {
            this.requestRapidPoll();
            return;
        }
        if (!this._nmNonTunnelDevices)
            return;
        if (this._nmNonTunnelDevices.has(devicePath))
            return;

        const iface = this._settings?.get_string('interface-name') ?? 'pangolin';
        const device = new Gio.DBusProxy({
            g_connection: Gio.bus_get_sync(Gio.BusType.SYSTEM, null),
            g_name: 'org.freedesktop.NetworkManager',
            g_object_path: devicePath,
            g_interface_name: 'org.freedesktop.NetworkManager.Device',
        });
        device.init_async(GLib.PRIORITY_DEFAULT, null, (p, res) => {
            try {
                p.init_finish(res);
                if (p.Interface === iface) {
                    this._nmDevicePath = devicePath;
                    this.requestRapidPoll();
                } else {
                    this._nmNonTunnelDevices.add(devicePath);
                }
            } catch {
                this._nmNonTunnelDevices.add(devicePath);
            }
        });
    }

    /**
     * Open a terminal window running `argv`, falling back through terminal
     * emulators commonly present on GNOME systems. The wait is deliberately
     * NOT bound to the extension cancellable: disabling the extension (e.g.
     * on screen lock) must not kill a log window the user is reading.
     */
    launchTerminal(argv) {
        const termArgv = terminalArgv(argv);
        if (termArgv === null) {
            Main.notify('Pangolin VPN', 'No terminal emulator found to open the requested view.');
            return;
        }
        try {
            const launcher = new Gio.SubprocessLauncher();
            const proc = launcher.spawnv(termArgv);
            proc.wait_async(null, (p, res) => p.wait_finish(res));
        } catch (e) {
            Main.notify('Pangolin VPN', `Could not launch terminal: ${e.message}`);
        }
    }

    /**
     * Poll every RAPID_POLL_INTERVAL seconds until the status settles
     * (used right after up/down), bounded by RAPID_POLL_MAX_ATTEMPTS.
     */
    requestRapidPoll() {
        this._rapidAttempts = 0;
        this._scheduleRapidTick();
    }

    _scheduleRapidTick() {
        this._removeSource('_rapidSource');

        this._rapidSource = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, RAPID_POLL_INTERVAL, () => {
            this._rapidSource = null;
            this._rapidTick();
            return GLib.SOURCE_REMOVE;
        });
    }

    _rapidTick() {
        this._rapidAttempts++;

        this.getStatus().then(status => {
            if (this._cancellable === null)
                return; // disabled while the request was in flight
            if (status.connected || this._rapidAttempts >= RAPID_POLL_MAX_ATTEMPTS) {
                this.applyStatus({...status, auth: this._auth});
                return;
            }
            this._scheduleRapidTick(); // keep the attempt count; do not reset it
        }).catch(() => {});
    }

    _startPolling() {
        this._poll();

        this._pollSource = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, STATUS_POLL_INTERVAL, () => {
            this._poll();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _poll() {
        if (this._pollInFlight)
            return;

        this._pollInFlight = true;
        this._fetchStatus()
            .then(status => {
                this.applyStatus(status);

                // Adopt an already-running tunnel, and reconnect when the
                // keepalive setting is on and the tunnel dropped without the
                // user asking for it. This is the steady-state retry path;
                // applyStatus's transition kick is the immediate-reaction
                // path (also fires on rapid ticks). _keepaliveKick's rate
                // limit deduplicates the double call on a drop tick.
                if (status.connected && this._desiredConnected === null)
                    this._desiredConnected = true;
                const keepalive = this._settings?.get_boolean('keepalive') ?? false;
                if (!status.connected && keepalive && this._desiredConnected)
                    this._keepaliveKick();
            })
            .catch(() => {})
            .finally(() => {
                this._pollInFlight = false;
            });
    }

    _keepaliveKick() {
        const now = GLib.DateTime.new_now_utc().to_unix();
        // Rate limit, widened by _kickBackoff after consecutive failures
        // (60 s per failure, capped so the retry gap never exceeds 10 min).
        if (now - this._lastKeepaliveKick < KEEPALIVE_KICK_INTERVAL + this._kickBackoff)
            return;
        this._lastKeepaliveKick = now;
        this.startTunnel()
            .then(ok => {
                if (ok) {
                    this._kickBackoff = 0;
                    this.requestRapidPoll();
                } else {
                    this._kickBackoff = Math.min(this._kickBackoff + 60, 570);
                }
            })
            .catch(() => {
                this._kickBackoff = Math.min(this._kickBackoff + 60, 570);
            });
    }

    applyStatus(status) {
        try {
            this._applyStatus(status);
        } catch (e) {
            // A UI bug in this chain must be loud: it would otherwise be
            // swallowed by the poll's empty catch — invisible to the
            // journal AND to the harness (never reaches the JS ERROR log).
            // The harness asserts zero "status apply failed" lines.
            log(`pangolin-indicator: status apply failed: ${e?.message ?? e}`);
            throw e;
        }
    }

    _applyStatus(status) {
        const connected = status.connected;
        // Optional transition notifications: only fire on a real change, so
        // toggling through "connecting" cannot spam banners.
        const state = connected ? 'connected' : 'disconnected';
        if (state !== this._lastNotifyState && this._lastNotifyState !== undefined
                && this._settings?.get_boolean('notify-state')) {
            this._notifyWithActions(
                state === 'connected' ? 'Pangolin tunnel connected' : 'Pangolin tunnel disconnected',
                status.auth?.serverUrl ? shortHost(status.auth.serverUrl) : '',
                [['Settings', () => Main.extensionManager.openExtensionPrefs(this.uuid, this.metadata.name, {})]]);
        }
        this._lastNotifyState = state;

        // Keepalive: reconnect immediately when a connected tunnel drops
        // (state transition, not poll timer) while the user wants it up.
        // The rate limit and pgrep guard inside startTunnel prevent churn
        // and never kill a client that is still negotiating.
        if (this._lastSeenConnected === true && !connected
                && this._settings?.get_boolean('keepalive') && this._desiredConnected)
            this._keepaliveKick();
        this._lastSeenConnected = connected;

        this._indicator?.applyStatus(status);
    }

    _removeSource(field) {
        if (this[field]) {
            GLib.source_remove(this[field]);
            this[field] = null;
        }
    }
}
