#!/usr/bin/env bash
set -euo pipefail

EXTENSION_UUID="pangolin-indicator@yetanother.at"
INSTALL_DIR="${HOME}/.local/share/gnome-shell/extensions/${EXTENSION_UUID}"
SHIPPED=(metadata.json extension.js status.js askpass.sh)
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Installing Pangolin VPN Status Indicator..."

mkdir -p "${INSTALL_DIR}"
for f in "${SHIPPED[@]}"; do
    cp "${REPO_DIR}/${f}" "${INSTALL_DIR}/"
done
chmod +x "${INSTALL_DIR}/askpass.sh"

# Ensure the extension is marked enabled in dconf (idempotent).
if command -v gsettings &>/dev/null; then
    CURRENT="$(gsettings get org.gnome.shell enabled-extensions)"
    if [[ "${CURRENT}" != *"${EXTENSION_UUID}"* ]]; then
        gsettings set org.gnome.shell enabled-extensions \
            "$(printf '%s' "${CURRENT}" | sed "s/]$/, '${EXTENSION_UUID}']/")"
    fi
fi

# GNOME Shell scans the extensions directory once, at session start, and
# imports extension code exactly once per session: neither newly-installed
# nor updated code is picked up by a running session. This matches GNOME's
# own behavior on Wayland, where even EGO updates prompt for a shell restart.
echo ""
echo "Installed to ${INSTALL_DIR}"
if gnome-extensions list 2>/dev/null | grep -q "^${EXTENSION_UUID}$"; then
    echo "The running session has an older copy loaded."
    echo "Log out and back in (Wayland) or Alt+F2 → r (X11) to apply the update."
else
    echo "Log out and back in once to activate it."
fi
