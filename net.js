// Minimal JSON-over-HTTP helper shared by the extension and its preferences.
// Uses libsoup directly so no external binaries (curl) need to be spawned.
// The Soup session is created lazily on first use: module scope must stay
// free of GObject instances per the extension review guidelines.

import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

let _session = null;

function getSession() {
    if (_session === null) {
        _session = new Soup.Session();
        _session.timeout = 15;        // socket IO timeout
        _session.idle_timeout = 15;
    }
    return _session;
}

/** GET `url` and resolve the parsed JSON body; rejects on HTTP or parse errors. */
export function fetchJson(url, cancellable = null) {
    return new Promise((resolve, reject) => {
        // Only https: this module exists to talk to release feeds, and a
        // mistyped http URL must never leak anything in the clear.
        if (!url.startsWith('https://')) {
            reject(new Error('only https URLs are permitted'));
            return;
        }
        const msg = Soup.Message.new('GET', url);
        if (msg === null) {
            reject(new Error(`invalid URL: ${url}`));
            return;
        }
        getSession().send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (sess, res) => {
            try {
                const bytes = sess.send_and_read_finish(res);
                const status = msg.get_status();
                if (bytes === null || status !== 200)
                    throw new Error(`HTTP ${status || 'request failed'}`);
                resolve(JSON.parse(new TextDecoder().decode(bytes.get_data())));
            } catch (e) {
                reject(e);
            }
        });
    });
}
