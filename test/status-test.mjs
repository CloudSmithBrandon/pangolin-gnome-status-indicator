#!/usr/bin/env gjs
// Unit tests for status.js — run with: gjs -m test/status-test.mjs
//
// Sections 1–3 and 5–8 are hermetic; section 4 exercises the real pangolin
// binary when available (informational shape check only, so the suite stays
// deterministic regardless of tunnel state). Exits non-zero on failure.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';

import {buildUpArgs, compareVersions, execAsync, extractVersion, interpretStatus, parseAuthStatus, shortHost, summarizePeers, versionFromReleaseRedirect} from '../status.js';

let failures = 0;
function check(name, cond, extra = '') {
    if (cond) {
        print(`ok - ${name}`);
    } else {
        failures++;
        printerr(`FAIL - ${name}${extra ? `: ${extra}` : ''}`);
    }
}

// 1. Status interpretation (hermetic)
{
    const r = interpretStatus({ok: true, stdout: '{"connected":true,"version":"0.16.0"}'});
    check('parses connected status', r.connected === true && r.data.version === '0.16.0');
}
{
    const r = interpretStatus({ok: false, stdout: 'something'});
    check('non-zero exit means disconnected', r.connected === false && r.data === null);
}
{
    const r = interpretStatus({ok: true, stdout: 'No client is currently running'});
    check('no-client message means disconnected', r.connected === false);
}
{
    const r = interpretStatus({ok: true, stdout: 'Client is running'});
    check('human-readable fallback detects running', r.connected === true && r.data === null);
}
{
    const r = interpretStatus({ok: true, stdout: '{"connected":false}'});
    check('JSON with connected:false reports disconnected with data', r.connected === false && r.data !== null);
}

// 2. execAsync basics
{
    const r = await execAsync(['sh', '-c', 'echo out; echo err >&2; exit 3'], null);
    check('captures merged output and non-zero exit',
        r.ok === false && r.stdout.includes('out') && r.stdout.includes('err'));
}
{
    let rejected = false;
    try {
        await execAsync(['definitely-missing-binary-xyz'], null);
    } catch {
        rejected = true;
    }
    check('missing binary rejects', rejected);
}
{
    const r = await execAsync(['sh', '-c', 'echo \'{"connected":true}\''], null);
    check('exit 0 with JSON stdout is ok', r.ok === true);
    check('sh-piped JSON parses via interpretStatus', interpretStatus(r).connected === true);
}

// 3. Cancellation
{
    const cancellable = new Gio.Cancellable();
    cancellable.cancel();
    let rejectedWithCancelled = false;
    try {
        await execAsync(['sleep', '5'], cancellable);
    } catch (e) {
        rejectedWithCancelled = e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
    }
    check('pre-cancelled spawn rejects with CANCELLED', rejectedWithCancelled);
}
{
    const cancellable = new Gio.Cancellable();
    const start = GLib.get_monotonic_time();
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
        cancellable.cancel();
        return GLib.SOURCE_REMOVE;
    });

    let rejectedWithCancelled = false;
    try {
        await execAsync(['sleep', '5'], cancellable);
    } catch (e) {
        rejectedWithCancelled = e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
    }
    const elapsedMs = (GLib.get_monotonic_time() - start) / 1000;
    check('mid-flight cancellation aborts quickly', rejectedWithCancelled && elapsedMs < 1500,
        `elapsed=${elapsedMs}ms`);
}

// 4. Live binary (shape check only — must not depend on tunnel state)
{
    try {
        const r = await execAsync(['pangolin', 'status', '--json'], null);
        const status = interpretStatus(r);
        check('live pangolin status returns interpretable result',
            typeof status.connected === 'boolean',
            `connected=${status.connected}`);
        print(`info - live tunnel connected=${status.connected}` +
            (status.data?.version ? ` version=${status.data.version}` : ''));
    } catch (e) {
        print(`info - pangolin binary not available here: ${e.message}`);
    }
}

