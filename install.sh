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

# GNOME Shell only scans the extensions directory at startup, so a shell that
# has never seen this extension cannot load it now (GNOME 50 removed the
# InstallBundle D-Bus method that allowed this). One logout is unavoidable for
# the first activation. Afterwards, updates apply live via ReloadExtension.
if gnome-extensions list 2>/dev/null | grep -q "^${EXTENSION_UUID}$"; then
    gnome-extensions disable "${EXTENSION_UUID}" 2>/dev/null || true
    gdbus call --session \
        --dest org.gnome.Shell.Extensions \
        --object-path /org/gnome/Shell/Extensions \
        --method org.gnome.Shell.Extensions.ReloadExtension "${EXTENSION_UUID}" >/dev/null
    gnome-extensions enable "${EXTENSION_UUID}" 2>/dev/null || true
    echo ""
    echo "Updated and reloaded — the running session is using the new code."
else
    echo ""
    echo "Installed to ${INSTALL_DIR}"
    echo "Log out and back in once to activate it."
    echo "(After that, future installs apply live without logging out.)"
fi
