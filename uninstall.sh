#!/usr/bin/env bash
set -euo pipefail

EXTENSION_UUID="pangolin-indicator@yetanother.at"
INSTALL_DIR="${HOME}/.local/share/gnome-shell/extensions/${EXTENSION_UUID}"
ICON="${HOME}/.local/share/icons/hicolor/scalable/actions/pangolin-vpn-symbolic.svg"

echo "Disabling extension..."
gnome-extensions disable "${EXTENSION_UUID}" 2>/dev/null || true

if command -v gnome-extensions &>/dev/null && gnome-extensions uninstall "${EXTENSION_UUID}" 2>/dev/null; then
    echo "Uninstalled via gnome-shell (no restart needed)."
else
    echo "Removing ${INSTALL_DIR}..."
    rm -rf "${INSTALL_DIR}"
    echo "Removed. Log out/in if the tile is still visible in this session."
fi

# Remove the themed icon install.sh placed in the user hicolor dir, and the
# extension's dconf keys, so nothing is left behind.
if [[ -f "${ICON}" ]]; then
    rm -f "${ICON}"
    if command -v gtk-update-icon-cache &>/dev/null; then
        gtk-update-icon-cache -qtf "${HOME}/.local/share/icons/hicolor" 2>/dev/null || true
    fi
fi
dconf reset -f "/org/gnome/Shell/Extensions/pangolin-indicator/" 2>/dev/null || true

echo "Pangolin VPN Status Indicator uninstalled."
