# Shared by lin-script.sh and mac-script.sh; not run directly.
# Expects: NGROK_CONFIG, GO_VAR, PY_VAR, EXPECTED_ARCH (uname -m), USE_SUDO (0/1) from the caller.
#
# Builds and starts the Go (:6969) and Python (:6970) executors, exposes both through one
# ngrok agent, and prints the two values for the Render proxy's Environment page.
# Ctrl-C stops everything.
#
# With USE_SUDO=1 the executors run as root (macOS kpc counters need it; Linux needs it only
# when kernel.perf_event_paranoid > 2). ngrok always runs as you.
#
# Optional: NGROK_GO_DOMAIN / NGROK_PYTHON_DOMAIN pin a tunnel to a reserved ngrok domain
# (free accounts get one) so its URL stays the same across restarts.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
PIDS=""      # started as you
ROOT_PIDS="" # sudo processes; sudo relays SIGTERM to the executor it runs

cleanup() {
  trap - EXIT INT TERM
  [ -n "$ROOT_PIDS" ] && { sudo -n kill $ROOT_PIDS 2>/dev/null || kill $ROOT_PIDS 2>/dev/null || true; }
  [ -n "$PIDS" ] && { kill $PIDS 2>/dev/null || true; }
  wait 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

command -v ngrok >/dev/null || { echo "ngrok is not installed: https://ngrok.com/download" >&2; exit 1; }
[ -f "$NGROK_CONFIG" ] || { echo "No ngrok config at $NGROK_CONFIG. Run: ngrok config add-authtoken <token>" >&2; exit 1; }
if [ "$(uname -m)" != "$EXPECTED_ARCH" ]; then
  echo "warning: this machine is $(uname -m), but the proxy routes $GO_VAR/$PY_VAR as $EXPECTED_ARCH." >&2
fi
for port in 6969 6970 4040; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    echo "Port $port is already in use (an executor or ngrok is already running). Stop it first." >&2
    exit 1
  fi
done

# Builds as you, so the module cache is filled with files you own.
echo "Building Go executor..."
(cd "$ROOT/execution/go" && go build -o "$WORK/executor-go" .)

# as_executor CMD...: runs CMD in the background, as root when USE_SUDO=1.
if [ "$USE_SUDO" = 1 ]; then
  echo "The executors need root for hardware counters; sudo may ask for your password."
  sudo -v
  # Keep the sudo timestamp fresh so cleanup can stop the root processes later.
  (while sleep 60; do sudo -n true 2>/dev/null || exit; done) &
  PIDS="$PIDS $!"
  # Root compiles benchmarks with your Go toolchain, settings and module cache, but its own
  # build cache, so no root-owned files end up in your home directory.
  ROOT_HOME=/var/tmp/benchscope-root
  sudo mkdir -p "$ROOT_HOME"
  RUN_ENV=(env "PATH=$PATH" "HOME=$ROOT_HOME" "GOCACHE=$ROOT_HOME/go-build"
    "GOENV=$(go env GOENV)" "GOPATH=$(go env GOPATH)" "GOMODCACHE=$(go env GOMODCACHE)"
    "PYTHONDONTWRITEBYTECODE=1")
  as_executor() { sudo -n "${RUN_ENV[@]}" "$@" & ROOT_PIDS="$ROOT_PIDS $!"; }
else
  as_executor() { "$@" & PIDS="$PIDS $!"; }
fi

echo "Starting executors (logs in $WORK)..."
# The Go executor compiles each benchmark from its own directory so the local profiler module resolves.
cd "$ROOT/execution/go"
as_executor "$WORK/executor-go" -addr 127.0.0.1:6969 >"$WORK/go.log" 2>&1
cd "$ROOT"
as_executor python3 -m execution.py.main --host 127.0.0.1 --port 6970 >"$WORK/python.log" 2>&1

{
  echo "version: 3"
  echo "tunnels:"
  echo "  go:"
  echo "    proto: http"
  echo "    addr: 6969"
  [ -n "${NGROK_GO_DOMAIN:-}" ] && echo "    domain: $NGROK_GO_DOMAIN"
  echo "  python:"
  echo "    proto: http"
  echo "    addr: 6970"
  [ -n "${NGROK_PYTHON_DOMAIN:-}" ] && echo "    domain: $NGROK_PYTHON_DOMAIN"
} >"$WORK/tunnels.yml"

ngrok start --all --config "$NGROK_CONFIG" --config "$WORK/tunnels.yml" --log stdout >"$WORK/ngrok.log" 2>&1 &
PIDS="$PIDS $!"

# Ask the local ngrok agent API for both public URLs.
urls=""
for _ in $(seq 1 30); do
  urls="$(curl -s http://127.0.0.1:4040/api/tunnels | python3 -c '
import json, sys
try:
    tunnels = {t["name"]: t["public_url"] for t in json.load(sys.stdin)["tunnels"]}
except Exception:
    sys.exit(1)
if "go" in tunnels and "python" in tunnels:
    print(tunnels["go"], tunnels["python"])
' 2>/dev/null)" && [ -n "$urls" ] && break
  sleep 1
done
if [ -z "$urls" ]; then
  echo "ngrok did not report both tunnels. Log:" >&2
  tail -n 20 "$WORK/ngrok.log" >&2
  exit 1
fi
set -- $urls

echo
echo "Paste into Render -> proxy service -> Environment, then Save and deploy:"
echo
echo "  $GO_VAR=$1"
echo "  $PY_VAR=$2"
echo
echo "Running. Ctrl-C stops the executors and ngrok."

# Exit (and clean up) as soon as any process dies. ps works for root processes too.
while true; do
  for pid in $PIDS $ROOT_PIDS; do
    if ! ps -p "$pid" >/dev/null 2>&1; then
      echo "A process exited. Last log lines:" >&2
      tail -n 5 "$WORK"/*.log >&2
      exit 1
    fi
  done
  sleep 2
done
