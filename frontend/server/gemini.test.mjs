import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test, before, after } from "node:test";
import { createServer } from "vite";

// Load the TypeScript modules through Vite's SSR loader; no dev server is started.
let server;
const load = (path) => server.ssrLoadModule(path);
before(async () => {
  // A different Vite config invalidates its dependency cache. Keep this loader
  // separate so tests cannot delete modules used by a running dev server.
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), cacheDir: fileURLToPath(new URL("../node_modules/.vite-tests", import.meta.url)), logLevel: "silent", server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom" });
});
after(async () => { await server?.close(); });

const gemini = (sections) => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(sections) }] } }] });
const sections = (bench) => ({ imports: "", globals: "var result int", setup: "", bench, cleanup: "", warnings: [] });

test("Gemini receives benchmark parameters and returns assembled sections", async () => {
  const { createGeminiScaffold } = await load("/server/gemini.ts");
  let calls = 0;
  const fakeGemini = async (url, request) => {
    calls++;
    assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/demo-model:generateContent");
    assert.equal(new Headers(request.headers).get("x-goog-api-key"), "test-key");
    const payload = JSON.parse(request.body);
    assert.match(payload.systemInstruction.parts[0].text, /Translate/);
    assert.equal(payload.generationConfig.responseMimeType, "application/json");
    const input = JSON.parse(payload.contents[0].parts[0].text);
    assert.equal(input.pseudocode.bench.trim(), "sink(N)");
    assert.deepEqual(input.params, [{ name: "N", types: ["number"] }]);
    return gemini(sections("result = N"));
  };
  const generate = createGeminiScaffold("test-key", "demo-model", fakeGemini);
  for (const language of ["go", "python"]) {
    const result = await generate({ dsl: "#sweep\nN: [1, 2]\n\n#bench\nsink(N)", language, arch: "x86_64" });
    assert.equal(result.model, "demo-model");
    assert.deepEqual(result.warnings, []);
    assert.match(result.code, /^#sweep\nN: \[1,2\]$/m);
    assert.match(result.code, /^#bench\nresult = N$/m);
  }
  assert.equal(calls, 2);
});

test("Gemini quota and invalid output return actionable errors", async () => {
  const { createGeminiScaffold } = await load("/server/gemini.ts");
  const input = { dsl: "#bench\nsink(1)", language: "go", arch: "x86_64" };
  const quota = createGeminiScaffold("test-key", "demo-model", async () => new Response(null, { status: 429 }));
  await assert.rejects(quota(input), { status: 429, message: /quota/ });
  const invalid = createGeminiScaffold("test-key", "demo-model", async () => gemini({ code: "", warnings: [] }));
  await assert.rejects(invalid(input), { status: 502, message: /unexpected response/ });
});

test("every example lane opens with valid benchmark code", async () => {
  const { diagnostics } = await load("/src/model/dsl.ts");
  const { exampleFixtures, starterWorkspace } = await load("/src/model/examples.ts");
  for (const workspace of [starterWorkspace(), ...exampleFixtures.map((example) => example.workspace)]) {
    for (const lane of workspace.lanes) {
      const source = lane.files["benchmark.perf"];
      assert.match(source, /^#bench\s*$/m, workspace.title);
      assert.deepEqual(diagnostics(source), [], workspace.title);
    }
  }
});

test("sweeps accept 256 combinations and reject a larger cross product", async () => {
  const { parseSweep } = await load("/src/model/sweep.ts");
  const values = Array.from({ length: 16 }, (_, index) => index + 1);
  const dsl = (width) => `#sweep\nN: [${values}]\nstride: [${width === 16 ? values : [...values, 17]}]\n#bench\nsink(N)\n`;
  assert.deepEqual(parseSweep(dsl(16)).errors, []);
  assert.match(parseSweep(dsl(17)).errors[0], /256/);
});

test("build-error line numbers ignore port numbers", async () => {
  const { buildErrorLine } = await load("/src/model/format.ts");
  assert.equal(buildErrorLine("Could not reach the go local server at http://127.0.0.1:6969/execute"), undefined);
  assert.equal(buildErrorLine("./harness.go:12:5: undefined: foo"), 12);
  assert.equal(buildErrorLine('File "harness.py", line 7, in <module>'), 7);
});

test("machine health retains optional hardware details in run snapshots", async () => {
  const { machineFromHealth } = await load("/src/api/live.ts");
  const base = { hostname: "test-host", os: "linux", arch: "amd64", cpus: 20, languages: ["go", "python"] };
  const hardware = { cpuModel: "Test CPU", physicalCores: 14, memoryBytes: 8 * 1024 ** 3,
    kernel: "6.8-test", caches: [{ level: "3", type: "Unified", sizeBytes: 24 * 1024 ** 2, sharedCpus: "0-19" }] };
  const machine = machineFromHealth({ ...base, hardware });
  assert.deepEqual(machine.hardware, hardware);
  assert.equal(machine.threads, 20);
  assert.equal(machineFromHealth(base).hardware, undefined);
});

test("results CSV exports table measurements once with units, derived values and no raw profiler columns", async () => {
  const { resultsCsv } = await load("/src/model/resultsCsv.ts");
  const run = {
    sweep: [{ name: "N", values: [1024, 4096] }],
    workspaceSnapshot: { lanes: [{ id: "a", label: "A", name: 'Sum, "array"', language: "python" }] },
    rows: [
      { laneId: "a", params: { N: 1024, input: 'Sum, "array"' }, reps: 100, metrics: { timeNs: { min: 0.123456789 }, pageFaults: { mean: 0 } },
        profiler: { timerFrequency: 1000000000, totalPageFaults: 0, counterAvailability: { l1DataMisses: false, branchMisses: true }, measurements: { TotalTime: 12345 } } },
      { laneId: "a", params: { N: 4096, stride: 8 }, reps: 200, metrics: { timeNs: { min: 42 }, branchMisses: { fastest: 0 } } },
    ],
  };
  const csv = resultsCsv(run);
  assert.ok(csv.endsWith("\r\n"));
  assert.match(csv, /"Sum, ""array"""/);
  // Parse quoted cells, including escaped commas and quotes.
  const cells = (line) => [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map((match) => match[1].replaceAll('""', '"'));
  const [headers, ...rows] = csv.trimEnd().split("\r\n").map(cells);
  const value = (row, name) => row[headers.indexOf(name)];
  assert.equal(rows.length, 2);
  for (const row of rows) assert.equal(row.length, headers.length);
  assert.equal(value(rows[0], "Min time (ns)"), "0.123456789");
  assert.equal(value(rows[0], "Min time per element (ns)"), String(0.123456789 / 1024));
  assert.equal(headers.filter((name) => name.startsWith("Lane")).length, 1);
  assert.equal(new Set(headers).size, headers.length);
  assert.ok(headers.every((name) => !name.startsWith("profiler.")));
  assert.ok(!headers.includes("L1 data-cache misses · fastest timed iteration"));
  assert.ok(!headers.includes("Max time (ns)"));
  assert.equal(value(rows[0], "N"), "1024");
  assert.equal(value(rows[1], "stride"), "8");
  assert.equal(value(rows[1], "Branch-prediction misses · fastest timed iteration"), "0");
  assert.equal(value(rows[0], "Branch-prediction misses · fastest timed iteration"), "");
  assert.equal(value(rows[0], "Total page faults"), "0");
  assert.equal(value(rows[1], "Total page faults"), "");
});
