# Benchscope data schema

This file is the contract for every message between the three parts of Benchscope:

```
┌──────────┐  HTTP + SSE   ┌──────────┐  HTTP (agent polls for jobs)  ┌───────────────────┐
│ Website  │ ────────────▶ │  Server  │ ────────────────────────────▶ │ Profiler agent    │
│ frontend │ ◀──────────── │          │ ◀──────────────────────────── │ (local device)    │
└──────────┘   results     └──────────┘  HTTP (agent posts results)   └───────────────────┘
```

1. **Website → Server**: the workspace (code, sweep, build and runner options).
2. **Server → Agent**: a job: the lanes to build and the permutations to measure.
3. **Agent → Server**: build status, progress, and metrics for each permutation.
4. **Server → Website**: run events over server-sent events (SSE), plus the stored run.

Part A must match `frontend/src/api/types.ts` and `frontend/src/api/client.ts` exactly. The
website already depends on it. Part B is the new server ↔ agent protocol. It is based on what
`execution/go` and `execution/py` measure today. Section 5 maps each profiler field to a field
in this schema.

---

## 0. Conventions (all parts)

| Rule | Detail |
|---|---|
| Encoding | UTF-8 JSON. One message per HTTP body or SSE `data:` line. |
| Field names | `camelCase`. Unknown fields must be ignored by receivers. |
| Timestamps | ISO 8601 UTC with milliseconds, e.g. `"2025-01-15T12:00:00.000Z"`. |
| Integers | JSON numbers within ±(2⁵³−1). This is the range JavaScript reads exactly. Profiler `uint64` values must be checked against it before sending. |
| Non-finite numbers | `NaN` and `±Infinity` are not valid JSON. Send `null` or leave the metric out. |
| Optional fields | `?` in a type means the field may be **omitted**. `\| null` means it is always present and may be `null`. |
| IDs | Opaque strings. The server creates run, bench, share and job IDs as UUIDs. Lane IDs come from the website. |
| Body limit | Request bodies to the server must be ≤ 1 MiB (`413` otherwise). |

---

## Part A: Website ↔ Server

Base URL: `VITE_API_BASE_URL` (default `/api`). Every path below is relative to it.

### A.1 Endpoints

| Method | Path | Request body | Success | Response body |
|---|---|---|---|---|
| GET | `/machines` | — | 200 | `Machine[]` |
| GET | `/examples` | — | 200 | `Example[]` |
| POST | `/parse` | `{ dsl: string }` | 200 | `ParseResponse` |
| POST | `/scaffold` | `{ dsl: string, language: Lang, arch: Arch }` | 200 | `ScaffoldResponse` |
| POST | `/runs` | `{ workspace: Workspace }` | **202** | `{ runId: string }` |
| GET | `/runs/{id}` | — | 200 | `Run` |
| GET | `/runs/{id}/events` | — | 200 | `text/event-stream` of `RunEvent` (A.4) |
| POST | `/runs/{id}/cancel` | — (no body) | **204** | — |
| GET | `/benches` | — | 200 | `Workspace[]` |
| POST | `/benches` | `Workspace` | **201** | `Workspace` (with `id`, new `updatedAt`) |
| GET | `/benches/{id}` | — | 200 | `Workspace` |
| PUT | `/benches/{id}` | `Workspace` | 200 | `Workspace` (keeps `id` and `createdAt`, new `updatedAt`) |
| DELETE | `/benches/{id}` | — | **204** | — |
| POST | `/share` | `{ workspace: Workspace, runId?: string }` | **201** | `{ shareId: string }` |
| GET | `/share/{id}` | — | 200 | `ShareSnapshot` |

Errors: any non-2xx status with body `{ "message": string }`. The website shows `message` to the user.

| Status | When |
|---|---|
| 400 | Body is not JSON or not an object, or the workspace fails validation (A.3). |
| 403 | A write request comes from another origin, if the server enforces this. |
| 404 | Unknown resource or ID. Also `runId` in `/share` that does not exist. |
| 413 | Body larger than 1 MiB. |
| 422 | `benchmark.perf` has a sweep error. `message` is the first error from `parseSweep`. |
| 500 | Server error. |

