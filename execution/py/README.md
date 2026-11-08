# Python executioner

Python 3.10+ and the standard library are sufficient. Run from the repository root:

```sh
python3 -m execution.py.main
```

Native assembly benchmarks additionally need GCC or Clang, and NASM for x64
NASM sources. Supply native assembly source in
the optional `assembly` field and typed skeleton functions in `#globals`; see
[native assembly examples and ABI details](../ASSEMBLY.md). Code and assembly
each accept at most 65,536 Unicode characters.

The local server listens at `http://127.0.0.1:6970/execute`. Override the address
with `--host` and `--port`. It executes submitted Python in the current user's
environment, so it is intended for trusted local benchmark code.

`GET /health` reports this executor's hostname, OS, architecture and logical CPU
count. On Linux it also reports optional hardware metadata (CPU model, physical
cores, RAM, kernel, governor and cache instances). The proxy queries this endpoint
to show the actual execution target's machine details.

The proxy routes Python to this server by default. Start it in another terminal:

```sh
cd proxy
go run . -addr 127.0.0.1:8080
```

## HTTP contract

`POST /execute` accepts the same fields as the Go execution server:

```sh
curl http://127.0.0.1:6970/execute \
  -H 'Content-Type: application/json' \
  -d '{"name":"Sort ints","byteCount":24,"fenced":true,"code":"#setup\nvalues = [3, 1, 2]\n#bench\nvalues.sort()\n#cleanup\nassert values == [1, 2, 3]"}'
```

`name` is required and `code` must contain `#bench`. `byteCount` defaults to zero
and must be a nonnegative signed 64-bit integer; `fenced` defaults to false.
Optional `compilerFlags` is an array of Python interpreter arguments, applied to
every fresh benchmark process (for example `["-OO", "-B"]`). Supported flags are
`-O`, `-OO`, `-B`, `-b`, `-bb`, `-u`, `-E`, `-I`, `-P`, `-s`, `-S`, `-d`,
`-v`, `-vv`, `-q`, `-W`, `-X`, and `--check-hash-based-pycs`. `-W` and `-X`
accept attached or separate values. `-O` removes assertions; `-OO` also removes
docstrings. Empty options preserve interpreter defaults. Flags that replace the
benchmark entrypoint, such as `-c` and `-m`, are rejected with `400`.

Unknown JSON fields and bodies larger than 1 MiB are rejected. Requests must
include `Content-Length` (as the proxy and curl do).

The response is `{"results": [...]}`, with one result per sweep combination.
It matches the raw Go schema consumed by `proxy/schema.go`: `name`, `byte_count`,
`fenced`, `timer_frequency`, `run_window_ns`, `iterations`, `total_page_faults`,
`min_time_ms`, `max_time_ms`, `avg_time_ms`, and `measurements`. Raw measurements
contain tick totals and page-fault/counter values for the fastest and slowest
iterations. Millisecond fields are per iteration. The historical
`BranchMisssMin` spelling is retained for compatibility.

Status codes match Go: `400` for invalid requests/directives/sweeps, `405` for
methods other than POST, `500` for compilation or execution errors, and `504`
when a combination exceeds its two-minute timeout. Errors are plain text and
include Python diagnostics. Unknown paths return `404`.

## Benchmark blocks

```python
#imports
import random

#globals
rng = random.Random(42)

#sweep
n: [100, 1000]
limit: [10, 100]

#setup
values = [rng.randrange(limit) for _ in range(n)]

#bench
values.sort()

#cleanup
assert all(a <= b for a, b in zip(values, values[1:]))
```

- `#imports` and `#globals` run once in each child process.
- `#sweep` uses `name: [integers]` and expands the Cartesian product in declaration
  order. The example produces `Sort ints (n=100, limit=10)`, then
  `(n=100, limit=100)`, `(n=1000, limit=10)`, and `(n=1000, limit=100)`.
  An absent/empty sweep runs once; an empty list produces no results.
- Each combination runs in a fresh Python interpreter for a ten-second window,
  after timer calibration. Setup and cleanup execute every iteration; only
  `#bench` contributes measured ticks and page faults. The window includes the
  time spent in all three blocks, like Go, and an iteration may finish after it.
- Setup, benchmark, and cleanup share a function's local scope. Values assigned
  by the benchmark are available in cleanup. Use a Python `global` declaration
  in setup when rebinding a name from `#globals`.
- Block directives must occupy their own line and may appear only once.
  Ordinary Python comments are accepted and block indentation is respected. Directive-looking
  text inside strings remains string content. Names beginning with `__bench_`
  are reserved for the generated runner.

User stdout is ignored except for the reserved `__BENCH_RESULT__:` result line.
Missing, malformed, or duplicate results fail execution. Temporary source and
output files are removed after completion or timeout.

## Profiler API

`NewRepProfile` now accepts an iteration callback, matching Go's
setup/measure/cleanup API. For an existing workload callback, wrap it with
`lambda measure: measure(work)`. An iteration must measure exactly once.
The measurement also supports a context manager to share Python locals:

```python
from execution.py.profile import GetCPUFreqWait, NewRepProfile

def iteration(measure):
    values = [3, 1, 2]
    with measure:
        values.sort()
    assert values == [1, 2, 3]

profile = NewRepProfile("sort", 24, iteration, 0.1, GetCPUFreqWait(100))
result = profile.Start(fenced=True)
```

Numeric durations are seconds; the profiler also accepts `datetime.timedelta`.
Programmatic execution uses `ExecutionConfig(BenchDuration=...)` in seconds;
zero selects the ten-second default. `RunExecution` and `RunSweep` accept a
per-combination `timeout` in seconds. The HTTP payload does not expose these
overrides, matching Go.

Hardware counters (L1 data misses, branch misses) are always attempted. If
they cannot be opened (non-Linux, `perf_event_paranoid` too strict, a
container without perf access, or a hybrid-CPU core type whose PMU doesn't
support the events), the run continues without them: their raw fields are zero
and `HardwareCountersError` holds the reason, which the printer shows as
`unavailable (<reason>)`. The run window starts after counter setup.

The existing Python timer backends, Linux thread affinity, and temporary
cyclic-GC disabling are retained. Native timers are preferred, with OS timer
fallbacks when unavailable; a fallback cannot provide CPU fence semantics.

## Tests

```sh
python3 -m unittest discover -s execution/py/tests -v
```

The suite covers deterministic measurement boundaries, real workloads, generated
programs, scope, sweep ordering, errors/timeouts, and HTTP requests over localhost.
No hardware-counter permission is required; without it, counters are reported unavailable.
