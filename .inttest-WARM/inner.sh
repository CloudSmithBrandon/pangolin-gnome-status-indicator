set -x
export PATH="/home/brandon/repos/CloudSmithBrandon/pangolin-gnome-status-indicator/.inttest-WARM/bin:$PATH" XDG_DATA_HOME="/home/brandon/repos/CloudSmithBrandon/pangolin-gnome-status-indicator/.inttest-WARM/data" XDG_CONFIG_HOME="/home/brandon/repos/CloudSmithBrandon/pangolin-gnome-status-indicator/.inttest-WARM/config"
export STUB_LOG="/home/brandon/repos/CloudSmithBrandon/pangolin-gnome-status-indicator/.inttest-WARM/calls.log" STUB_SCENARIO="/home/brandon/repos/CloudSmithBrandon/pangolin-gnome-status-indicator/.inttest-WARM/scenario"
echo negotiating > "/home/brandon/repos/CloudSmithBrandon/pangolin-gnome-status-indicator/.inttest-WARM/scenario"
gsettings set org.gnome.shell enabled-extensions "[pangolin-indicator@yetanother.at]"
echo "in-session enabled: $(gsettings get org.gnome.shell enabled-extensions)"
GSETTINGS_SCHEMA_DIR="/home/brandon/repos/CloudSmithBrandon/pangolin-gnome-status-indicator/.inttest-WARM/data/gnome-shell/extensions/pangolin-indicator@yetanother.at/schemas" gsettings set org.gnome.shell.extensions.pangolin-indicator@yetanother.at keepalive true
timeout 40 gnome-shell --headless > "/home/brandon/repos/CloudSmithBrandon/pangolin-gnome-status-indicator/.inttest-WARM/shell.log" 2>&1 &
sleep 6
gnome-extensions info pangolin-indicator@yetanother.at > "/home/brandon/repos/CloudSmithBrandon/pangolin-gnome-status-indicator/.inttest-WARM/ext-info.log" 2>&1
wait