`POST /runs` has **no machine field**. The server picks a machine whose `arch` matches every lane's `arch` (see B.3).

### A.2 Types (copy of `frontend/src/api/types.ts`)

```ts
type Lang = "go" | "python";
type Arch = "x86_64" | "arm64";
type Mode = "scaffold" | "ejected";
type FileName = "benchmark.perf" | "harness.go" | "harness.py" | "kernel.S";
type Counter = "cycles" | "time" | "pageFaults" | "cacheMisses" | "throughput";   // selected by the user
type MetricKey = "cycles" | "timeNs" | "pageFaults" | "cacheMisses" | "throughput"; // keys in results

interface Workspace {
  id?: string;                 // set by the server once saved
  title: string;
  linkDsl: boolean;            // scaffold lanes share one benchmark.perf
  lanes: Lane[];               // 1..4
  createdAt: string;
  updatedAt: string;
}

interface Lane {
  id: string;                  // unique within the workspace
  label: "A" | "B" | "C" | "D";
  name?: string;
  color: string;               // "#E6A23C"
  language: Lang;
  arch: Arch;
  mode: Mode;
  files: Partial<Record<FileName, string>>;
  scaffold?: { dslHash: string; model: string; warnings: string[]; cached: boolean };
  build: BuildOptions;
  runner: RunnerOptions;
}

interface BuildOptions {
  toolchainVersion: string;    // "go1.23", "cpython3.13"
  flags: string[];             // validated server-side
  env: Record<string, string>;
  asmFlags?: string[];         // only used with kernel.S
}

interface RunnerOptions {
  maxReps?: number;
  minTimeMs?: number;
  warmup: number;
  core?: number;
  memLimitMb?: number;
  counters: Counter[];
}

interface SweepParam { name: string; values: (number | string)[] }

interface Run {
  id: string;
  workspaceSnapshot: Workspace;
  machine: MachineSnapshot;
  status: "queued" | "building" | "running" | "done" | "failed" | "cancelled";
  sweep: SweepParam[];
  rows: ResultRow[];
  startedAt: string;
  finishedAt?: string;         // present once status is done, failed or cancelled
}

interface Stat { min: number; median: number; mean: number; p95: number; stddev: number }

interface ResultRow {
  laneId: string;
  params: Record<string, number | string>;     // one permutation, e.g. { N: 65536 }
  reps: number;                                // measured repetitions (warmup excluded)
  metrics: Partial<Record<MetricKey, Stat>>;
  samples?: number[];                          // raw ticks per repetition (section 5)
}

interface MachineSnapshot {
  id: string;
  arch: Arch;
  cpuModel: string;
  cores: number; threads: number; smt: boolean;
  baseMhz: number; boostMhz: number; governor: string; turbo: boolean;
  caches: { level: "L1d" | "L1i" | "L2" | "L3"; sizeBytes: number; lineSize: number; assoc?: number }[];
  ramBytes: number; pageSize: number;
  kernel: string; isolatedCores: number[]; perfCounters: boolean;
  toolchains: Record<string, string>;          // { go: "go1.23", python: "cpython3.13", gcc: "14.2", as: "2.43" }
}

interface Machine extends MachineSnapshot {
  status: "idle" | "busy" | "offline";
  queueLength: number;
}

interface ParseResponse { sweep: SweepParam[]; permutations: number; errors: string[] }
interface ScaffoldResponse { code: string; warnings: string[]; cached: boolean; model: string }
interface ShareSnapshot { workspace: Workspace; runId?: string }
interface Example { id: string; category: string; description: string; workspace: Workspace; runId?: string }
```

### A.3 Workspace validation (server, on `POST /runs`, `/benches`, `PUT /benches/{id}`, `/share`)

- `title`, `createdAt`, `updatedAt` are strings. `linkDsl` is a boolean.
- `lanes` has 1–4 entries. Each lane has a non-empty, unique `id`, a `language` in `Lang`, an `arch` in `Arch`, a `mode` in `Mode`, and `files`, `build`, `runner` as objects.
- `POST /runs` only: each `benchmark.perf` that is present must be a string, and `parseSweep` must return no errors (`422` with the first error). This includes the limit of **200 permutations**.
- `POST /runs` only: each lane must contain its harness file (`harness.go` for Go, `harness.py` for Python). The website generates scaffold harnesses with `/scaffold` before it calls `/runs`.

