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

# Compile the GSettings schema so the extension and its preferences window
# can read the settings.
if command -v glib-compile-schemas &>/dev/null; then
    glib-compile-schemas "${INSTALL_DIR}/schemas/"
else
    echo "warning: glib-compile-schemas not found; settings may not load."
fi

# Compile the themed icon GResource so the tile shows the Pangolin mark,
# recolored by the current theme. Falls back to the prebuilt copy committed
# with the repo when the compiler is not installed.
if command -v glib-compile-resources &>/dev/null; then
    glib-compile-resources --sourcedir="${REPO_DIR}/icons" \
        --target="${INSTALL_DIR}/pangolin-indicator.gresource" \
        "${REPO_DIR}/resources/pangolin-indicator.gresource.xml"
elif [ -f "${REPO_DIR}/pangolin-indicator.gresource" ]; then
    cp "${REPO_DIR}/pangolin-indicator.gresource" "${INSTALL_DIR}/"
else
    echo "warning: glib-compile-resources not found; the brand icon will not load."
    echo "         Install it with: sudo apt install libglib2.0-dev-bin"
fi

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
