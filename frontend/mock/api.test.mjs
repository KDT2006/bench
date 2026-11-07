import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, before, after } from "node:test";
import { createServer } from "vite";

const sample = JSON.parse(readFileSync(new URL("./fixtures/run.json", import.meta.url), "utf8"));
let server;
let base;

before(async () => {
  process.env.BENCHSCOPE_TEST_API = "1";
  server = await createServer({ server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } });
  await server.listen();
  base = `http://127.0.0.1:${server.httpServer.address().port}/api`;
});

after(async () => { await server?.close(); });

const request = (path, method = "GET", value) => fetch(base + path, {
  method,
  ...(value === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }),
});

async function start(workspace = sample.workspaceSnapshot) {
  const response = await request("/runs", "POST", { workspace });
  assert.equal(response.status, 202);
  return (await response.json()).runId;
}

function events(text) {
  return text.trim().split("\n\n").map((frame) => {
    const [id, data] = frame.split("\n");
    return { id: Number(id.slice(4)), event: JSON.parse(data.slice(6)) };
  });
}

test("machine, parsing and scaffold use the fixture contract", async () => {
  const [machine] = await (await request("/machines")).json();
  assert.equal(machine.id, sample.machine.id);
  assert.equal(machine.status, "idle");

  const dsl = sample.workspaceSnapshot.lanes[0].files["benchmark.perf"];
  const parsed = await (await request("/parse", "POST", { dsl })).json();
  assert.deepEqual(parsed, { sweep: sample.sweep, permutations: sample.sweep[0].values.length, errors: [] });
  const first = await (await request("/scaffold", "POST", { dsl, language: "go", arch: "x86_64" })).json();
  assert.equal(first.cached, false);
  const second = await (await request("/scaffold", "POST", { dsl, language: "go", arch: "x86_64" })).json();
  assert.deepEqual(second, { ...first, cached: true });
});

test("a two-lane stream delivers the fixture once and resumes by event ID", async () => {
  const id = await start();
  const response = await request(`/runs/${id}/events`);
  assert.match(response.headers.get("content-type"), /^text\/event-stream/);
  const streamed = events(await response.text());
  assert.equal(streamed[0].event.type, "queued");
  assert.equal(streamed.at(-1).event.type, "done");
  const rows = streamed.flatMap(({ event }) => event.type === "result" ? [event.row] : []);
  assert.deepEqual(rows, sample.rows);
  const run = await (await request(`/runs/${id}`)).json();
  assert.equal(run.status, "done");
  assert.deepEqual(run.rows, rows);
  const cursor = streamed.at(-2).id;
  const resumed = await fetch(base + `/runs/${id}/events`, { headers: { "Last-Event-ID": String(cursor) } });
  assert.deepEqual(events(await resumed.text()), streamed.slice(-1));
});

test("cancellation keeps the rows received before stopping", async () => {
  const workspace = { ...sample.workspaceSnapshot, lanes: sample.workspaceSnapshot.lanes.slice(0, 1) };
  const id = await start(workspace);
  const response = await request(`/runs/${id}/events`);
  const reader = response.body.getReader();
  let received = "";
  while (!received.includes('"type":"result"')) {
    const next = await reader.read();
    assert.ok(!next.done, "The replay should deliver a row before cancellation");
    received += new TextDecoder().decode(next.value);
  }
  assert.equal((await request(`/runs/${id}/cancel`, "POST")).status, 204);
  await reader.cancel();
  const run = await (await request(`/runs/${id}`)).json();
  assert.equal(run.status, "cancelled");
  assert.ok(run.rows.length > 0 && run.rows.length < sample.rows.length / 2);
  assert.deepEqual(run.rows, sample.rows.filter((row) => row.laneId === workspace.lanes[0].id).slice(0, run.rows.length));
});

test("unsupported machine architecture produces the build and error events", async () => {
  const workspace = structuredClone(sample.workspaceSnapshot);
  workspace.lanes[0].arch = "arm64";
  const id = await start(workspace);
  const received = events(await (await request(`/runs/${id}/events`)).text());
  assert.equal(received.find(({ event }) => event.type === "build_done")?.event.ok, false);
  assert.equal(received.at(-1).event.type, "error");
  assert.equal((await (await request(`/runs/${id}`)).json()).status, "failed");
});

test("benches, immutable shares and examples round-trip", async () => {
  const snapshot = sample.workspaceSnapshot;
  const saved = await (await request("/benches", "POST", snapshot)).json();
  assert.ok(saved.id);
  const { shareId } = await (await request("/share", "POST", { workspace: saved, runId: sample.id })).json();
  const path = `/benches/${saved.id}`;
  assert.equal((await request(path, "PUT", { ...saved, title: "Renamed" })).status, 200);
  assert.equal((await (await request(path)).json()).title, "Renamed");
  assert.equal((await (await request(`/share/${shareId}`)).json()).workspace.title, snapshot.title);
  assert.equal((await request(path, "DELETE")).status, 204);
  assert.deepEqual(await (await request("/benches")).json(), []);
  assert.equal((await (await request("/examples")).json())[0].runId, sample.id);
  assert.deepEqual(await (await request(`/runs/${sample.id}`)).json(), sample);
});