Sweep value syntax (`#sweep` section): `name = [v1, v2, …]`. Numbers may have the suffixes `K`/`Ki` (×1024), `M`/`Mi` (×1024²) or `G`/`Gi` (×1024³), with an optional trailing `B`. Strings are double-quoted. Values reach the agent already parsed as numbers or strings.

### A.4 Run events (SSE: `GET /runs/{id}/events`)

Each frame:

```
id: <n>
data: <RunEvent JSON>

```

- `n` starts at 1 and goes up by 1 per event. A reconnecting client sends `Last-Event-ID: <n>`. The server resumes with event `n+1`.
- The server closes the stream after a `done` or `error` event. The website also closes it.

```ts
type RunEvent =
  | { type: "queued"; position: number }                    // 1 = next to run
  | { type: "build_start"; laneId: string }
  | { type: "build_done"; laneId: string; ok: boolean; log: string }
  | { type: "perm_start"; laneId: string; index: number; total: number; params: Record<string, number | string> }
  | { type: "result"; laneId: string; row: ResultRow }
  | { type: "stderr"; laneId: string; text: string }
  | { type: "done" }                                          // terminal
  | { type: "error"; message: string; laneId?: string };      // terminal
```

`perm_start.index` is **1-based**. `total` is the number of permutations in the sweep, counted once (not multiplied by the number of lanes).

Event order for one run:

```
queued
build_start(A) build_done(A) build_start(B) build_done(B) …    ← all lanes build first
stderr(*)…                                                      ← any time after build_start
for each permutation p (1..total):
  for each lane L (workspace order):
    perm_start(L, p) result(L, p)
done | error
```

`Run.status` follows from the events: `queued` → `building` (after the first `build_start`) → `running` (after the first `perm_start`) → `done` / `failed` / `cancelled`.

- A failed build sends `build_done{ok:false}`, then `error{laneId}`. The run becomes `failed`.
- A cancel sends `done`. The run becomes `cancelled`. Rows that already arrived stay in `Run.rows`.
- Every `result.row` is also appended to `Run.rows`, so `GET /runs/{id}` returns the same data.

---

## Part B: Server ↔ Profiler agent (HTTP)

### B.1 Transport

- Plain HTTP with JSON bodies. **The agent always makes the request. The server never calls the agent.** This works when the device is behind NAT or a firewall.
- Every request carries `Authorization: Bearer <token>`. The token is set on the device. For the demo the server can accept one shared token.
- The agent does two things:
  1. **Poll loop** every 2 s, whether idle or busy. One request does the heartbeat, job pickup and cancel check.
  2. **Event posts** while a job runs: build status, progress, results, logs.
- Errors use the same `{ "message": string }` body as Part A.
- Retries: on a network error or a 5xx, the agent sends the same request again after 1 s, up to 5 times. Event posts carry a `seq` number, so a retry never creates a duplicate result.

### B.2 Endpoints

| Method | Path | Request body | Success | Response body |
|---|---|---|---|---|
| POST | `/agent/register` | `Register` | 200 | `{ machineId: string, pollIntervalMs: number }` (default 2000) |
| POST | `/agent/poll` | `Poll` | 200 | `PollResponse` |
| POST | `/agent/jobs/{jobId}/events` | `AgentEventBody` | **204** | — |

| Status | When | Agent action |
|---|---|---|
| 400 | Invalid body | Log it and send `job.finished{failed}` with `internal` |
| 401 | Missing or wrong token | Stop and print an error |
| 404 | Unknown `machineId` (for example after a server restart) or unknown `jobId` | `machineId`: call `/agent/register` again. `jobId`: stop the job. |
| 409 | Event for a job that is already finished or cancelled | Stop the job without sending more events |

### B.3 Register (on startup, and after a 404 from poll)

