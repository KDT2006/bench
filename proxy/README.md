# Benchscope server

The middle man between the website and profiler agents. The website submits a run, an agent
picks it up by polling, and the agent's events are relayed back to the website over SSE. It
implements [SCHEMA.md](SCHEMA.md) with the Go standard library only.

| File | What it does |
|---|---|
| `main.go` | Flags, environment, HTTP server and shutdown |
| `server.go` | Shared state, routes, CORS, JSON helpers, saving to the data directory |
| `website.go` | Website API: machines, runs (and their SSE stream), benches, shares |
| `agent.go` | Agent API: register, poll, and translating agent events into run events |
| `sweep.go` | Reads `#sweep` from `benchmark.perf` to build the job's permutations |

```sh
cd proxy
BENCHSCOPE_AGENT_TOKEN=change-me go run . -data .benchscope-server
go test -race ./...
```

Point the website at it with `VITE_API_BASE_URL=http://localhost:8080/api`. Agents use the same
base URL: `POST /api/agent/register`, `/api/agent/poll`, `/api/agent/jobs/{jobId}/events`.

| Setting | Flag | Environment | Default |
|---|---|---|---|
| Agent Bearer token (required) | — | `BENCHSCOPE_AGENT_TOKEN` | — |
| Listen address | `-addr` | `BENCHSCOPE_ADDR` | `:8080` |
| Route prefix (website and agent) | `-prefix` | `BENCHSCOPE_PREFIX` | `/api` |
| Data directory (benches, shares, runs) | `-data` | `BENCHSCOPE_DATA_DIR` | in memory |
| Extra origins for cross-origin calls, or `*` | `-allow-origin` | `BENCHSCOPE_ALLOWED_ORIGINS` | none |

## Behaviour the schema leaves open

- **One machine and one sweep per run.** A job carries one `sweep`, so `POST /runs` returns `422`
  when lanes have different `#sweep` values. It returns `400` when lanes use different
  architectures.
- **No machine available.** `POST /runs` returns `503` when no online machine has the lanes'
  arch and languages (`capabilities.languages`). Among the ones that do, the server picks the
  shortest queue. A queued run waits for its machine even while that machine is offline. The
  website can cancel it.
- **Lost jobs.** If the agent polls 5 times (about 10 s) without reporting the job it was handed,
  the run fails. This happens when the poll response was lost or the agent dropped the job.
  It also fails if the agent registers again during a job (a restart). An agent that reports
  `busy` with a job the server is not running gets `cancel: true`.
- **Cancel before the agent confirms.** If the machine goes offline after the website asked to
  cancel, the run ends as `cancelled`, not `failed`.
- **Light validation.** The server checks only what it needs to relay a run: 1–4 lanes with
  unique IDs, one architecture, a harness file per lane and a valid `#sweep`. Build and runner
  options are passed to the agent untouched, and agent events are relayed without checking
  every field.
- **Restarts.** Jobs and machines live in memory. Runs are written to disk when they are
  created and when they finish. A run still active at shutdown is loaded as `failed`.
- **SSE.** A finished stream with nothing left to send answers `204`, so `EventSource` does not
  reconnect. Idle streams get a comment line every 15 s.
- **Extras.** Each `perm.result` (minus `samples`, which are in the row) and each build's
  toolchain are kept in the run file's `extras`. They are not sent to the website (section 6).
- **No code generation.** The website translates `benchmark.perf` into `harness.go` or
  `harness.py` in the browser. `POST /runs` requires the harness file in every lane.
- **Fixtures.** `fixtures/run.json` is a copy of `frontend/mock/fixtures/run.json`, served as
  `GET /runs/sample-array-sum`. `fixtures/examples.json` is served as-is by `GET /examples`
  and mirrors `frontend/src/model/examples.ts`. Update them together.
