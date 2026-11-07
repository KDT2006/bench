import type { Lang, Machine, MachineSnapshot, Run, RunEvent, ShareSnapshot, Workspace } from "../src/api/types";
import machineJson from "./fixtures/machine.json";
import runJson from "./fixtures/run.json";
import { exampleFixtures } from "../src/model/examples";
import { parseSweep } from "../src/model/sweep";
import { MAX_SCAFFOLD_CHARACTERS, scaffoldLength, scaffoldLimitMessage } from "../src/model/scaffoldLimits";
import { ScaffoldGenerationError, type ScaffoldGenerator } from "../server/gemini";

const machine = machineJson as MachineSnapshot;
const sample = runJson as Run;
const delay = 80;
const limit = 1024 * 1024;
type Kind = "run" | "bench" | "share";

export interface MockStorage {
  read<T>(kind: Kind, id: string): Promise<T | undefined>;
  list<T>(kind: Kind, activeAt?: number): Promise<T[]>;
  write(kind: Kind, id: string, value: unknown, activeUntil?: number): Promise<void>;
  remove(kind: Kind, id: string): Promise<void>;
}

class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const empty = () => new Response(null, { status: 204 });

async function body(req: Request): Promise<unknown> {
  if (!req.body) throw new ApiError(400, "Send a valid JSON request body.");
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.length;
    if (size > limit) {
      void reader.cancel();
      throw new ApiError(413, "Use a request body smaller than 1 MiB.");
    }
    text += decoder.decode(next.value, { stream: true });
  }
  try { return JSON.parse(text + decoder.decode()); }
  catch { throw new ApiError(400, "Send a valid JSON request body."); }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "Send a JSON object.");
  return value as Record<string, unknown>;
}

function workspace(value: unknown): Workspace {
  const candidate = object(value);
  const { lanes } = candidate;
  if (
    typeof candidate.title !== "string" ||
    typeof candidate.linkDsl !== "boolean" ||
    typeof candidate.createdAt !== "string" ||
    typeof candidate.updatedAt !== "string" ||
    !Array.isArray(lanes) || lanes.length < 1 || lanes.length > 4
  ) throw new ApiError(400, "Send a workspace with a title, timestamps and one to four lanes.");
  const ids = new Set<string>();
  for (const value of lanes) {
    const lane = object(value);
    if (
      typeof lane.id !== "string" || !lane.id || ids.has(lane.id) ||
      !["go", "python"].includes(String(lane.language)) ||
      !["x86_64", "arm64"].includes(String(lane.arch)) ||
      !["scaffold", "ejected"].includes(String(lane.mode))
    ) throw new ApiError(400, "Send lanes with unique IDs, supported languages, architectures and modes.");
    object(lane.files);
    object(lane.build);
    object(lane.runner);
    ids.add(lane.id);
  }
  return candidate as unknown as Workspace;
}

function* sequence(snapshot: Workspace): Generator<RunEvent> {
  for (const lane of snapshot.lanes) {
    yield { type: "build_start", laneId: lane.id };
    const ok = lane.arch === machine.arch;
    yield { type: "build_done", laneId: lane.id, ok, log: ok ? "Mock build complete." : "Use x86_64 for the mock machine." };
    if (!ok) {
      yield { type: "error", laneId: lane.id, message: "Use x86_64 to replay this run." };
      return;
    }
  }

  const references = new Map(sample.workspaceSnapshot.lanes.map((lane) => [lane.language, lane.id]));
  for (const lane of snapshot.lanes) {
    yield { type: "stderr", laneId: lane.id, text: "Replaying synthetic fixture data." };
  }
  const [sweep] = sample.sweep;
  for (const [index, n] of sweep.values.entries()) {
    for (const lane of snapshot.lanes) {
      const source = sample.rows.find((row) => row.laneId === references.get(lane.language) && row.params.N === n)!;
      const row = { ...source, laneId: lane.id };
      yield { type: "perm_start", laneId: lane.id, index: index + 1, total: sweep.values.length, params: row.params };
      yield { type: "result", laneId: lane.id, row };
    }
  }
}

interface Replay {
  id: string;
  snapshot: Workspace;
  started: number;
  cancelled?: number;
}

