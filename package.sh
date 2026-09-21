#!/usr/bin/env bash
# Build the extensions.gnome.org review zip. Distribution is an explicit
# allow-list: the harness (test/), installer scripts and docs never ship.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UUID="pangolin-indicator@yetanother.at"
ZIP="${HERE}/${UUID}.zip"

FILES=(metadata.json extension.js prefs.js status.js net.js)

cd "${HERE}"

command -v zip >/dev/null || { echo "error: zip(1) is required to build the bundle" >&2; exit 1; }
for f in "${FILES[@]}"; do
    [ -f "${f}" ] || { echo "error: missing ${f}" >&2; exit 1; }
done
[ -f "schemas/org.gnome.Shell.Extensions.pangolin-indicator.gschema.xml" ] \
    || { echo "error: missing settings schema" >&2; exit 1; }
[ -f "icons/pangolin-vpn-symbolic.svg" ] || { echo "error: missing icon" >&2; exit 1; }
# EGO compiles the schema itself; never ship a stale compiled database.
rm -f schemas/gschemas.compiled

rm -f "${ZIP}"
# Explicit file arguments, never directory recursion: a stray file dropped
# into schemas/ or icons/ must not ship in the review bundle.
zip -q -X "${ZIP}" \
    "${FILES[@]}" \
    schemas/org.gnome.Shell.Extensions.pangolin-indicator.gschema.xml \
    icons/pangolin-vpn-symbolic.svg

# Guard the allow-list promise: nothing outside it may be in the zip, and
# the entry count must match exactly (dirs no longer appear as entries).
ENTRY_COUNT="$(unzip -l "${ZIP}" | awk 'END {print $2}')"
if [[ "${ENTRY_COUNT}" != 7 ]] || unzip -l "${ZIP}" | grep -Eq 'test/|install|uninstall|README|inttest|\.compiled'; then
    echo "error: zip contains files outside the distribution allow-list" >&2
    rm -f "${ZIP}"
    exit 1
fi

echo "Built ${ZIP}:"
unzip -l "${ZIP}"
