# Benchscope frontend

Benchscope is a browser workbench for writing, running, and comparing microbenchmarks. The landing page previews a Go and Python array-sum sweep. The Workbench starts with one Go lane and supports up to four lanes.

## Run locally

Use Node.js 22.12 or later. From the repository root:

```sh
cd frontend
npm ci
npm run dev
```

Open the URL printed by Vite. The Workbench supports editing and running at viewport widths of 768 px or more. Smaller screens can view code and results.

## Try the replay

1. Open **Examples**, choose **Array sum**, then press **Run**.
2. Watch the **Live** chart and quick results. **Cancel run** keeps the results delivered so far.
3. Open full results to change the chart, sort or filter the table, inspect the run snapshot, or export CSV, JSON, and chart PNG.
4. **Save** adds the bench to **Library**. **Share** creates a read-only link. A recipient needs access to the same server to open the link.

## Generate Go or Python from pseudocode

Get a Gemini API key in [Google AI Studio](https://aistudio.google.com/app/apikey), using your hackathon project if MLH provided one. Add it as `GEMINI_API_KEY` in the ignored `frontend/.env.local` file. Optionally set `GEMINI_MODEL` to a supported model available to that project. Keep the key server-side and out of Git. The Vite server handles code generation in both replay and live mode.

Restart the dev server, open Workbench, select a lane language, then choose **Generate code** from the lane menu. The server sends benchmark pseudocode of up to 250 characters to Gemini and displays the returned source in the harness tab. **Run** can also generate a stale scaffold. In replay mode, it replays the fixture. Without a key, replay mode generates the sample scaffold.

## API and data

The default Vite server provides a mock HTTP API and server-sent events. The sample fixture contains synthetic Go and Python measurements from 1 KiB to 64 MiB. Custom code and flags still replay the fixture.

Replay runs, saved benches, and shares are stored in the ignored `.benchscope/` directory. Preferences and drafts are stored in the browser.

## Run the live Array sum demo

Use macOS or Linux on arm64 or x86_64 with Python 3.9+ and Go 1.23+. The proxy uses the Go version pinned in `proxy/go.mod`. Start each command in a separate terminal from the repository root. Use the same local token for the proxy and the agent.

**Terminal 1 — Go proxy**

```sh
cd proxy
BENCHSCOPE_AGENT_TOKEN=benchscope-local go run . -addr 127.0.0.1:8080 -allow-origin http://127.0.0.1:5173
```

**Terminal 2 — Array sum agent**

```sh
BENCHSCOPE_AGENT_TOKEN=benchscope-local python3 execution/agent/agent.py
```

**Terminal 3 — Frontend**

Add this line to `frontend/.env.local` alongside your existing Gemini settings.

```dotenv
VITE_API_BASE_URL=http://127.0.0.1:8080/api
```

```sh
cd frontend
npm run dev -- --port 5173 --strictPort
```

Open [Workbench](http://127.0.0.1:5173/bench), click **Load live Array sum**, then click **Run**. The agent initializes identical input for both languages before timing each buffer size. It reports elapsed time and throughput. **Cancel run** keeps results the proxy has received. The live runner accepts the checked-in Go and Python Array sum harnesses with a sweep of positive `N` sizes up to 64 MiB. **Generate code** still works with your Gemini key. Running custom source requires a separate runner with execution isolation.

Remove `VITE_API_BASE_URL` and restart Vite to return to replay mode. For another proxy, use its API prefix in `VITE_API_BASE_URL` and configure it to allow the frontend origin. Gemini's scaffold endpoint stays on the Vite origin.

## Checks

```sh
npm run build
npm run test:api
```

The mock API tests cover complete replay, resume, cancellation, failure, scaffold and parse responses, and bench and share round trips.
