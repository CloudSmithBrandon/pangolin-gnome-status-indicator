// Subprocess + status helpers for the Pangolin extension.
//
// This module intentionally has no GNOME Shell imports so it can be unit
// tested outside the shell with: gjs -m test/status-test.mjs

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const NO_CLIENT_MESSAGE = 'No client is currently running';

/**
 * Run `argv` asynchronously using Gio.Subprocess.
 *
 * Resolves with `{ok, stdout}` where `ok` is true when the process exited
 * with status 0 and `stdout` is the merged, trimmed output. Never rejects
 * for non-zero exit codes; rejects only for spawn failures or cancellation.
 */
export function execAsync(argv, cancellable = null, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        // A per-call cancellable lets the watchdog timeout abort this child
        // without tearing down the extension-wide cancellable.
        const childCancellable = new Gio.Cancellable();
        let parentHandler = 0;
        if (cancellable)
            parentHandler = cancellable.connect(() => childCancellable.cancel());

        let timeoutSource = 0;
        if (timeoutMs > 0) {
            timeoutSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                childCancellable.cancel();
                timeoutSource = 0;
                return GLib.SOURCE_REMOVE;
            });
        }

        const settle = (fn, arg) => {
            if (timeoutSource) {
                GLib.Source.remove(timeoutSource);
                timeoutSource = 0;
            }
            if (parentHandler)
                cancellable.disconnect(parentHandler);
            fn(arg);
        };

        let proc;
        try {
            proc = new Gio.Subprocess({
                argv,
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE,
            });
            proc.init(childCancellable);
        } catch (e) {
            settle(reject, e);
            return;
        }

        proc.communicate_utf8_async(null, childCancellable, (p, res) => {
            try {
                const [, stdout] = p.communicate_utf8_finish(res);
                settle(resolve, {ok: p.get_exit_status() === 0, stdout: stdout ? stdout.trim() : ''});
            } catch (e) {
                settle(reject, e);
            }
        });
    });
}

/**
 * Interpret `pangolin status --json` output.
 * Returns `{connected, data}`; `data` is the parsed JSON object or null.
 */
export function interpretStatus({ok, stdout}) {
    if (!ok || !stdout || stdout.includes(NO_CLIENT_MESSAGE))
        return {connected: false, data: null};

    // 0.17.0 prefixes `status --json` with an update banner; parse from the
    // first brace so banner text can never break (or spoof) the state.
    // A missing or non-boolean `connected` field means we do NOT know the
    // state: report disconnected rather than guessing connected.
    const start = stdout.indexOf('{');
    if (start >= 0) {
        try {
            const data = JSON.parse(stdout.slice(start));
            return {connected: data.connected === true, data};
        } catch {
            // fall through to heuristics
        }
    }

    // Heuristics for human-readable output of other versions. Match the
    // CLI's own status phrasings only — banner words like "update" must
    // never flip the state, and negations ("no client is ...") never count
    // as running.
    const text = stdout.toLowerCase();
    if (text.includes('no client'))
        return {connected: false, data: null};
    return {
        connected: text.includes('client is running') || text.includes('client is connected'),
        data: null,
    };
}

/**
 * Parse `pangolin auth status` (human-readable) output.
 * Returns `{loggedIn, serverUrl, user}`; `serverUrl`/`user` may be null.
 */
export function parseAuthStatus({ok, stdout}) {
    if (!ok || !stdout)
        return {loggedIn: false, serverUrl: null, user: null};

    const urlMatch = stdout.match(/^@\s+(\S+)\s*$/m);
    const userMatch = stdout.match(/^User:\s+(\S+)\s*$/m);
    // serverUrl flows into menu rows, notifications and the dashboard
    // launcher: keep only https URLs free of control/quote characters so
    // every consumer inherits a safe value (anything else fails to null).
    const rawUrl = urlMatch ? urlMatch[1] : null;
    const serverUrl = rawUrl && /^https:\/\//i.test(rawUrl)
        && !/[\x00-\x1f\x7f<>"'`\\]/.test(rawUrl) ? rawUrl : null;
    return {
        loggedIn: /^Status:\s*logged in/m.test(stdout),
        serverUrl,
        user: userMatch ? userMatch[1] : null,
    };
}

/**
 * Extract display-friendly facts from parsed `status --json` data.
 * Returns `{sites, tunnelIps}` where each site is
 * `{name, connected, rtt, isRelay}`.
 */
export function summarizePeers(data) {
    const sites = Object.values(data?.peers ?? {}).map(p => ({
        name: String(p.name ?? 'unknown'),
        connected: p.connected === true,
        rtt: Number.isFinite(p.rtt) ? p.rtt : null,
        isRelay: p.isRelay === true,
    }));
    const tunnelIps = (data?.networkSettings?.ipv4_addresses ?? []).map(String);
    return {sites, tunnelIps};
}

/** Strip scheme and trailing slash from a server URL for display. */
export function shortHost(serverUrl) {
    return serverUrl ? serverUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '') : null;
}

