// Minimal HTTPS helper shared by the extension and its preferences.
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

function newGetMessage(url) {
    // Only https: this module exists to talk to release feeds, and a
    // mistyped http URL must never leak anything in the clear.
    if (!url.startsWith('https://'))
        throw new Error('only https URLs are permitted');
    const msg = Soup.Message.new('GET', url);
    if (msg === null)
        throw new Error(`invalid URL: ${url}`);
    // GitHub's API (among others) rejects requests without a User-Agent.
    msg.request_headers.append('User-Agent', 'pangolin-gnome-extension');
    return msg;
}

/** GET `url` following redirects; resolves the FINAL URL after any redirect.
 *  Used for /releases/latest style endpoints: the redirect target carries
 *  the version tag without touching the rate-limited JSON API. */
export function fetchFinalUrl(url, cancellable = null) {
    return new Promise((resolve, reject) => {
        let msg;
        try {
            msg = newGetMessage(url);
        } catch (e) {
            reject(e);
            return;
        }
        getSession().send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (sess, res) => {
            try {
                sess.send_and_read_finish(res);
                // The initial URL was https; refuse to resolve through a
                // redirect chain that ended somewhere insecure.
                const final = msg.get_uri();
                if (final.get_scheme() !== 'https')
                    throw new Error('redirect chain did not end in https');
                resolve(final.to_string());
            } catch (e) {
                reject(e);
            }
        });
    });
}
