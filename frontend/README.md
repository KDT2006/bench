# Benchscope frontend

The home page opens the workbench through **Go**. The **Welcome** page contains the introduction and synthetic sample charts. The workbench supports editing and running at viewport widths of 768 px or more; smaller screens can view code and results.

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

Open `/bench`, choose **Load live Array sum**, and press **Run**. That action translates any stale code, submits each lane/input combination sequentially, and displays completed results. To translate without executing, click **Translate to Go** or **Translate to Python** in the lane toolbar. Translation works independently of the configured execution servers; a language marked “translation only” can be generated but needs its own backend to run. Code generation accepts at most 250 characters of pseudocode and requires a configured Gemini key in both execution and replay modes. The default backend is Go-only. The Python profiler library alone is not an HTTP execution server.

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

The executor controls the run window (currently ten seconds per combination) and compiler settings. Lane options expose bytes per iteration and fenced timing only. A zero byte count leaves throughput unavailable. Compiler flags, environment overrides, warmup, repetition limits, core selection, memory limits and assembly files are not supported by this proxy workflow.

**Cancel run** aborts the current request, stops later requests, and retains completed results. Results can be viewed and exported in the current tab; refreshing loses these live run records. The proxy does not provide saved benches, persistent run history, or sharing, so those features are disabled in live mode.

## Measurements

Live requests use `GET /api/health` and `POST /api/execute`. Unreported machine details display as unavailable. Health lists configured backends; an execution error is still possible if an upstream server is offline.

Results retain timer ticks and min/max/average time. Milliseconds returned by the backend are converted to nanoseconds for charts. Throughput is GiB/s. Medians, percentiles, standard deviations and distributions are unavailable unless the runner actually supplies them.

Linux execution attempts L1 data-read cache-miss and branch-prediction-miss counters independently. Hardware or permission failures leave timing available and mark the affected counter unavailable. The proxy returns `counterAvailability.l1DataMisses` and `counterAvailability.branchMisses`; zero counts are meaningful only when the matching flag is true. Miss-count Min/Max fields belong to the fastest/slowest **timed iterations**, rather than the smallest/largest miss counts. Tables and exports preserve these distinctions.

## Mock replay

Omit `VITE_API_BASE_URL` and restart Vite to use the separate local mock execution API and synthetic array-sum replay. Its run streaming, library and sharing are demo features stored under the ignored `.benchscope/` directory. Translation still calls Gemini through the dedicated scaffold endpoint and requires `GEMINI_API_KEY`; it never silently returns a fixture. Only the explicit `BENCHSCOPE_TEST_API` test configuration uses fixture translation. Live execution failures never fall back to replay data.

## Syntax validation

```sh
npm run check
```

This checks TypeScript without building the app or running a benchmark. Runtime execution, external code generation and hardware-counter availability require separate verification.