```ts
interface Register {
  agentVersion: string;                  // e.g. "0.1.0"
  machine: MachineSnapshot;              // A.2; `id` is stable across restarts
  capabilities: AgentCapabilities;
}

interface AgentCapabilities {
  os: "linux" | "darwin" | "windows";
  languages: Lang[];                     // runtimes installed and working
  timerSource: TimerSource;              // see 5.1
  timerFreqHz: number;                   // > 0, from GetCPUFreqWait
  timerFreqCalibrated: boolean;          // true when calibrated against the OS clock (x86 RDTSC, macOS fallback)
  perfCounters: {                        // what perf_event_open (or another OS API) gave
    l1dReadMisses: boolean;
    branchMisses: boolean;
  };
  pageFaultSplit: boolean;               // true: major/minor are separate (Linux, macOS); false: Windows
  canPinCore: boolean;
  canLimitMemory: boolean;
}

type TimerSource = "native-x86_64" | "native-arm64" | "mach_absolute_time" | "perf_counter_ns";
```

Registering again with the same `machine.id` replaces the stored snapshot and returns the same `machineId`.

`MachineSnapshot.perfCounters` must be `true` only when **both** `capabilities.perfCounters` values are `true`.

### B.4 Poll (every `pollIntervalMs`)

```ts
interface Poll {
  machineId: string;
  status: "idle" | "busy";
  jobId: string | null;                  // the running job when busy
}

interface PollResponse {
  job: Job | null;                       // only when status is "idle" and a run is waiting for this machine
  cancel: boolean;                       // true when status is "busy" and the website cancelled `jobId`
}
```

- The server hands a job out **once**. The agent must answer with a `job.accepted` or `job.rejected` event.
- The server marks a machine `offline` when it has not polled for **10 s**. If that machine had a job, the run fails (section 6).
- The server builds `Machine` (A.2) from the latest registered `machine`, plus `status` (`idle`/`busy` from the last poll, `offline` after 10 s without one) and its own `queueLength` for that machine.
- The poll loop runs in the agent process, not in the harness process. When `runner.core` is set, keep the agent off that core so the poll does not disturb measurements.

### B.5 Job (in `PollResponse.job`)

```ts
interface Job {
  jobId: string;
  runId: string;                         // the website's run ID
  lanes: JobLane[];                      // workspace order
  sweep: SweepParam[];                   // as parsed by the server
  permutations: Permutation[];           // the full cross product, in run order
  fenced: boolean;                       // default true; the website has no field for this
  maxSamples: number;                    // cap on `samples` per result; default 10000
}

interface JobLane {
  id: string;                            // = Lane.id
  label: "A" | "B" | "C" | "D";
  language: Lang;
  arch: Arch;                            // must equal the machine's arch
  files: Partial<Record<FileName, string>>;   // harness + optional kernel.S + benchmark.perf
  build: BuildOptions;
  runner: RunnerOptions;
}

interface Permutation {
  index: number;                         // 1-based
  params: Record<string, number | string>;
}
```

Permutation order: the cross product of `sweep` with the **first parameter as the outer loop**. If `sweep` is empty, `permutations` is `[{ index: 1, params: {} }]`.

How the agent applies `RunnerOptions`:

| Field | Agent behaviour |
|---|---|
| `warmup` | Run the workload this many times untimed before the measured loop, for each lane × permutation. |
| `minTimeMs` | Measurement window (`TryForTime`). Default **1000 ms** if missing. |
| `maxReps` | Stop the measured loop when `reps == maxReps`, even if the window has not elapsed. |
| `core` | Pin the harness process to this CPU before it starts (`sched_setaffinity`). Reject with `unsupported_option` if `canPinCore` is false. |
| `memLimitMb` | Limit the harness process (`RLIMIT_AS` or a cgroup). Reject with `unsupported_option` if `canLimitMemory` is false. |
| `counters` | The agent always measures everything it can. The server filters metrics by this list (section 6). |

The measured loop ends at whichever comes first: the window has elapsed, or `maxReps` is reached.

### B.6 Events (`POST /agent/jobs/{jobId}/events`)

Every body has a sequence number plus one event:

```ts
type AgentEventBody = { seq: number; sentAt: string } & AgentEvent;
```

- `seq` starts at 1 for each job and goes up by 1 per event.
- The server ignores (but still answers `204`) any event whose `seq` is ≤ the highest one it has seen for that job. This makes retries safe.

