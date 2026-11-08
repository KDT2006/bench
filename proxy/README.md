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

For Python, first run `python3 -m execution.py.main` from the repository root,
then enable its local server when starting the proxy:

```sh
go run . -addr 127.0.0.1:8080 -python-url http://127.0.0.1:6970/execute
```

See [the Python executioner](../execution/py/README.md) for its benchmark format.

| Flag | Default | Meaning |
|---|---|---|
| `-addr` | `:8080` | Listen address |
| `-go-url` | `http://127.0.0.1:6969/execute` | Local Go server |
| `-python-url` | empty (disabled) | Local Python server |
| `-allow-origin` | `*` | `Access-Control-Allow-Origin`; empty disables CORS headers |

## Routes

### `POST /api/execute`

Website → proxy:

```json
{ "name": "Sort ints", "byteCount": 0, "fenced": true, "code": "#setup\n...\n#bench\n...", "language": "go", "arch": "linux/amd64" }
```

`name`, `code`, `language` and `arch` are required; `byteCount` must be ≥ 0.

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
| `400` | Bad JSON, missing field, or no local server for the language |
| `413` | Body over 1 MiB |
| `502` | Local server unreachable, returned non-2xx (its message, e.g. a compile error, is included), or returned something other than `{"results": [...]}` |

### `GET /api/health`

Fetches `GET /health` from each configured executor (a sibling of its `/execute`
URL, preserving any path prefix). The response contains `machines`, with each
executor's hostname, OS, architecture, logical CPU count, optional hardware details,
and the language routed to that executor. Go and Python targets remain separate,
even when their hostnames match. Queries run concurrently with a three-second timeout.

```json
{"status":"ok","machines":[{"status":"ok","hostname":"go-host","os":"linux","arch":"amd64","cpus":8,"languages":["go"]}],"unavailable":[]}
```

Unreachable, outdated, or invalid executor responses appear in `unavailable` as
`{"language":"python","message":"..."}` and set status to `degraded`. Proxy host
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
