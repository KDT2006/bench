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
- Min/Max page-fault, L1 and branch counts belong to the fastest/slowest iteration.

The conversion lives in `schema.go`.

Errors are `{"message": "..."}`:

| Status | When |
|---|---|
| `400` | Bad JSON, missing field, or no local server for the language |
| `413` | Body over 1 MiB |
| `502` | Local server unreachable, returned non-2xx (its message, e.g. a compile error, is included), or returned something other than `{"results": [...]}` |

### `GET /api/health`

Describes the machine the proxy runs on (the local servers are expected on the same machine):

```json
{ "status": "ok", "hostname": "box", "os": "linux", "arch": "amd64", "cpus": 8, "languages": ["go"] }
```

`languages` lists the languages with a configured local server.

## Test

```sh
go test ./...
```
