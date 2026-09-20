set -x
export PATH="/home/brandon/repos/CloudSmithBrandon/pangolin-gnome-status-indicator/.inttest-COLD/bin:$PATH"
export XDG_DATA_HOME="/home/brandon/repos/CloudSmithBrandon/pangolin-gnome-status-indicator/.inttest-COLD/data" XDG_CONFIG_HOME="/home/brandon/repos/CloudSmithBrandon/pangolin-gnome-status-indicator/.inttest-COLD/config"
export GSETTINGS_BACKEND=keyfile
export STUB_LOG="/home/brandon/repos/CloudSmithBrandon/pangolin-gnome-status-indicator/.inttest-COLD/calls.log" STUB_SCENARIO="/home/brandon/repos/CloudSmithBrandon/pangolin-gnome-status-indicator/.inttest-COLD/scenario"
if [ "COLD" = "WARM" ]; then echo negotiating > "/home/brandon/repos/CloudSmithBrandon/pangolin-gnome-status-indicator/.inttest-COLD/scenario"; else echo disconnected > "/home/brandon/repos/CloudSmithBrandon/pangolin-gnome-status-indicator/.inttest-COLD/scenario"; fi
timeout 60 gnome-shell --headless > "/home/brandon/repos/CloudSmithBrandon/pangolin-gnome-status-indicator/.inttest-COLD/shell.log" 2>&1 &
SHELL_PID=$!
sleep 25
echo connected > "/home/brandon/repos/CloudSmithBrandon/pangolin-gnome-status-indicator/.inttest-COLD/scenario"
sleep 15
if [ "COLD" = "WARM" ]; then echo negotiating > "/home/brandon/repos/CloudSmithBrandon/pangolin-gnome-status-indicator/.inttest-COLD/scenario"; else echo disconnected > "/home/brandon/repos/CloudSmithBrandon/pangolin-gnome-status-indicator/.inttest-COLD/scenario"; fi
wait $SHELL_PID
