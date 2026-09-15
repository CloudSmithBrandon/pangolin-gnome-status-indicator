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

import {
    CONNECTED_ICON,
    CONNECTING_ICON,
    DISCONNECTED_ICON,
    execAsync,
    interpretStatus,
    parseAuthStatus,
    shortHost,
    summarizePeers,
} from './status.js';

const PANGOLIN_BINARY = 'pangolin';
const STATUS_POLL_INTERVAL = 30;
const RAPID_POLL_INTERVAL = 2;
const RAPID_POLL_MAX_ATTEMPTS = 15;

const PangolinToggle = GObject.registerClass(
class PangolinToggle extends QuickSettings.QuickMenuToggle {
    _init(extension) {
        super._init({
            title: 'Pangolin VPN',
            iconName: DISCONNECTED_ICON,
            toggleMode: true,
        });

        this._extension = extension;
        this._connected = false;
        this._busy = false;

        this.menu.setHeader(DISCONNECTED_ICON, 'Pangolin VPN', 'Disconnected');

        this._statusSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._statusSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this.menu.addAction('Open Logs', () => {
            this._extension.runCommand(['ptyxis', '--', PANGOLIN_BINARY, 'logs']);
        });

        this._signInItem = this.menu.addAction('Sign In…', () => {
            this._extension.runCommand(['ptyxis', '--', PANGOLIN_BINARY, 'login']);
        });
        this._signInItem.visible = false;

        this.connect('clicked', () => this._onToggle());
    }

    _onToggle() {
        if (this._busy)
            return;
        if (this._connected)
            this._disconnect();
        else
            this._connect();
    }

    _connect() {
        this._busy = true;
        this._setStatusConnecting();

        this._extension.runCommand([PANGOLIN_BINARY, 'up', '--silent'])
            .then(ok => {
                if (ok)
                    return this._extension.requestRapidPoll();
                // Creating the TUN device needs root; fall back to sudo -A,
                // which prompts via SUDO_ASKPASS (zenity).
                return this._extension.runCommand([PANGOLIN_BINARY, 'up'], {sudo: true})
                    .then(() => this._extension.requestRapidPoll());
            })
            .catch(() => {})
            .finally(() => {
                this._busy = false;
            });
    }

    _disconnect() {
        this._busy = true;
        this._setStatusConnecting();

        this._extension.runCommand([PANGOLIN_BINARY, 'down'])
            .then(() => this._extension.requestRapidPoll())
            .catch(() => {})
            .finally(() => {
                this._busy = false;
            });
    }

    _setStatusConnecting() {
        this._connected = false;
        this.checked = false;
        this.subtitle = 'Connecting...';
        this.menu.setHeader(CONNECTING_ICON, 'Pangolin VPN', 'Connecting...');
        this._updateStatusSection(null);
    }

    updateStatus({connected, data, auth}) {
        this._connected = connected;
        this.checked = connected;

        if (connected) {
            const summary = summarizePeers(data);
            const sites = summary.sites.filter(s => s.connected).map(s => s.name);
            const host = shortHost(auth?.serverUrl) ?? data?.orgId ?? 'Connected';
            const subtitle = sites.length > 0 ? `${host} · ${sites.join(', ')}` : host;
            this.subtitle = subtitle;
            this.menu.setHeader(CONNECTED_ICON, 'Pangolin VPN', subtitle);
        } else if (auth && !auth.loggedIn) {
            this.subtitle = 'Not signed in';
            this.menu.setHeader(DISCONNECTED_ICON, 'Pangolin VPN', 'Not signed in');
        } else {
            this.subtitle = 'Disconnected';
            this.menu.setHeader(DISCONNECTED_ICON, 'Pangolin VPN', 'Disconnected');
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
        if (data.version)
            rows.push(['CLI', `v${data.version}`]);

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
        this._indicator.icon_name = DISCONNECTED_ICON;

        this._toggle = new PangolinToggle(extension);
        this.quickSettingsItems.push(this._toggle);
    }

    applyStatus(status) {
        const {connected} = status;
        this._indicator.icon_name = connected ? CONNECTED_ICON : DISCONNECTED_ICON;
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
        this._pollInFlight = false;
        this._rapidAttempts = 0;
        this._auth = null;

        this._indicator = new PangolinIndicator(this);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);

        this._startPolling();
    }

    disable() {
        this._cancellable?.cancel();
        this._cancellable = null;

        this._removeSource('_pollSource');
        this._removeSource('_rapidSource');

        this._indicator?.destroy();
        this._indicator = null;
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
        const auth = await this.getAuthStatus().catch(() => null);
        if (auth !== null)
            this._auth = auth;
        return {...(await this.getStatus()), auth: this._auth};
    }

    /** Run `argv` detached; resolves true on exit status 0. */
    runCommand(argv, {sudo = false} = {}) {
        const finalArgv = sudo ? ['sudo', '-A', ...argv] : argv;
        try {
            const launcher = new Gio.SubprocessLauncher();
            if (sudo)
                launcher.setenv('SUDO_ASKPASS', GLib.build_filenamev([this.path, 'askpass.sh']), true);

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
            .then(status => this.applyStatus(status))
            .catch(() => {})
            .finally(() => {
                this._pollInFlight = false;
            });
    }

    applyStatus(status) {
        this._indicator?.applyStatus(status);
    }

    _removeSource(field) {
        if (this[field]) {
            GLib.source_remove(this[field]);
            this[field] = null;
        }
    }
}