// 5. Auth status parsing (hermetic, mirrors real CLI output shape)
{
    const sample = [
        'Status: logged in',
        '@ https://pangolin.example.com',
        '',
        'User: me@example.com',
        'User ID: abc123',
        'Org ID: homelab',
        '',
        'Licensed for personal use only.',
    ].join('\n');
    const r = parseAuthStatus({ok: true, stdout: sample});
    check('parses logged-in auth status',
        r.loggedIn === true && r.serverUrl === 'https://pangolin.example.com' && r.user === 'me@example.com');
}
{
    const r = parseAuthStatus({ok: false, stdout: 'Error: not logged in'});
    check('failed auth status means not signed in', r.loggedIn === false && r.serverUrl === null);
}
{
    const r = parseAuthStatus({ok: true, stdout: 'Status: logged out\n'});
    check('logged-out text means not signed in', r.loggedIn === false);
}
{
    const r = parseAuthStatus({ok: true, stdout: 'Status: logged in\n@ http://pangolin.example.com\nUser: me@example.com\n'});
    check('non-https server URL fails closed to null', r.loggedIn === true && r.serverUrl === null);
}
{
    const r = parseAuthStatus({ok: true, stdout: 'Status: logged in\n@ https://evil.example.com\x01/x\n'});
    check('control characters in server URL fail closed to null', r.serverUrl === null);
}

// 6. Peer summarization (hermetic, mirrors real status --json shape)
{
    const data = {
        peers: {
            '2': {name: 'home', connected: true, rtt: 5, isRelay: true},
            '3': {name: 'work', connected: false, rtt: 0, isRelay: false},
        },
        networkSettings: {ipv4_addresses: ['100.90.128.0']},
    };
    const s = summarizePeers(data);
    check('summarizes sites', s.sites.length === 2 && s.sites[0].name === 'home'
        && s.sites[0].connected === true && s.sites[0].rtt === 5 && s.sites[0].isRelay === true);
    check('summarizes tunnel ips', s.tunnelIps.length === 1 && s.tunnelIps[0] === '100.90.128.0');
}
{
    const s = summarizePeers(null);
    check('null data summarizes empty', s.sites.length === 0 && s.tunnelIps.length === 0);
}
{
    check('shortHost strips scheme and slash',
        shortHost('https://pangolin.example.com') === 'pangolin.example.com' && shortHost(null) === null);
}

// 7. CLI argument building (hermetic)
{
    const argv = buildUpArgs({
        interfaceName: 'pangolin0', mtu: 1400, logLevel: 'debug', upstreamDns: '9.9.9.9',
        overrideDns: false, preferLocalRoutes: true, holepunch: false, matchDomains: '*.proxy.internal',
    });
    check('buildUpArgs emits configured flags',
        JSON.stringify(argv) === JSON.stringify([
            'pangolin', 'up', '--silent',
            '--interface-name', 'pangolin0',
            '--mtu', '1400',
            '--log-level', 'debug',
            '--upstream-dns', '9.9.9.9',
            '--override-dns', 'false',
            '--prefer-local-routes', 'true',
            '--holepunch', 'false',
            '--match-domains', '*.proxy.internal',
        ]));
}
{
    const argv = buildUpArgs({
        interfaceName: '', mtu: 1280, logLevel: 'info', upstreamDns: '',
        overrideDns: true, preferLocalRoutes: false, holepunch: true, matchDomains: '',
    });
    check('buildUpArgs omits empty optional values',
        !argv.includes('--interface-name') && !argv.includes('--upstream-dns')
        && !argv.includes('--match-domains')
        && argv[argv.indexOf('--override-dns') + 1] === 'true');
}

// 8. Version comparison (hermetic)
{
    check('compareVersions ordering',
        compareVersions('1.2.0', '1.2.1') < 0
        && compareVersions('v1.2.1', '1.2.0') > 0
        && compareVersions('0.16.0', 'v0.16') === 0
        && compareVersions('1.0', '1.0.0') === 0);
}

