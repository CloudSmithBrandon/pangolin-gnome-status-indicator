#!/usr/bin/env bash
set -euo pipefail

EXTENSION_UUID="pangolin-indicator@yetanother.at"
INSTALL_DIR="${HOME}/.local/share/gnome-shell/extensions/${EXTENSION_UUID}"
SHIPPED=(metadata.json extension.js prefs.js status.js net.js)
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Installing Pangolin VPN Status Indicator..."

mkdir -p "${INSTALL_DIR}/schemas"
for f in "${SHIPPED[@]}"; do
    cp "${REPO_DIR}/${f}" "${INSTALL_DIR}/"
done
cp "${REPO_DIR}/schemas/"*.gschema.xml "${INSTALL_DIR}/schemas/"
# askpass.sh is obsolete since the pkexec migration; remove stale copies.
rm -f "${INSTALL_DIR}/askpass.sh"
# The brand icon now installs into the user hicolor dir; remove the old
# GResource blob.
rm -f "${INSTALL_DIR}/pangolin-indicator.gresource"

# Install the themed symbolic icon into the user's hicolor directory so the
# shell's icon theme can find and recolor it (the extension process cannot
# register icon theme search paths itself).
ICON_DIR="${HOME}/.local/share/icons/hicolor/scalable/actions"
mkdir -p "${ICON_DIR}"
cp "${REPO_DIR}/icons/pangolin-vpn-symbolic.svg" "${ICON_DIR}/pangolin-vpn-symbolic.svg"

# Compile the GSettings schema so the extension and its preferences window
# can read the settings.
if command -v glib-compile-schemas &>/dev/null; then
    glib-compile-schemas "${INSTALL_DIR}/schemas/"
else
    echo "warning: glib-compile-schemas not found; settings may not load."
fi

# Ensure the extension is marked enabled in dconf (idempotent). A fresh
# system reports "@as []" (empty typed array), which the append branch
# below cannot handle.
if command -v gsettings &>/dev/null; then
    CURRENT="$(gsettings get org.gnome.shell enabled-extensions)"
    if [[ "${CURRENT}" != *"${EXTENSION_UUID}"* ]]; then
        if [[ "${CURRENT}" == "@as []" ]]; then
            gsettings set org.gnome.shell enabled-extensions "['${EXTENSION_UUID}']"
        else
            gsettings set org.gnome.shell enabled-extensions \
                "$(printf '%s' "${CURRENT}" | sed "s/]$/, '${EXTENSION_UUID}']/")"
        fi
    fi
fi

# GNOME Shell scans the extensions directory once, at session start, and
# imports extension code exactly once per session: neither newly-installed
# nor updated code is picked up by a running session. This matches GNOME's
# own behavior on Wayland, where even EGO updates prompt for a shell restart.
echo ""
echo "Installed to ${INSTALL_DIR}"

# --- Environment checks -------------------------------------------------------
UNIT_LIST="$(systemctl list-unit-files 2>/dev/null || true)"
if [[ "${UNIT_LIST}" == *'pangolin-cli.service'* ]]; then
    echo ""
    echo "Old unattended service detected. Remove it so the extension owns the"
    echo "tunnel (otherwise systemd restarts it every time you disconnect):"
    echo "  sudo systemctl disable --now pangolin-cli.service && sudo rm /etc/systemd/system/pangolin-cli.service"
fi
echo ""
echo "Log out and back in (Wayland) or Alt+F2 → r (X11) to (re)load the extension."