function timeline(replay: Replay) {
  const events: RunEvent[] = [{ type: "queued", position: 1 }, ...sequence(replay.snapshot)];
  if (events.at(-1)?.type !== "error") events.push({ type: "done" });
  return events;
}

function replayState(replay: Replay, now = Date.now(), events = timeline(replay)) {
  const end = replay.started + (events.length - 1) * delay;
  const cancelled = replay.cancelled !== undefined && replay.cancelled < end;
  const cursor = Math.max(1, Math.min(events.length, Math.floor(((cancelled ? replay.cancelled! : now) - replay.started) / delay) + 1));
  const visible = events.slice(0, cursor);
  if (cancelled) visible.push({ type: "done" });
  const last = visible.at(-1);
  const status: Run["status"] = cancelled ? "cancelled"
    : last?.type === "error" ? "failed" : last?.type === "done" ? "done"
      : visible.some((event) => event.type === "perm_start") ? "running"
        : visible.some((event) => event.type === "build_start") ? "building" : "queued";
  const finished = cancelled ? replay.cancelled : now >= end ? end : undefined;
  const run: Run = {
    id: replay.id, workspaceSnapshot: replay.snapshot, machine, status, sweep: sample.sweep,
    rows: visible.flatMap((event) => event.type === "result" ? [event.row] : []),
    startedAt: new Date(replay.started).toISOString(),
    ...(finished === undefined ? {} : { finishedAt: new Date(finished).toISOString() }),
  };
  return { run, visible, finished };
}

function subscribe(req: Request, initial: Replay, storage: MockStorage) {
  const events = timeline(initial);
  const header = Number(req.headers.get("last-event-id"));
  let cursor = Number.isInteger(header) && header > 0 ? header : 0;
  let current = initial;
  let closed = false;
  let lastPoll = Date.now();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          if (closed) return;
          const now = Date.now();
          if (now - lastPoll >= delay * 2 && current.cancelled === undefined) {
            current = await storage.read<Replay>("run", initial.id) ?? current;
            lastPoll = Date.now();
          }
          if (closed) return;
          // Use the persisted state before exposing the terminal frame.
          const { visible, finished } = replayState(current, current.cancelled === undefined ? lastPoll : Date.now(), events);
          if (cursor < visible.length) {
            controller.enqueue(encoder.encode(`id: ${cursor + 1}\ndata: ${JSON.stringify(visible[cursor])}\n\n`));
            cursor++;
            return;
          }
          if (finished !== undefined) { controller.close(); return; }
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      } catch (error) {
        if (!closed) controller.error(error);
      }
    },
    cancel() { closed = true; },
  });
  return new Response(stream, { headers: {
    "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no",
  } });
}

