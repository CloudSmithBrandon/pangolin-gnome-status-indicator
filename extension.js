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

import {fetchJson} from './net.js';

import {
    buildUpArgs,
    compareVersions,
    execAsync,
    extractVersion,
    interpretStatus,
    parseAuthStatus,
    shortHost,
    summarizePeers,
} from './status.js';

const PANGOLIN_BINARY = 'pangolin';
const BRAND_ICON = 'pangolin-vpn-symbolic';
const STATUS_POLL_INTERVAL = 30;
const RAPID_POLL_INTERVAL = 2;
const RAPID_POLL_MAX_ATTEMPTS = 15;
const AUTOCONNECT_DELAY = 10;
const UPDATE_CHECK_DELAY = 20;
const CLI_RELEASES_URL = 'https://api.github.com/repos/fosrl/cli/releases/latest';

const PangolinToggle = GObject.registerClass(
class PangolinToggle extends QuickSettings.QuickMenuToggle {
    _init(extension) {
        super._init({
            title: 'Pangolin VPN',
            iconName: BRAND_ICON,
            toggleMode: true,
        });

        this._extension = extension;
        this._connected = false;
        this._busy = false;

        this.menu.setHeader(BRAND_ICON, 'Pangolin VPN', 'Disconnected');

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

        this._dashboardItem = this.menu.addAction('Open Dashboard', () => {
            if (this._serverUrl)
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

        // Settings-built argv; falls back to sudo -A (zenity askpass) when
        // the tunnel cannot be created unprivileged.
        this._extension.startTunnel()
            .then(ok => {
                if (ok)
                    this._extension.requestRapidPoll();
            })
            .catch(() => {})
            .finally(() => {
                this._busy = false;
            });
    }

    _disconnect() {
        this._setStatusConnecting();

        this._extension.stopTunnel()
            .then(() => this._extension.requestRapidPoll())
            .catch(() => {})
            .finally(() => {});
    }

    _setStatusConnecting() {
        this._connected = false;
        this.checked = false;
        this.subtitle = 'Connecting...';
        this.menu.setHeader(BRAND_ICON, 'Pangolin VPN', 'Connecting...');
        this._updateStatusSection(null);
    }

    updateStatus({connected, data, auth}) {
        this._connected = connected;
        this.checked = connected;
        this._serverUrl = auth?.serverUrl ?? null;
        this._dashboardItem.visible = connected && !!this._serverUrl;

        if (connected) {
            const summary = summarizePeers(data);
            const sites = summary.sites.filter(s => s.connected).map(s => s.name);
            const host = shortHost(auth?.serverUrl) ?? data?.orgId ?? 'Connected';
            const subtitle = sites.length > 0 ? `${host} · ${sites.join(', ')}` : host;
            this.subtitle = subtitle;
            this.menu.setHeader(BRAND_ICON, 'Pangolin VPN', subtitle);
        } else if (auth && !auth.loggedIn) {
            this.subtitle = 'Not signed in';
            this.menu.setHeader(BRAND_ICON, 'Pangolin VPN', 'Not signed in');
        } else {
            this.subtitle = 'Disconnected';
            this.menu.setHeader(BRAND_ICON, 'Pangolin VPN', 'Disconnected');
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
        this._indicator.icon_name = BRAND_ICON;

        this._toggle = new PangolinToggle(extension);
        this.quickSettingsItems.push(this._toggle);
    }

    applyStatus(status) {
        const {connected} = status;
        this._indicator.icon_name = connected ? BRAND_ICON : BRAND_ICON;
        this._indicator.visible = connected;
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
        this._lastKeepaliveKick = 0;
        this._settings = this.getSettings();

        // Themed icon shipped in the extension GResource (compiled at
        // install time); unregister on disable per the review guidelines.
        try {
            this._resource = Gio.Resource.load(
                GLib.build_filenamev([this.path, 'pangolin-indicator.gresource']));
            Gio.resources_register(this._resource);
        } catch (e) {
            this._resource = null;
            log(`pangolin-indicator: could not load icon resource: ${e.message}`);
        }

        this._indicator = new PangolinIndicator(this);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);

        this._startPolling();

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

        if (this._resource) {
            Gio.resources_unregister(this._resource);
            this._resource = null;
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
     * Start the tunnel with the configured flags. Tries unprivileged first
     * (current CLI builds internally run sudo even with file capabilities,
     * so this usually fails) and falls back to sudo -A (zenity askpass),
     * carrying the same settings flags either way.
     */
    startTunnel() {
        if (this._tunnelBusy)
            return Promise.resolve(false);
        this._tunnelBusy = true;
        this._desiredConnected = true;

        return this.runCommand(this.getUpArgs())
            .then(ok => ok ? true : this.runCommand(this.getUpArgs(), {sudo: true}))
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
        const remoteP = fetchJson(CLI_RELEASES_URL, this._cancellable)
            .then(data => data.tag_name)
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
                source = new MessageTray.Source({title: 'Pangolin VPN', iconName: BRAND_ICON});
                notification = new MessageTray.Notification({source, title, body});
            } else {
                source = new MessageTray.Source('Pangolin VPN', BRAND_ICON);
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

    /** Run `argv` detached; resolves true on exit status 0. */
    runCommand(argv, {sudo = false} = {}) {
        let finalArgv = [...argv];
        try {
            if (sudo) {
                // polkit (pkexec) instead of `sudo -A`: the authentication
                // dialog is native, and no user-writable helper script is
                // ever spawned with privileges (EGO requirement).
                const program = GLib.find_program_in_path(argv[0]);
                if (!program)
                    return Promise.resolve(false);
                finalArgv = ['pkexec', program, ...argv.slice(1)];
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
            log(`pangolin-indicator: failed to run ${finalArgv.join(' ')}: ${e.message}`);
            return Promise.resolve(false);
        }
    }

    /**
     * Open a terminal window running `argv`, falling back through terminal
     * emulators commonly present on GNOME systems. The wait is deliberately
     * NOT bound to the extension cancellable: disabling the extension (e.g.
     * on screen lock) must not kill a log window the user is reading.
     */
    launchTerminal(argv) {
        const launchers = {
            ptyxis: a => ['ptyxis', '--new-window', '--', ...a],
            'gnome-terminal': a => ['gnome-terminal', '--', ...a],
            kgx: a => ['kgx', '--', ...a],
            xterm: a => ['xterm', '-e', ...a],
        };
        const emulator = Object.keys(launchers).find(t => GLib.find_program_in_path(t) !== null);
        if (!emulator) {
            Main.notify('Pangolin VPN', 'No terminal emulator found to open the requested view.');
            return;
        }
        try {
            const launcher = new Gio.SubprocessLauncher();
            const proc = launcher.spawnv(launchers[emulator](argv));
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
                // user asking for it. Rate-limited so a dead network cannot
                // spin the reconnect loop.
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
        if (now - this._lastKeepaliveKick < 30)
            return;
        this._lastKeepaliveKick = now;
        this.startTunnel()
            .then(ok => {
                if (ok)
                    this.requestRapidPoll();
            })
            .catch(() => {});
    }

    applyStatus(status) {
        // Optional transition notifications: only fire on a real change, so
        // toggling through "connecting" cannot spam banners.
        const state = status.connected ? 'connected' : 'disconnected';
        if (state !== this._lastNotifyState && this._lastNotifyState !== undefined
                && this._settings?.get_boolean('notify-state')) {
            this._notifyWithActions(
                state === 'connected' ? 'Pangolin tunnel connected' : 'Pangolin tunnel disconnected',
                status.auth?.serverUrl ? shortHost(status.auth.serverUrl) : '',
                [['Settings', () => Main.extensionManager.openExtensionPrefs(this.uuid, this.metadata.name, {})]]);
        }
        this._lastNotifyState = state;

        this._indicator?.applyStatus(status);
    }

    _removeSource(field) {
        if (this[field]) {
            GLib.source_remove(this[field]);
            this[field] = null;
        }
    }
}