/**
 * Build an argv that opens `argv` inside the first available terminal
 * emulator, or null when none is installed. Pure argv data, no shell —
 * shared by the extension (View Logs, Sign In) and the preferences
 * updater, so the emulator choice lives in exactly one place.
 */
export function terminalArgv(argv) {
    const launchers = {
        ptyxis: a => ['ptyxis', '--new-window', '--', ...a],
        'gnome-terminal': a => ['gnome-terminal', '--', ...a],
        kgx: a => ['kgx', '--', ...a],
        xterm: a => ['xterm', '-e', ...a],
    };
    for (const [term, build] of Object.entries(launchers)) {
        if (GLib.find_program_in_path(term) !== null)
            return build(argv);
    }
    return null;
}

/**
 * Build the `pangolin up` argument list from settings values.
 * `s` carries the GSettings-shaped fields:
 *   {interfaceName, mtu, logLevel, upstreamDns, overrideDns,
 *    preferLocalRoutes, holepunch, matchDomains}
 *
 * These values reach an argv that may run as root through pkexec. No shell
 * is involved, but a value starting with '-' could still pass extra flags
 * to the CLI; every free-form value is charset-validated at this choke
 * point and dropped (CLI default applies) when it fails.
 */
const IFACE_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,14}$/;   // kernel IFNAMSIZ 15
const DNS_RE = /^[A-Za-z0-9.:][A-Za-z0-9.:-]*$/;         // ip/hostname chars
const DOMAINS_RE = /^[A-Za-z0-9_*][A-Za-z0-9_*.,-]*$/;   // comma-separated globs
const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

function validOrDrop(name, value, ok) {
    if (ok)
        return value;
    console.warn(`pangolin-indicator: ignoring invalid ${name} setting`);
    return null;
}

export function buildUpArgs(s) {
    const argv = ['pangolin', 'up', '--silent'];

    const iface = s.interfaceName ? validOrDrop('interface-name', s.interfaceName, IFACE_RE.test(s.interfaceName)) : null;
    if (iface)
        argv.push('--interface-name', iface);
    const mtu = Number(s.mtu);
    if (Number.isInteger(mtu) && mtu >= 576 && mtu <= 10000)
        argv.push('--mtu', String(mtu));
    else
        console.warn(`pangolin-indicator: ignoring invalid mtu setting: ${s.mtu}`);
    if (LOG_LEVELS.has(s.logLevel))
        argv.push('--log-level', s.logLevel);
    else if (s.logLevel)
        console.warn(`pangolin-indicator: ignoring invalid log-level setting: ${s.logLevel}`);
    const dns = s.upstreamDns ? validOrDrop('upstream-dns', s.upstreamDns, DNS_RE.test(s.upstreamDns)) : null;
    if (dns)
        argv.push('--upstream-dns', dns);
    argv.push('--override-dns', s.overrideDns ? 'true' : 'false');
    argv.push('--prefer-local-routes', s.preferLocalRoutes ? 'true' : 'false');
    argv.push('--holepunch', s.holepunch ? 'true' : 'false');
    const domains = s.matchDomains ? validOrDrop('match-domains', s.matchDomains, DOMAINS_RE.test(s.matchDomains)) : null;
    if (domains)
        argv.push('--match-domains', domains);

    return argv;
}

/**
 * Extract the CLI version from the final URL of a GitHub
 * `/releases/latest` redirect ("https://github.com/fosrl/cli/tag/v0.17.0").
 * Returns "0.17.0" or null when the URL carries no tag.
 */
export function versionFromReleaseRedirect(url) {
    const m = String(url).match(/\/tag\/v?([0-9]+(?:\.[0-9]+)*)/);
    return m ? m[1] : null;
}

/**
 * Compare two dotted version strings ("0.16.0", "v1.2").
 * Returns <0 if a < b, 0 if equal, >0 if a > b.
 * A leading "v" is ignored; missing components count as 0.
 */
export function compareVersions(a, b) {
    const norm = v => v.replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
    const va = norm(a);
    const vb = norm(b);
    const len = Math.max(va.length, vb.length);
    for (let i = 0; i < len; i++) {
        const d = (va[i] || 0) - (vb[i] || 0);
        if (d !== 0)
            return d;
    }
    return 0;
}

/**
 * Extract the installed CLI version from `pangolin version` output, which
 * may carry an update banner before the version line. Returns the bare
 * version string ("0.17.0") or null when nothing version-like is present.
 */
export function extractVersion(output) {
    if (!output)
        return null;
    const line = output.split('\n').map(l => l.trim()).find(l => /^v?\d+(\.\d+)+$/.test(l));
    return line ?? null;
}