export function makeMockApi(storage: MockStorage, scaffoldCache = new Set<string>(), generateScaffold?: ScaffoldGenerator) {
  return async (req: Request): Promise<Response> => {
    try {
      const url = new URL(req.url);
      const [, resource, id, action, extra] = url.pathname.split("/").filter(Boolean);
      const get = req.method === "GET";
      const post = req.method === "POST";
      const origin = req.headers.get("origin");
      if (!get && origin && origin !== url.origin) throw new ApiError(403, "Send write requests from the Benchscope origin.");
      if (extra) throw new ApiError(404, "No mock API resource matches this request.");

      if (!id && get && resource === "machines") {
        const active = await storage.list<Replay>("run", Date.now());
        const entry: Machine = { ...machine, status: active.length ? "busy" : "idle", queueLength: active.filter((run) => Date.now() - run.started < delay).length };
        return json([entry]);
      }
      if (!id && get && resource === "examples") return json(exampleFixtures);
      if (!id && post && resource === "parse") {
        const { dsl } = object(await body(req));
        if (typeof dsl !== "string") throw new ApiError(400, "Provide a DSL string.");
        return json(parseSweep(dsl));
      }
      if (!id && post && resource === "scaffold") {
        const { dsl, language, arch } = object(await body(req));
        if (typeof dsl !== "string" || (language !== "go" && language !== "python") || (arch !== "x86_64" && arch !== "arm64")) {
          throw new ApiError(400, "Provide DSL, a supported language and a supported architecture.");
        }
        if (scaffoldLength(dsl) > MAX_SCAFFOLD_CHARACTERS) throw new ApiError(413, scaffoldLimitMessage);
        if (!dsl.trim()) throw new ApiError(400, "Enter benchmark pseudocode before generating code.");
        if (generateScaffold) return json(await generateScaffold({ dsl, language, arch }));
        const source = dsl.replace(/^#sweep\b[^\n]*\n[\s\S]*?(?=^#\w|$(?![\s\S]))/gm, "");
        const model = "mock-array-sum";
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([source, language, arch, model])));
        const key = new Uint8Array(digest).join(".");
        const cached = scaffoldCache.has(key);
        if (scaffoldCache.size >= 256) scaffoldCache.clear();
        scaffoldCache.add(key);
        const file = ({ go: "harness.go", python: "harness.py" } as const)[language as Lang];
        const code = sample.workspaceSnapshot.lanes.find((lane) => lane.language === language)?.files[file];
        return json({ code, warnings: ["The mock returns the sample array-sum scaffold."], cached, model });
      }

      if (resource === "runs") {
        if (!id && post) {
          const snapshot = workspace(object(await body(req)).workspace);
          for (const lane of snapshot.lanes) {
            const dsl = lane.files["benchmark.perf"];
            if (dsl === undefined) continue;
            if (typeof dsl !== "string") throw new ApiError(400, "Send benchmark.perf as text.");
            const { errors } = parseSweep(dsl);
            if (errors.length) throw new ApiError(422, errors[0]);
          }
          const replay: Replay = { id: crypto.randomUUID(), snapshot, started: Date.now() };
          await storage.write("run", replay.id, replay, replay.started + (timeline(replay).length - 1) * delay);
          return json({ runId: replay.id }, 202);
        }
        if (id === sample.id && !action && get) return json(sample);
        const replay = id ? await storage.read<Replay>("run", id) : undefined;
        if (replay) {
          if (!action && get) return json(replayState(replay).run);
          if (action === "events" && get) return subscribe(req, replay, storage);
          if (action === "cancel" && post) {
            const now = Date.now();
            if (replayState(replay, now).finished === undefined) {
              await storage.write("run", replay.id, { ...replay, cancelled: now });
            }
            return empty();
          }
        }
      }

      if (resource === "benches" && !action) {
        if (get && !id) return json(await storage.list<Workspace>("bench"));
        if (post && !id) {
          const data = workspace(await body(req));
          const saved = { ...data, id: crypto.randomUUID(), updatedAt: new Date().toISOString() };
          await storage.write("bench", saved.id, saved);
          return json(saved, 201);
        }
        const existing = id ? await storage.read<Workspace>("bench", id) : undefined;
        if (id && existing) {
          if (get) return json(existing);
          if (req.method === "PUT") {
            const data = workspace(await body(req));
            const saved = { ...data, id, createdAt: existing.createdAt, updatedAt: new Date().toISOString() };
            await storage.write("bench", id, saved);
            return json(saved);
          }
          if (req.method === "DELETE") { await storage.remove("bench", id); return empty(); }
        }
      }

      if (resource === "share" && !action) {
        if (!id && post) {
          const data = object(await body(req));
          const snapshot: ShareSnapshot = { workspace: workspace(data.workspace) };
          if (data.runId !== undefined) {
            if (typeof data.runId !== "string" || (data.runId !== sample.id && !await storage.read<Replay>("run", data.runId))) {
              throw new ApiError(404, "Choose an existing run to include.");
            }
            snapshot.runId = data.runId;
          }
          const shareId = crypto.randomUUID();
          await storage.write("share", shareId, snapshot);
          return json({ shareId }, 201);
        }
        if (get && id) {
          const snapshot = await storage.read<ShareSnapshot>("share", id);
          if (snapshot) return json(snapshot);
        }
      }
      throw new ApiError(404, "No mock API resource matches this request.");
    } catch (error) {
      if (error instanceof ApiError || error instanceof ScaffoldGenerationError) return json({ message: error.message }, error.status);
      console.error(error);
      return json({ message: "The mock request failed. Try again." }, 500);
    }
  };
}
