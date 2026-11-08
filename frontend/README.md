# Bench.it frontend

The home page opens the workbench through **Go**. The **Docs** page has **Examples** (`/docs/examples`) and **Guide** (`/docs/guide`) tabs. The workbench is dedicated to editing, executing and inspecting benchmarks. The workbench supports editing and running at viewport widths of 768 px or more; smaller screens can view code and results.

## Local setup

Use Node.js 22.12 or later and the Go versions declared by the execution and proxy modules. Start these commands from the repository root in separate terminals.

Go execution server:

```sh
cd execution/go
go run .
```

Proxy:

```sh
cd proxy
go run . -addr 127.0.0.1:8080 -allow-origin http://127.0.0.1:5173
```

Create the ignored **frontend/.env.local**, alongside `vite.config.ts` (not inside `src`):

```dotenv
VITE_API_BASE_URL=http://127.0.0.1:8080/api
GEMINI_API_KEY=your-server-side-key
# GEMINI_MODEL=your-supported-model
```

Frontend:

```sh
cd frontend
npm ci
npm run dev -- --port 5173 --strictPort
```

Keep the Gemini key server-side; never prefix it with `VITE_`. Restart Vite after changing environment settings. `/api/scaffold` is served by Vite, while health and execution requests use the configured proxy URL. A static frontend deployment must also provide the scaffold server endpoint.

## Write, generate, run

Open **Docs → Examples**, choose **Array sum** to open it in the workbench, and press **Run**. That action translates any stale code, submits each lane/input combination sequentially, and displays completed results. To translate without executing, click **Translate** in the lane toolbar. Translation works independently of the configured execution servers; a lane marked **Translation only** can be generated but needs its own backend to run. Code generation requires a configured Gemini key. The proxy enables Go by default; start the Python execution server and configure its URL to enable Python lanes.

The browser posts to `/api/scaffold`; the dedicated Vite server handler calls Gemini's `generateContent` API and returns the translated sections to the harness tab. The key stays on the server, so the Gemini request appears in server traffic rather than as a direct browser request. Missing configuration returns an actionable error instead of sample code. Vite loads environment settings from the frontend directory regardless of the shell's working directory.

Every source uses these sections in this order:

```text
#imports

#globals

#sweep
N: [1024, 4096]

#setup
arr = random_array(N,0,255)

#bench
s = 0
for i in 0..N: s += arr[i]
sink(s)

#cleanup
```

Sweeps accept integer JSON lists and form a Cartesian product, with up to 256 combinations per lane. No unit suffixes, assignment syntax, strings, directive aliases or automatic saved-workspace migrations are supported. Empty sweep sections run once.

The generated harness tab contains executable directive-separated code, not a standalone program. **Edit as code** allows editing those same sections directly. Setup and cleanup run for every iteration, outside the timed bench section. Sweep parameters are injected before setup. Go imports are import specifications; the harness already provides `encoding/json`, `fmt`, `os`, `profiler`, and `time`.

The executor controls the run window (currently ten seconds per combination). Each lane has a compact compiler/interpreter options field: Go accepts build flags such as `-gcflags="all=-N -l" -trimpath`, and Python accepts interpreter flags such as `-OO -B`. Quoting groups arguments; no shell expansion is performed. Options are sent as a `compilerFlags` string array through the proxy and applied to every sweep combination. Empty options use server defaults. Invalid or unsupported options report an error. Run snapshots retain the options used.

Lanes use their executor's architecture. Bytes per iteration and fenced timing are sent with each request; a zero byte count leaves throughput unavailable. Toolchain selection, environment overrides and runner controls in the **Options** drawer remain saved settings and are not applied yet.

**Cancel run** aborts the current request, stops later requests, and retains completed results. Results can be viewed and exported in the current tab; refreshing loses these live run records. The workspace itself is autosaved in the browser; use **Export bench** to keep a copy.

## Measurements

Live requests use `GET /api/health` and `POST /api/execute`. The proxy fetches machine details from each configured executor, including hostname, OS, architecture, logical CPUs and optional hardware details. Each language retains its execution target; runs save these target snapshots. Unavailable executor health is reported as an error rather than showing proxy host statistics.

Results retain timer ticks and min/max/average time. Charts and tables default to time, shown in readable units. Throughput is GiB/s.

Linux execution attempts L1 data-read cache-miss and branch-prediction-miss counters independently. Hardware or permission failures leave timing available and mark the affected counter unavailable. The proxy returns `counterAvailability.l1DataMisses` and `counterAvailability.branchMisses`; zero counts are meaningful only when the matching flag is true. Miss-count Min/Max fields belong to the fastest/slowest **timed iterations**, rather than the smallest/largest miss counts. Tables and exports preserve these distinctions.

## Syntax validation

```sh
npm run check
npm test
```

`check` type-checks without building the app or running a benchmark. `test` runs the scaffold and model tests in `server/` against a fake Gemini. Runtime execution, external code generation and hardware-counter availability require separate verification.