// 9. Banner tolerance + version extraction (pangolin 0.17 behavior)
{
    const banner = 'A new version is available: 9.9.9 (current: 0.17.0)\nRun \'pangolin update\' to update to the latest version\n\n';
    const r = interpretStatus({ok: true, stdout: `${banner}{"connected":true,"version":"0.17.0"}`});
    check('banner-prefixed JSON parses as connected', r.connected === true && r.data?.version === '0.17.0');
}
{
    const banner = 'A new version is available: 9.9.9 (current: 0.16.0)\n\n';
    const r = interpretStatus({ok: true, stdout: `${banner}{"connected":false}`});
    check('banner JSON with connected:false stays false', r.connected === false && r.data !== null);
}
{
    check('extractVersion picks the bare version line',
        extractVersion('A new version is available: 9.9.9 (current: 0.17.0)\nRun \'pangolin update\'\n0.17.0\n') === '0.17.0'
        && extractVersion('0.16.0\n') === '0.16.0'
        && extractVersion('') === null
        && extractVersion('no version here') === null);
}
{
    let timedOut = false;
    const startedAt = GLib.get_monotonic_time();
    try {
        await execAsync(['sleep', '5'], null, 300);
    } catch (e) {
        timedOut = e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
    }
    const elapsedMs = (GLib.get_monotonic_time() - startedAt) / 1000;
    check('execAsync watchdog cancels a hung child', timedOut && elapsedMs < 2000,
        `elapsed=${elapsedMs}ms`);
}

// 10. Fail-closed status interpretation (a wrong "connected" is worse
//     than a wrong "disconnected": keepalive and the tile both consume it)
{
    const r = interpretStatus({ok: true, stdout: '{"version":"0.17.0"}'});
    check('JSON without connected field reports disconnected', r.connected === false);
}
{
    const r = interpretStatus({ok: true, stdout: '{"connected":"yes"}'});
    check('non-boolean connected reports disconnected', r.connected === false);
}
{
    const r = interpretStatus({ok: true, stdout: "A new version is available: 9.9.9 (current: 0.17.0)\nRunning the updater is recommended\n"});
    check('banner words cannot spoof the running heuristic', r.connected === false);
}
{
    const r = interpretStatus({ok: true, stdout: 'Client is connected'});
    check('human-readable fallback detects connected', r.connected === true);
}

// 11. buildUpArgs validation (settings reach a root-run argv; a value
//     starting with "-" must never become a CLI flag)
{
    const argv = buildUpArgs({
        interfaceName: '--write-config=/tmp/x', mtu: 1280, logLevel: 'info',
        overrideDns: true, preferLocalRoutes: false, holepunch: true,
    });
    check('flag-looking interface name is dropped',
        !argv.includes('--interface-name') && !argv.includes('--write-config=/tmp/x'));
}
{
    const argv = buildUpArgs({
        interfaceName: 'pangolin', mtu: 100, logLevel: 'verbose',
        overrideDns: true, preferLocalRoutes: false, holepunch: true,
    });
    check('out-of-range mtu and unknown log level are dropped',
        !argv.includes('--mtu') && !argv.includes('--log-level'));
}
{
    const argv = buildUpArgs({
        interfaceName: 'pangolin', mtu: 1280, logLevel: 'warn', upstreamDns: '1.1.1.1',
        overrideDns: true, preferLocalRoutes: false, holepunch: true, matchDomains: '*.proxy.internal,*.home',
    });
    check('valid values still pass through',
        argv.includes('--interface-name') && argv[argv.indexOf('--mtu') + 1] === '1280'
        && argv[argv.indexOf('--log-level') + 1] === 'warn'
        && argv[argv.indexOf('--match-domains') + 1] === '*.proxy.internal,*.home');
}

// 12. Release redirect parsing (update check reads the version from the
//     final URL of github.com/.../releases/latest)
{
    check('parses tag from redirect target',
        versionFromReleaseRedirect('https://github.com/fosrl/cli/tag/v0.17.0') === '0.17.0'
        && versionFromReleaseRedirect('https://github.com/fosrl/cli/tag/0.16') === '0.16');
}
{
    check('non-redirect URL yields no version',
        versionFromReleaseRedirect('https://github.com/fosrl/cli/releases/latest') === null
        && versionFromReleaseRedirect('') === null
        && versionFromReleaseRedirect('https://github.com/fosrl/cli/tag/not-a-version') === null);
}

if (failures > 0) {
    printerr(`${failures} test(s) failed`);
    System.exit(1);
} else {
    print('all tests passed');
}
