#!/usr/bin/env gjs
// Unit tests for status.js — run with: gjs -m test/status-test.mjs
//
// Tests 1–3 are hermetic; test 4 exercises the real pangolin binary when
// available (informational shape check only, so the suite stays
// deterministic regardless of tunnel state). Exits non-zero on failure.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';

import {execAsync, interpretStatus} from '../status.js';

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

if (failures > 0) {
    printerr(`${failures} test(s) failed`);
    System.exit(1);
} else {
    print('all tests passed');
}