```ts
type AgentEvent =
  | { type: "job.accepted" }
  | { type: "job.rejected"; reason: "busy" | "arch_mismatch" | "missing_toolchain" | "unsupported_option" | "invalid_job"; message: string }
  | { type: "build.start"; laneId: string }
  | { type: "build.done"; laneId: string; ok: boolean; log: string; toolchain: string }
  | { type: "perm.start"; laneId: string; index: number; total: number; params: Record<string, number | string> }
  | ({ type: "perm.result" } & PermResult)
  | { type: "log"; laneId: string; stream: "stdout" | "stderr"; text: string }
  | { type: "job.finished"; status: "done" | "failed" | "cancelled"; message?: string; laneId?: string };
```

Order:

```
job.accepted                         (or job.rejected, which ends the job)
build.start(L) build.done(L) …       for every lane, before any measurement
for each permutation p, for each lane L:
  perm.start(L, p) perm.result(L, p)
log …                                any time after build.start
job.finished                         always last
```

Field notes:

- `build.done.log`: compiler and assembler output, cut to 64 KiB. `toolchain` is the version actually used, e.g. `"go1.23.4"`.
- If any build fails, send `job.finished{status:"failed", laneId}` and stop.
- `log.text`: at most 16 KiB per event. Send longer output as several events.
- `job.finished.message` is required when `status` is `"failed"`. It starts with one of these codes, written as `code: text`: `build_failed`, `no_measurements` (the loop finished with 0 iterations), `counter_unavailable`, `harness_crashed`, `timeout`, `internal`.

### B.7 Measurement result

```ts
interface PermResult {
  laneId: string;
  index: number;
  params: Record<string, number | string>;

  reps: number;                          // measured iterations (≥ 1); warmup excluded
  warmupReps: number;
  windowMs: number;                      // the TryForTime that was used
  fenced: boolean;

  timer: { source: TimerSource; freqHz: number; calibrated: boolean };

  byteCount: number | null;              // bytes per iteration reported by the harness; null if not reported

  metrics: {
    cycles:       Stat;                  // timer ticks per iteration (5.1)
    timeNs:       Stat;                  // ticks × 1e9 / freqHz
    pageFaults:   Stat;                  // major + minor per iteration
    cacheMisses:  Stat | null;           // L1D read misses per iteration; null if unavailable
    branchMisses: Stat | null;           // branch misses per iteration; null if unavailable
    throughput:   Stat | null;           // GiB/s per iteration; null if byteCount is null or 0
  };

  pageFaultTotals: {
    total: number;                       // Σ (major + minor) over all measured iterations
    major: number | null;                // null when pageFaultSplit is false
    minor: number | null;
  };

  samples: number[];                     // ticks per iteration, in run order; length ≤ maxSamples
  samplesTruncated: boolean;             // true if reps > maxSamples (the first maxSamples are kept)
}
```

Every `Stat` is computed by the agent over **all** `reps` iterations, not just the sent `samples`.

### B.8 Cancel

1. The website calls `POST /runs/{id}/cancel`.
2. On the agent's next poll, the server answers `cancel: true`. This takes at most one poll interval (2 s).
3. The agent kills the running harness process and discards the interrupted permutation.
4. The agent sends `job.finished{status:"cancelled"}`. Results the server already received stay.

If the job is still `queued` (not yet handed to an agent), the server cancels it on its own and no agent is involved.

---

## 5. Metric definitions

### 5.1 What the profilers measure

Both profilers (`execution/go/profile.go`, `execution/py/profile.py`) run `Func` in a loop for `TryForTime`. For each iteration they record:

| Per-iteration value | Source | Unit |
|---|---|---|
| `ticks` | `ReadCPUTimer[Start\|End]Fenced()` difference | timer ticks |
| `majorFaults`, `minorFaults` | `getrusage(RUSAGE_SELF)` (Linux/macOS), `GetProcessMemoryInfo.PageFaultCount` (Windows) | count |
| `l1dMisses` | `perf_event_open` `PERF_TYPE_HW_CACHE` L1D·READ·MISS, user space only | count |
| `branchMisses` | `perf_event_open` `PERF_COUNT_HW_BRANCH_MISSES`, user space only | count |

