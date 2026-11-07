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

Get a Gemini API key in [Google AI Studio](https://aistudio.google.com/app/apikey), using your hackathon project if MLH provided one. Add it as `GEMINI_API_KEY` in the ignored `frontend/.env.local` file. Optionally set `GEMINI_MODEL` to a supported model available to that project. Keep the key server-side and out of Git. Keep `VITE_API_BASE_URL` unset to use the local demo API.

Restart the dev server, open Workbench, select a lane language, then choose **Generate code** from the lane menu. The server sends benchmark pseudocode of up to 250 characters to Gemini and displays the returned source in the harness tab. **Run** can also generate a stale scaffold. It still replays the fixture, so it does not execute generated source or measure its performance. Without a key, generation uses the sample scaffold.

## API and data

The default Vite server provides a mock HTTP API and server-sent events. The sample fixture contains synthetic Go and Python measurements from 1 KiB to 64 MiB. Custom code and flags still replay the fixture.

Set `VITE_API_BASE_URL` in `.env.local` to the real backend API prefix, such as `http://127.0.0.1:8080/api`, then restart Vite. The app uses this value for HTTP requests and run streaming. For a separate origin, configure the backend to allow requests from the frontend origin.

Local runs, saved benches, and shares are stored in the ignored `.benchscope/` directory. Preferences and drafts are stored in the browser.

## Checks

```sh
npm run build
npm run test:api
```

The mock API tests cover complete replay, resume, cancellation, failure, scaffold and parse responses, and bench and share round trips.
