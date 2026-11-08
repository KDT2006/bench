#!/usr/bin/env bash
# Linux laptop: start the Go + Python executors, tunnel them with ngrok, print the Render env values.
# The executors run under sudo only when perf counters need it (kernel.perf_event_paranoid > 2)
# or when USE_SUDO=1 is set; perf counting of user-space code otherwise works without root.
NGROK_CONFIG="${NGROK_CONFIG:-$HOME/.config/ngrok/ngrok.yml}"
GO_VAR=GO_LINUX_URL
PY_VAR=PYTHON_LINUX_URL
EXPECTED_ARCH=x86_64
if [ -z "${USE_SUDO:-}" ]; then
  USE_SUDO=0
  [ "$(cat /proc/sys/kernel/perf_event_paranoid 2>/dev/null || echo 0)" -gt 2 ] && USE_SUDO=1
fi
source "$(dirname "$0")/tunnels.sh"