**Timer ticks are not core clock cycles.** `cycles` in this schema means timer ticks:

| `TimerSource` | Counter | Frequency |
|---|---|---|
| `native-x86_64` | `RDTSC`/`RDTSCP` (invariant TSC: constant reference rate) | calibrated over 20 ms (`GetCPUFreqWait`) |
| `native-arm64` | `CNTVCT_EL0` (generic timer, often 24 MHz–1 GHz) | `CNTFRQ_EL0`, exact |
| `mach_absolute_time` | macOS Python fallback | calibrated |
| `perf_counter_ns` | Python last resort | 1 000 000 000 (ticks = ns) |

The Go profiler always uses `native-x86_64` or `native-arm64`.

### 5.2 Derived per-iteration values

```
timeNs       = ticks × 1e9 / freqHz
pageFaults   = majorFaults + minorFaults
throughput   = byteCount / (ticks / freqHz) / 1024³      // GiB/s, as GBPerSec()
```

Note: the fastest iteration has the **highest** throughput. So `throughput.min` is the slowest iteration.

### 5.3 `Stat` computation

For the per-iteration values `x₁…xₙ` (n = `reps`), sorted ascending as `s₀…sₙ₋₁`:

| Field | Formula |
|---|---|
| `min` | `s₀` |
| `median` | `quantile(s, 0.5)` |
| `mean` | `Σx / n` |
| `p95` | `quantile(s, 0.95)` |
| `stddev` | sample standard deviation `√(Σ(x−mean)² / (n−1))`; `0` when n = 1 |

`quantile(s, q)`: `i = (n−1)·q`, `lo = ⌊i⌋`, `hi = ⌈i⌉`, result `s[lo] + (s[hi] − s[lo])·(i − lo)`. This is the same linear interpolation the website uses for distribution charts (`frontend/src/chart/Instrument.tsx`).

### 5.4 Mapping from current profiler result fields

`RepetitionProfileResults` holds only min/max/avg. It does not keep per-iteration values. So the agent cannot fill `median`, `p95`, `stddev` or `samples` without the change in section 7, item 1. Here is how the existing fields relate to this schema:

| Go / Python field | Schema equivalent |
|---|---|
| `Iterations()` | `reps` |
| `MinTime` / `MaxTime` | `metrics.cycles.min` / max of `samples` |
| `AvgTime` | `metrics.cycles.mean` |
| `TotalTime` | `metrics.cycles.mean × reps` (not sent) |
| `GigabytesPerSecondMin` | throughput of the **fastest** iteration = max throughput (name is misleading) |
| `GigabytesPerSecondMax` | throughput of the **slowest** iteration = `metrics.throughput.min` |
| `GigabytesPerSecondAvg` | `GBPerSec(AvgTime)`. ⚠ This is **not** `metrics.throughput.mean`, which is the mean of per-iteration throughput. |
| `TotalPageFaults()` | `pageFaultTotals.total` |
| `PageFaultCountAvg` | `metrics.pageFaults.mean` |
| `Major/MinorPageFaultCountMin` / `…Max` | faults during the fastest / slowest iteration (not sent) |
| `L1DataMissMin` / `L1DataMissMax` | misses during the fastest / slowest iteration (not sent). ⚠ **Not** the min/max of misses. |
| `BranchMisssMin` / `BranchMissMax` | same as above, for branch misses |
| `RepetitionProfile.ByteCount` | `byteCount` |
| `RepetitionProfile.CPUFreq` | `timer.freqHz` |
| `RepetitionProfile.TryForTime` | `windowMs` |
| `Start(fenced)` | `fenced` |

---

## 6. Server translation: agent → website

