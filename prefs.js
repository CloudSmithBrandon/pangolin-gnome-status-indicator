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

import {compareVersions, execAsync} from './status.js';

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

        const interfaceName = new Adw.EntryRow({
            title: _('Tunnel interface name'),
        });
        interfaceName.text = settings.get_string('interface-name');
        interfaceName.connect('changed', () => {
            settings.set_string('interface-name', interfaceName.text.trim());
        });
        connectionGroup.add(interfaceName);

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

        // --- Advanced ----------------------------------------------------
        const advancedGroup = new Adw.PreferencesGroup({
            title: _('Advanced'),
        });
        page.add(advancedGroup);

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

        const versionRow = new Adw.ActionRow({
            title: _('Installed version'),
            subtitle: _('Checking…'),
        });
        updatesGroup.add(versionRow);

        const checkRow = new Adw.ActionRow({
            title: _('Latest release'),
            subtitle: _('Press check to compare with the published release.'),
        });
        const checkButton = new Gtk.Button({
            label: _('Check'),
            valign: Gtk.Align.CENTER,
        });
        checkRow.add_suffix(checkButton);
        checkRow.activatable_widget = checkButton;
        updatesGroup.add(checkRow);

        const installRow = new Adw.ActionRow({
            title: _('Install update'),
            subtitle: _('Runs the client updater in a terminal window.'),
            visible: false,
        });
        const installButton = new Gtk.Button({
            label: _('Install'),
            valign: Gtk.Align.CENTER,
        });
        installRow.add_suffix(installButton);
        installRow.activatable_widget = installButton;
        updatesGroup.add(installRow);

        const checkForUpdates = async () => {
            checkButton.sensitive = false;
            installRow.visible = false;
            checkRow.subtitle = _('Checking…');
            try {
                const local = (await execAsync(['pangolin', 'version'], null)).stdout;
                const remoteRaw = (await execAsync(['curl', '-s', '-m', '15', RELEASES_URL], null)).stdout;
                const remote = JSON.parse(remoteRaw).tag_name;
                settings.set_string('last-remote-version', remote);

                versionRow.subtitle = local;
                const outdated = compareVersions(remote, local) > 0;
                checkRow.subtitle = outdated
                    ? _('Update available: %s').format(remote)
                    : _('Up to date');
                installRow.visible = outdated;
            } catch (e) {
                checkRow.subtitle = _('Check failed: %s').format(e.message);
            }
            checkButton.sensitive = true;
        };

        checkButton.connect('clicked', () => checkForUpdates());

        const installUpdate = () => {
            // Run in a visible terminal so the updater's output (including any
            // password prompt) is right in front of the user.
            execAsync(['ptyxis', '--', 'pangolin', 'update'], null).catch(() => {});
        };
        installButton.connect('clicked', () => installUpdate());

        // --- Bindings & initial state ------------------------------------
        settings.bind('autoconnect', autoconnect, 'active', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('override-dns', overrideDns, 'active', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('prefer-local-routes', preferLocalRoutes, 'active', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('holepunch', holepunch, 'active', Gio.SettingsBindFlags.DEFAULT);

        versionRow.subtitle = _('Press check to detect the installed version');
        checkForUpdates().catch(() => {});
    }
}
