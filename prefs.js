// Pangolin VPN Status — preferences window.
//
// Opens from the gear entry in the quick settings tile menu. Binds every
// setting to GSettings so changes apply to the next tunnel start (and the
// auto-connect spawn) immediately.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {compareVersions, execAsync, extractVersion, parseAuthStatus} from './status.js';
import {fetchJson} from './net.js';

const RELEASES_URL = 'https://api.github.com/repos/fosrl/cli/releases/latest';
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

export default class PangolinPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();
        window.add(page);

        // --- Connection -------------------------------------------------
        const connectionGroup = new Adw.PreferencesGroup({
            title: _('Connection'),
            description: _('How the tunnel starts and what it is called.'),
        });
        page.add(connectionGroup);

        const autoconnect = new Adw.SwitchRow({
            title: _('Connect automatically at login'),
            subtitle: _('Start the tunnel shortly after you sign in, using the settings below.'),
        });
        connectionGroup.add(autoconnect);

        const keepalive = new Adw.SwitchRow({
            title: _('Keep the tunnel connected'),
            subtitle: _('Reconnect automatically if the tunnel drops, unless you disconnected it yourself.'),
        });
        connectionGroup.add(keepalive);

        const serverRow = new Adw.ActionRow({
            title: _('Pangolin server'),
            subtitle: _('Checking…'),
        });
        const serverButton = new Gtk.Button({
            label: _('Change…'),
            valign: Gtk.Align.CENTER,
        });
        serverButton.connect('clicked', () => {
            // Interactive login covers cloud vs self-hosted and re-enrolls
            // the client against the chosen server.
            try {
                Gio.Subprocess.new(
                    ['ptyxis', '--new-window', '--', 'pangolin', 'login'],
                    Gio.SubprocessFlags.NONE);
            } catch {
                serverRow.subtitle = _('Could not open a terminal for login.');
            }
        });
        serverRow.add_suffix(serverButton);
        serverRow.activatable_widget = serverButton;
        connectionGroup.add(serverRow);

        execAsync(['pangolin', 'auth', 'status'], null)
            .then(r => {
                const auth = parseAuthStatus(r);
                serverRow.subtitle = auth.loggedIn && auth.serverUrl
                    ? auth.serverUrl
                    : _('Not signed in — press Change to pick a server.');
            })
            .catch(() => {
                serverRow.subtitle = _('Could not read the current server.');
            });

        // --- DNS & routing ----------------------------------------------
        const dnsGroup = new Adw.PreferencesGroup({
            title: _('DNS & Routing'),
            description: _('Which names use the tunnel and what happens when local network and tunnel overlap.'),
        });
        page.add(dnsGroup);

        const upstreamDns = new Adw.EntryRow({
            title: _('Upstream DNS server'),
        });
        upstreamDns.text = settings.get_string('upstream-dns');
        upstreamDns.connect('changed', () => {
            settings.set_string('upstream-dns', upstreamDns.text.trim());
        });
        dnsGroup.add(upstreamDns);

        const overrideDns = new Adw.SwitchRow({
            title: _('Resolve resource names through the tunnel'),
            subtitle: _("Use the tunnel's DNS to resolve internal resource names."),
        });
        dnsGroup.add(overrideDns);

        const preferLocalRoutes = new Adw.SwitchRow({
            title: _('Prefer local network'),
            subtitle: _('When your local network and the tunnel can both reach an address, use the local one.'),
        });
        dnsGroup.add(preferLocalRoutes);

        const matchDomains = new Adw.EntryRow({
            title: _('Tunnel domains'),
        });
        matchDomains.text = settings.get_string('match-domains');
        matchDomains.connect('changed', () => {
            settings.set_string('match-domains', matchDomains.text.trim());
        });
        dnsGroup.add(matchDomains);

        // --- Notifications ------------------------------------------------
        const notifyGroup = new Adw.PreferencesGroup({
            title: _('Notifications'),
            description: _('Pop-ups when the tunnel state changes.'),
        });
        page.add(notifyGroup);

        const notifyState = new Adw.SwitchRow({
            title: _('Notify on connect and disconnect'),
            subtitle: _('Show a banner whenever the tunnel goes up or down.'),
        });
        notifyGroup.add(notifyState);

        // --- Advanced ----------------------------------------------------
        const advancedGroup = new Adw.PreferencesGroup({
            title: _('Advanced'),
        });
        page.add(advancedGroup);

        const interfaceName = new Adw.EntryRow({
            title: _('Tunnel interface name'),
        });
        interfaceName.text = settings.get_string('interface-name');
        interfaceName.connect('changed', () => {
            settings.set_string('interface-name', interfaceName.text.trim());
        });
        advancedGroup.add(interfaceName);

        const mtu = Adw.SpinRow.new_with_range(576.0, 10000.0, 10.0);
        mtu.title = _('Tunnel MTU');
        mtu.subtitle = _('Maximum packet size inside the tunnel. Leave at 1280 unless you know you need a different value.');
        mtu.value = settings.get_int('mtu');
        mtu.connect('notify::value', () => {
            settings.set_int('mtu', Math.round(mtu.value));
        });
        advancedGroup.add(mtu);

        const holepunch = new Adw.SwitchRow({
            title: _('Direct connections'),
            subtitle: _('Try a direct peer-to-peer connection before falling back to a relay.'),
        });
        advancedGroup.add(holepunch);

        const logLevel = new Adw.ComboRow({
            title: _('Log level'),
            subtitle: _('How much detail the client logs.'),
            model: Gtk.StringList.new(LOG_LEVELS),
        });
        const currentLevel = settings.get_string('log-level');
        const levelIndex = LOG_LEVELS.indexOf(currentLevel);
        logLevel.selected = levelIndex >= 0 ? levelIndex : LOG_LEVELS.indexOf('info');
        logLevel.connect('notify::selected', () => {
            settings.set_string('log-level', LOG_LEVELS[logLevel.selected]);
        });
        advancedGroup.add(logLevel);

        // --- Updates ------------------------------------------------------
        const updatesGroup = new Adw.PreferencesGroup({
            title: _('Updates'),
            description: _('Keep the Pangolin command line client up to date.'),
        });
        page.add(updatesGroup);

        const versionValue = new Gtk.Label({
            label: _('…'),
            valign: Gtk.Align.CENTER,
        });
        versionValue.add_css_class('dim-label');
        const versionRow = new Adw.ActionRow({
            title: _('Installed version'),
        });
        versionRow.add_suffix(versionValue);
        updatesGroup.add(versionRow);

        const updateRow = new Adw.ActionRow({
            title: _('Update'),
            subtitle: _('Checking…'),
        });
        const updateButton = new Gtk.Button({
            label: _('Check for updates'),
            valign: Gtk.Align.CENTER,
        });
        updateRow.add_suffix(updateButton);
        updateRow.activatable_widget = updateButton;
        updatesGroup.add(updateRow);

        // Picks the bare version number out of `pangolin version`, whose
        // output also carries an update banner when a release exists.
        const installedVersion = out => extractVersion(out) ?? '';

        let updateAvailable = false;

        const runCheck = async () => {
            updateButton.sensitive = false;
            updateButton.label = _('Checking…');
            updateRow.subtitle = _('Comparing with the published release…');
            try {
                const local = installedVersion((await execAsync(['pangolin', 'version'], null)).stdout);
                versionValue.label = local || _('unknown');
                const remote = (await fetchJson(RELEASES_URL, null)).tag_name;
                settings.set_string('last-remote-version', remote);

                updateAvailable = local !== '' && compareVersions(remote, local) > 0;
                if (updateAvailable) {
                    updateRow.subtitle = _('Version %s is available.').format(remote);
                    updateButton.label = _('Install…');
                    updateButton.add_css_class('suggested-action');
                } else {
                    updateRow.subtitle = _('Up to date.');
                    updateButton.label = _('Check for updates');
                    updateButton.remove_css_class('suggested-action');
                }
            } catch (e) {
                updateAvailable = false;
                updateRow.subtitle = _('Check failed: %s').format(e.message);
                updateButton.label = _('Check for updates');
                updateButton.remove_css_class('suggested-action');
            }
            updateButton.sensitive = true;
        };

        const installUpdate = () => {
            // Run in a visible terminal so the updater's output (including any
            // password prompt) is right in front of the user.
            execAsync(['ptyxis', '--new-window', '--', 'pangolin', 'update'], null).catch(() => {});
        };

        updateButton.connect('clicked', () => {
            if (updateAvailable)
                installUpdate();
            else
                runCheck().catch(() => {});
        });

        // --- Bindings & initial state ------------------------------------
        settings.bind('autoconnect', autoconnect, 'active', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('keepalive', keepalive, 'active', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('notify-state', notifyState, 'active', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('override-dns', overrideDns, 'active', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('prefer-local-routes', preferLocalRoutes, 'active', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('holepunch', holepunch, 'active', Gio.SettingsBindFlags.DEFAULT);

        runCheck().catch(() => {});
    }
}