| Agent message | Website `RunEvent` / `Run` change |
|---|---|
| `job.accepted` (while queued) | `queued{position}` is sent when the run is created. Position 1 = this machine's next job. |
| `build.start` | `build_start{laneId}`, status → `building` |
| `build.done` | `build_done{laneId, ok, log}` |
| `perm.start` | `perm_start{laneId, index, total, params}`, status → `running` |
| `log` | `stderr{laneId, text}` (both streams) |
| `perm.result` | `result{laneId, row}`, and append `row` to `Run.rows` |
| `job.finished{done}` | `done`, status → `done`, set `finishedAt` |
| `job.finished{cancelled}` | `done`, status → `cancelled`, set `finishedAt` |
| `job.finished{failed}` | `error{message, laneId?}`, status → `failed`, set `finishedAt` |
| `job.rejected` | `error{message}`, status → `failed` |
| No poll for 10 s during a job | `error{message:"The machine went offline."}`, status → `failed` |

Build `ResultRow` from `perm.result`:

```ts
row = {
  laneId, params, reps,
  metrics: pick(metrics, lane.runner.counters),   // see below; leave out null metrics
  samples,                                        // only if non-empty
};
```

| `runner.counters` entry | Copies metric key |
|---|---|
| `"cycles"` | `cycles` |
| `"time"` | `timeNs` ← note the different name |
| `"pageFaults"` | `pageFaults` |
| `"cacheMisses"` | `cacheMisses` |
| `"throughput"` | `throughput` |

`branchMisses`, `pageFaultTotals`, `timer`, `byteCount`, `fenced`, `windowMs` and `warmupReps` are **not** part of the website's `ResultRow` yet. The server should store them with the run so a later website version can show them. Before they are sent to the website, add `branchMisses` to `MetricKey`, `metricNames` (`frontend/src/model/format.ts`) and the counter list in `LaneOptions.tsx`.

---

## 7. Gaps in the current code that this schema depends on

These are facts about the code today. Each one changes what the agent can send.

1. **No per-iteration data.** Neither profiler stores per-iteration values, so `median`, `p95`, `stddev` and `samples` cannot be computed. `Start` must also record arrays of `ticks`, `pageFaults`, `l1dMisses` and `branchMisses`, or compute their stats while it runs.
2. **Go: L1/branch misses are not set on the first iteration.** In `profile.go` the `numIterations == 0` branch does not set `L1DataMiss*` or `Branch*`. If the first iteration stays the fastest, `L1DataMissMin` and `BranchMisssMin` are reported as `0`. Python sets them (`profile.py`).
3. **Go: zero iterations gives NaN.** If the window ends before one iteration, `AvgTime` and `PageFaultCountAvg` are `NaN` and `MinTime` stays `MaxUint64`. `encoding/json` fails on `NaN`. The agent must report `no_measurements` instead. Python returns zeros in this case.
4. **Windows page faults disagree.** Go reports the whole count as **major** (`platform_windows.go`). Python reports it as **minor** (`_pagefaults.py`). The schema sends `pageFaultTotals.major/minor = null` and only `total` when `pageFaultSplit` is false.
5. **Hardware counters are Linux-only.** Go has only `counter_linux.go`, so it does not build on Windows or macOS (`NewCounter` is undefined). Go also has no `platform_darwin.go`. Python raises `NotImplementedError` in `NewCounter` on non-Linux systems. Both profilers stop the whole run if a counter cannot be opened, for example when `perf_event_paranoid` blocks it. Supporting `cacheMisses: null` needs the counters to be optional in `Start`.
6. **No warmup, `maxReps`, or explicit core in the profilers.** `Start` only takes a time window. The agent (or `Start`) must add warmup, the `maxReps` stop and `core` pinning. Python pins to the lowest CPU in its current affinity set. Go only calls `runtime.LockOSThread()`, which does not pin to a core.
7. **The website treats `cycles` as a perf counter.** `LaneOptions.tsx` disables `cycles` when `machine.perfCounters` is false. In this system `cycles` comes from the timer and is always available. Only `cacheMisses` (and later `branchMisses`) need perf counters.
8. **The harness entry contract is not defined yet.** The sample harness (`func benchmark(arr []byte) uint64`) does not receive `params`, run `#setup`/`#clean`, or report `byteCount`. The agent needs a fixed contract: how it passes `params` and calls setup, bench and cleanup, and how the harness returns `byteCount`. That contract must be written before the agent can produce `perm.result`.
9. `print.go` still prints "L1 data misses / branch misses: unavailable (counters disabled in profiler)" even though Go now measures them. This affects only human-readable output.

