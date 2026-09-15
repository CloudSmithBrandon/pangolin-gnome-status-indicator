// Subprocess + status helpers for the Pangolin extension.
//
// This module intentionally has no GNOME Shell imports so it can be unit
// tested outside the shell with: gjs -m test/status-test.mjs

import Gio from 'gi://Gio';

export const CONNECTED_ICON = 'network-vpn-symbolic';
export const CONNECTING_ICON = 'network-vpn-acquiring-symbolic';
export const DISCONNECTED_ICON = 'network-vpn-no-route-symbolic';

export const NO_CLIENT_MESSAGE = 'No client is currently running';

/**
 * Run `argv` asynchronously using Gio.Subprocess.
 *
 * Resolves with `{ok, stdout}` where `ok` is true when the process exited
 * with status 0 and `stdout` is the merged, trimmed output. Never rejects
 * for non-zero exit codes; rejects only for spawn failures or cancellation.
 */
export function execAsync(argv, cancellable = null) {
    return new Promise((resolve, reject) => {
        let proc;
        try {
            proc = new Gio.Subprocess({
                argv,
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE,
            });
            proc.init(cancellable);
        } catch (e) {
            reject(e);
            return;
        }

        proc.communicate_utf8_async(null, cancellable, (p, res) => {
            try {
                const [, stdout] = p.communicate_utf8_finish(res);
                resolve({ok: p.get_exit_status() === 0, stdout: stdout ? stdout.trim() : ''});
            } catch (e) {
                reject(e);
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

    try {
        const data = JSON.parse(stdout);
        // Trust the daemon's own connected flag when present; older output
        // without it means a running client.
        const connected = typeof data.connected === 'boolean' ? data.connected : true;
        return {connected, data};
    } catch {
        // Fall back to heuristics for human-readable output of other versions.
        const text = stdout.toLowerCase();
        return {connected: text.includes('running') || text.includes('connected'), data: null};
    }
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
