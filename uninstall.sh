#!/usr/bin/env bash
set -euo pipefail

EXTENSION_UUID="pangolin-indicator@yetanother.at"
INSTALL_DIR="${HOME}/.local/share/gnome-shell/extensions/${EXTENSION_UUID}"

echo "Disabling extension..."
gnome-extensions disable "${EXTENSION_UUID}" 2>/dev/null || true

if command -v gnome-extensions &>/dev/null && gnome-extensions uninstall "${EXTENSION_UUID}" 2>/dev/null; then
    echo "Uninstalled via gnome-shell (no restart needed)."
else
    echo "Removing ${INSTALL_DIR}..."
    rm -rf "${INSTALL_DIR}"
    echo "Removed. Log out/in if the tile is still visible in this session."
fi

echo "Pangolin VPN Status Indicator uninstalled."