---

## 8. Full example (one lane, one permutation)

**Website → Server** `POST /runs`

```json
{ "workspace": {
  "title": "Array sum", "linkDsl": true,
  "createdAt": "2025-01-15T12:00:00.000Z", "updatedAt": "2025-01-15T12:00:00.000Z",
  "lanes": [{
    "id": "lane-a", "label": "A", "color": "#E6A23C",
    "language": "go", "arch": "x86_64", "mode": "scaffold",
    "files": {
      "benchmark.perf": "#sweep\nN = [1Ki]\n\n#setup\narr = random_array(N, 0, 255)\n\n#bench\ns = 0\nfor i in 0..N: s += arr[i]\nsink(s)\n",
      "harness.go": "package main\n…"
    },
    "build": { "toolchainVersion": "go1.23", "flags": [], "env": {} },
    "runner": { "maxReps": 120, "warmup": 5, "core": 7, "counters": ["cycles", "time"] }
  }]
}}
```
→ `202 { "runId": "9f1c…" }`

**Agent → Server** `POST /agent/poll`

```json
{ "machineId": "sample-x86", "status": "idle", "jobId": null }
```
→ `200`

```json
{ "cancel": false,
  "job": {
    "jobId": "j-1",
    "runId": "9f1c…",
    "lanes": [{ "id": "lane-a", "label": "A", "language": "go", "arch": "x86_64",
                "files": { "benchmark.perf": "…", "harness.go": "…" },
                "build": { "toolchainVersion": "go1.23", "flags": [], "env": {} },
                "runner": { "maxReps": 120, "warmup": 5, "core": 7, "counters": ["cycles", "time"] } }],
    "sweep": [{ "name": "N", "values": [1024] }],
    "permutations": [{ "index": 1, "params": { "N": 1024 } }],
    "fenced": true,
    "maxSamples": 10000
  } }
```

**Agent → Server** `POST /agent/jobs/j-1/events` with `{ "seq": 1, "sentAt": "…", "type": "job.accepted" }` → `204`, then `build.start` (seq 2), `build.done` (seq 3), `perm.start` (seq 4).

**Agent → Server** `POST /agent/jobs/j-1/events` (`perm.result`)

```json
{ "seq": 5, "sentAt": "2025-01-15T12:00:01.500Z", "type": "perm.result",
  "laneId": "lane-a", "index": 1, "params": { "N": 1024 },
  "reps": 120, "warmupReps": 5, "windowMs": 1000, "fenced": true,
  "timer": { "source": "native-x86_64", "freqHz": 3800000000, "calibrated": true },
  "byteCount": 1024,
  "metrics": {
    "cycles":       { "min": 862, "median": 884, "mean": 888, "p95": 931, "stddev": 23 },
    "timeNs":       { "min": 226.84, "median": 232.63, "mean": 233.68, "p95": 245, "stddev": 6.05 },
    "pageFaults":   { "min": 0, "median": 0, "mean": 0, "p95": 0, "stddev": 0 },
    "cacheMisses":  { "min": 2, "median": 3, "mean": 3.4, "p95": 6, "stddev": 1.1 },
    "branchMisses": { "min": 1, "median": 1, "mean": 1.2, "p95": 2, "stddev": 0.4 },
    "throughput":   { "min": 3.893, "median": 4.1, "mean": 4.08, "p95": 4.19, "stddev": 0.1 }
  },
  "pageFaultTotals": { "total": 0, "major": 0, "minor": 0 },
  "samples": [884, 862, 901],
  "samplesTruncated": false
}
```
→ `204`

(`samples` is shortened here. A real message has 120 entries.)

**Server → Website** SSE

```
id: 5
data: {"type":"result","laneId":"lane-a","row":{"laneId":"lane-a","params":{"N":1024},"reps":120,"metrics":{"cycles":{"min":862,"median":884,"mean":888,"p95":931,"stddev":23},"timeNs":{"min":226.84,"median":232.63,"mean":233.68,"p95":245,"stddev":6.05}},"samples":[884,862,901]}}

```

Only `cycles` and `timeNs` are forwarded, because the lane's `counters` is `["cycles", "time"]`.
