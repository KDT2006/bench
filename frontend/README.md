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

## API and data

The default Vite server provides a mock HTTP API and server-sent events. The sample fixture contains synthetic Go and Python measurements from 1 KiB to 64 MiB. Custom code and flags still replay the fixture. The mock returns a sample scaffold for the requested language.

Set `VITE_API_BASE_URL` in `.env.local` to the real backend API prefix, such as `http://127.0.0.1:8080/api`, then restart Vite. The app uses this value for HTTP requests and run streaming. For a separate origin, configure the backend to allow requests from the frontend origin.

Local runs, saved benches, and shares are stored in the ignored `.benchscope/` directory. Preferences and drafts are stored in the browser.

## Checks

```sh
npm run build
npm run test:api
```

The mock API tests cover complete replay, resume, cancellation, failure, scaffold and parse responses, and bench and share round trips.