test("every example lane opens with valid benchmark code", async () => {
  const { diagnostics } = await server.ssrLoadModule("/src/model/dsl.ts");
  const examples = await (await request("/examples")).json();
  assert.equal(examples.length, 6);
  for (const { workspace } of examples) {
    for (const lane of workspace.lanes) {
      const source = lane.files["benchmark.perf"];
      assert.match(source, /^#bench\s*$/m, workspace.title);
      assert.deepEqual(diagnostics(source), [], workspace.title);
    }
  }
});

test("wide positive lane gaps use a log axis unless explicitly overridden", async () => {
  const { defaultChart, shouldUseLogYAxis } = await server.ssrLoadModule("/src/chart/config.tsx");
  const { formatRatio } = await server.ssrLoadModule("/src/model/format.ts");
  const lanes = sample.workspaceSnapshot.lanes;
  const [first, second] = sample.rows;
  assert.notEqual(first.laneId, second.laneId);
  assert.equal(shouldUseLogYAxis(sample.rows, lanes, defaultChart), true);
  assert.equal(shouldUseLogYAxis([first], lanes, defaultChart), false);
  assert.equal(shouldUseLogYAxis([{ ...first }, { ...first, laneId: second.laneId }], lanes, defaultChart), false);
  assert.equal(shouldUseLogYAxis(sample.rows, lanes, { ...defaultChart, yScale: "linear" }), false);
  assert.equal(shouldUseLogYAxis(sample.rows, lanes, { ...defaultChart, type: "ratio" }), false);

  const withZero = structuredClone(sample.rows);
  withZero[0].metrics.cycles.min = 0;
  assert.equal(shouldUseLogYAxis(withZero, lanes, defaultChart), false);
  assert.equal(formatRatio(60.391), "60×");
});

test("starter and gallery examples fit the generation limit", async () => {
  const { starterWorkspace } = await server.ssrLoadModule("/src/model/examples.ts");
  const { scaffoldLength, MAX_SCAFFOLD_CHARACTERS } = await server.ssrLoadModule("/src/model/scaffoldLimits.ts");
  const examples = await (await request("/examples")).json();
  for (const workspace of [starterWorkspace(), ...examples.map((example) => example.workspace)]) {
    for (const lane of workspace.lanes) {
      assert.ok(scaffoldLength(lane.files["benchmark.perf"]) <= MAX_SCAFFOLD_CHARACTERS, workspace.title);
    }
  }
});

test("Gemini receives benchmark parameters and the API enforces 250 characters before sending", async () => {
  const { createGeminiScaffold } = await server.ssrLoadModule("/server/gemini.ts");
  const { makeMockApi } = await server.ssrLoadModule("/mock/core.ts");
  let calls = 0;
  const generated = {
    go: "package bench\nfunc Benchmark(n int) int { return n }",
    python: "def benchmark(n):\n    return n",
  };
  const fakeGemini = async (url, request) => {
    calls++;
    assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/demo-model:generateContent");
    assert.equal(new Headers(request.headers).get("x-goog-api-key"), "test-key");
    const payload = JSON.parse(request.body);
    assert.match(payload.systemInstruction.parts[0].text, /Translate/);
    assert.equal(payload.generationConfig.responseMimeType, "application/json");
    const input = JSON.parse(payload.contents[0].parts[0].text);
    assert.equal(input.pseudocode.trim(), "#bench\nsink(N)");
    assert.deepEqual(input.params, [{ name: "N", types: ["number"] }]);
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [
      { text: JSON.stringify({ code: generated[input.language], warnings: [] }) },
    ] } }] });
  };
  const api = makeMockApi({}, undefined, createGeminiScaffold("test-key", "demo-model", fakeGemini));
  const dsl = "#sweep\nN = [1, 2]\n\n#bench\nsink(N)".padEnd(250);
  const scaffold = (dsl, language) => api(new Request("http://localhost/api/scaffold", {
    method: "POST", body: JSON.stringify({ dsl, language, arch: "x86_64" }),
  }));

  assert.equal((await scaffold(dsl + " ", "go")).status, 413);
  assert.equal(calls, 0);
  for (const language of ["go", "python"]) {
    const response = await scaffold(dsl, language);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { code: generated[language], warnings: [], cached: false, model: "demo-model" });
  }
  assert.equal(calls, 2);
});

test("Gemini quota and invalid output return actionable errors", async () => {
  const { createGeminiScaffold } = await server.ssrLoadModule("/server/gemini.ts");
  const input = { dsl: "#bench\nsink(1)", language: "go", arch: "x86_64" };
  const quota = createGeminiScaffold("test-key", "demo-model", async () => new Response(null, { status: 429 }));
  await assert.rejects(quota(input), { status: 429, message: /quota/ });

  const invalid = createGeminiScaffold("test-key", "demo-model", async () => Response.json({
    candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"code":"","warnings":[]}' }] } }],
  }));
  await assert.rejects(invalid(input), { status: 502, message: /unexpected response/ });
});

test("sweeps accept 256 combinations and reject a larger cross product", async () => {
  const values = Array.from({ length: 16 }, (_, index) => index + 1);
  const dsl = (width) => `#sweep\nN = [${values}]\nstride = [${width === 16 ? values : [...values, 17]}]\n#bench\nsink(N)\n`;
  const valid = await (await request("/parse", "POST", { dsl: dsl(16) })).json();
  assert.equal(valid.permutations, 256);
  assert.deepEqual(valid.errors, []);

  const workspace = structuredClone(sample.workspaceSnapshot);
  workspace.lanes[0].files["benchmark.perf"] = dsl(17);
  const response = await request("/runs", "POST", { workspace });
  assert.equal(response.status, 422);
  assert.match((await response.json()).message, /256/);
});
