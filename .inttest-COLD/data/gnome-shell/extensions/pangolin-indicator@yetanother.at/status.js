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
    const start = stdout.indexOf('{');
    if (start >= 0) {
        try {
            const data = JSON.parse(stdout.slice(start));
            const connected = typeof data.connected === 'boolean' ? data.connected : true;
            return {connected, data};
        } catch {
            // fall through to heuristics
        }
    }

    // Heuristics for human-readable output of other versions.
    const text = stdout.toLowerCase();
    return {connected: text.includes('running') || text.includes('connected'), data: null};
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
    return {
        loggedIn: /^Status:\s*logged in/m.test(stdout),
        serverUrl: urlMatch ? urlMatch[1] : null,
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
 * Build the `pangolin up` argument list from settings values.
 * `s` carries the GSettings-shaped fields:
 *   {interfaceName, mtu, logLevel, upstreamDns, overrideDns,
 *    preferLocalRoutes, holepunch, matchDomains}
 */
export function buildUpArgs(s) {
    const argv = ['pangolin', 'up', '--silent'];

    if (s.interfaceName)
        argv.push('--interface-name', s.interfaceName);
    argv.push('--mtu', String(s.mtu));
    argv.push('--log-level', s.logLevel);
    if (s.upstreamDns)
        argv.push('--upstream-dns', s.upstreamDns);
    argv.push('--override-dns', s.overrideDns ? 'true' : 'false');
    argv.push('--prefer-local-routes', s.preferLocalRoutes ? 'true' : 'false');
    argv.push('--holepunch', s.holepunch ? 'true' : 'false');
    if (s.matchDomains)
        argv.push('--match-domains', s.matchDomains);

    return argv;
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
