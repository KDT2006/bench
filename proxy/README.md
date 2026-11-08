# Benchscope proxy

Sits between the website and the local execution servers. Go standard library only.

```
website  --POST /api/execute-->  proxy  --POST /execute-->  local Go server (:6969)
```

## Run

```sh
cd proxy
go run . -addr 127.0.0.1:8080
```

By default the proxy routes to the Go (`:6969`) and Python (`:6970`) servers on its own
machine, keyed by its own OS/arch. Start them with `cd execution/go && go run .` and
`python3 -m execution.py.main` from the repository root.

### Multiple machines

Backends live in one map keyed by `language/os/arch`. Add the other laptop with `-backend`
(repeatable; replaces a default with the same key):

```sh
go run . -addr 0.0.0.0:8080 \
  -backend go/darwin/arm64=http://192.168.1.20:6969/execute \
  -backend python/darwin/arm64=http://192.168.1.20:6970/execute
```

On the remote machine, listen on the LAN: `go run . -addr 0.0.0.0:6969` and
`python3 -m execution.py.main --host 0.0.0.0`. These servers run arbitrary code, so only
expose them on a trusted network and firewall them to the proxy's IP.

### Deploying (Render + ngrok)

On each laptop run `scripts/lin-script.sh` or `scripts/mac-script.sh`. Each one starts both
executors, tunnels them with ngrok, and prints two `NAME=URL` lines. Set those in the Render
service's Environment and choose **Save and deploy**. Render restarts the proxy, and the
proxy's URL stays the same.

| Variable | Routes |
|---|---|
| `GO_LINUX_URL` | `go/linux/amd64` |
| `PYTHON_LINUX_URL` | `python/linux/amd64` |
| `GO_MAC_URL` | `go/darwin/arm64` |
| `PYTHON_MAC_URL` | `python/darwin/arm64` |

Each value is a base URL (`/execute` is appended) or a full execute URL. Empty or unset
leaves that target unconfigured. `-backend` flags override these. `PORT` (set by Render)
changes the default `-addr` to `:$PORT`.

| Flag | Default | Meaning |
|---|---|---|
| `-addr` | `:8080` | Listen address |
| `-backend` | `go/<os>/<arch>` → `:6969`, `python/<os>/<arch>` → `:6970` on this machine | `language/os/arch=execute URL`, repeatable |
| `-allow-origin` | `*` | `Access-Control-Allow-Origin`; empty disables CORS headers |

## Routes

### `POST /api/execute`

The optional `compilerFlags` field is an array of command-line arguments. The proxy
forwards it unchanged to the selected executor, preserving spaces inside arguments.
For example: `"compilerFlags":["-gcflags=all=-N -l","-trimpath"]` for Go, or
`"compilerFlags":["-OO","-B"]` for Python. Omit it or send `[]` to use defaults.
Each request accepts up to 64 nonempty arguments, at most 4096 bytes each.

Go supports `-gcflags`, `-asmflags`, `-ldflags`, `-tags`, `-pgo`, `-buildvcs`,
`-race`, `-msan`, `-asan`, `-trimpath`, `-cover`, `-covermode`, `-coverpkg`,
`-a`, `-v` and `-x`. Value flags accept either `-flag=value` or separate arguments.
The executor retains control of the generated source file and output path.


Website → proxy:

```json
{ "name": "Sort ints", "byteCount": 0, "fenced": true, "code": "#setup\n...\n#bench\n...", "language": "go", "arch": "linux/amd64" }
```

`name`, `code`, `language` and `arch` are required; `byteCount` must be ≥ 0.

The proxy forwards to the backend keyed `language/arch` (e.g. `go/linux/amd64`).
Proxy → local server (`language` and `arch` are dropped):

```json
{ "name": "Sort ints", "byteCount": 0, "fenced": true, "code": "..." }
```

The local server answers `{"results": [...]}` (one entry per `#sweep` combination) with snake_case
fields and raw tick counts. The proxy converts each entry and returns `200`:

```json
{
  "results": [{
    "name": "sort (n=100)", "byteCount": 8000, "fenced": true,
    "timerFrequency": 3302311791, "runWindowNanos": 10000000000, "runWindowMillis": 10000,
    "iterations": 13296057, "totalPageFaults": 50,
    "counterAvailability": { "l1DataMisses": false, "branchMisses": false },
    "measurements": {
      "numIterations": 13296057, "totalPageFaults": 50,
      "MinTime": 220, "MaxTime": 14386867, "TotalTime": 4255299868, "AvgTime": 320.04,
      "GigabytesPerSecondMin": 111.8, "GigabytesPerSecondMax": 0.0017, "GigabytesPerSecondAvg": 76.9,
      "MajorPageFaultCountMin": 0, "MinorPageFaultCountMin": 0,
      "MajorPageFaultCountMax": 0, "MinorPageFaultCountMax": 0, "PageFaultCountAvg": 0.0000038,
      "L1DataMissMin": 0, "L1DataMissMax": 0, "BranchMisssMin": 0, "BranchMissMax": 0
    },
    "timeMs": { "min": 0.0000666, "max": 4.357, "avg": 0.0000969, "total": 1288.6 }
  }]
}
```

- `MinTime`/`MaxTime`/`TotalTime`/`AvgTime` are timer ticks; `timeMs` is milliseconds per iteration (`total` is all iterations).
- `GigabytesPerSecondMin` comes from `MinTime` (fastest iteration), as in the profiler. Throughput is `0` when `byteCount` or `timerFrequency` is `0`; `timeMs` is all `0` when `timerFrequency` is `0`.
- Min/Max page-fault, L1 data-read cache-miss and branch-prediction-miss counts belong to the fastest/slowest timed iteration.
- `counterAvailability` identifies whether each miss counter was measured. A false flag means unavailable; its numeric placeholder must not be interpreted as a measured zero. Linux attempts both counters independently; unsupported platforms or unavailable perf events retain timing results.
- The local execution response uses `counter_availability`; the proxy exposes the same flags under `counterAvailability`.

The conversion lives in `schema.go`.

Errors are `{"message": "..."}`:

| Status | When |
|---|---|
| `400` | Bad JSON, missing field, or no local server for the language and OS/arch |
| `413` | Body over 1 MiB |
| `502` | Local server unreachable, returned non-2xx (its message, e.g. a compile error, is included), or returned something other than `{"results": [...]}` |

### `GET /api/health`

Fetches `GET /health` from each configured executor (a sibling of its `/execute`
URL, preserving any path prefix). The response contains `machines`, with each
executor's hostname, OS, architecture, logical CPU count, optional hardware details,
and the language routed to that executor. There is one entry per backend, so Go and
Python targets remain separate even when their hostnames match. An executor whose reported
OS/arch differs from its configured key is listed as unavailable. Queries run concurrently with a three-second timeout.

```json
{"status":"ok","machines":[{"status":"ok","hostname":"go-host","os":"linux","arch":"amd64","cpus":8,"languages":["go"]}],"unavailable":[]}
```

Unreachable, outdated, or invalid executor responses appear in `unavailable` as
`{"language":"python","arch":"darwin/arm64","message":"..."}` and set status to `degraded`. Proxy host
metadata is never substituted. Update both executors when upgrading the proxy.

On Linux, each executor's optional `hardware` includes CPU model, physical core
count, OS-reported RAM bytes, kernel release, CPU 0 frequency governor, and CPU 0's
cache hierarchy (level, type, byte size, and shared logical CPUs). Missing kernel
files leave individual details unavailable. Cache sizes are per instance, not sums
across CPUs; virtualized topology and OS-reported RAM may reflect the guest.

## Test

```sh
go test ./...
```
