#!/usr/bin/env bash
# Mac laptop: start the Go + Python executors, tunnel them with ngrok, print the Render env values.
# The executors run under sudo: macOS hardware counters (kpc) require root.
NGROK_CONFIG="${NGROK_CONFIG:-$HOME/Library/Application Support/ngrok/ngrok.yml}"
GO_VAR=GO_MAC_URL
PY_VAR=PYTHON_MAC_URL
EXPECTED_ARCH=arm64
USE_SUDO=1
source "$(dirname "$0")/tunnels.sh"
