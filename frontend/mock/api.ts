import type { Plugin, ViteDevServer } from "vite";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeMockApi, type MockStorage } from "./core";
import type { ScaffoldGenerator } from "../server/gemini";

type Kind = Parameters<MockStorage["write"]>[0];
type Records = Record<string, { value: unknown; activeUntil?: number }>;
const groups = ["run", "bench", "share"] as const;

function localStorage(directory?: string): MockStorage {
  const records: Record<Kind, Records> = { run: {}, bench: {}, share: {} };
  const path = directory && join(directory, "data.json");
  const ready = path ? readFile(path, "utf8").then((value) => {
    const data = JSON.parse(value) as typeof records;
    for (const kind of groups) if (data[kind]) records[kind] = data[kind];
  }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }) : Promise.resolve();
  let writes = Promise.resolve();
  function commit(change: () => void) {
    const next = writes.then(async () => {
      await ready;
      change();
      if (path && directory) {
        await mkdir(directory, { recursive: true });
        await writeFile(path + ".tmp", JSON.stringify(records));
        await rename(path + ".tmp", path);
      }
    });
    writes = next.catch(() => {});
    return next;
  }
  return {
    async read<T>(kind: Kind, id: string) { await ready; return Object.hasOwn(records[kind], id) ? records[kind][id].value as T : undefined; },
    async list<T>(kind: Kind, activeAt?: number) { await ready; return Object.values(records[kind]).filter((record) => activeAt === undefined || (record.activeUntil ?? 0) > activeAt).map((record) => record.value as T); },
    write(kind, id, value, activeUntil) { return commit(() => { records[kind][id] = { value, activeUntil }; }); },
    remove(kind, id) { return commit(() => { delete records[kind][id]; }); },
  };
}

export function mockApi(directory?: string, generateScaffold?: ScaffoldGenerator, scaffoldOnly = false): Plugin {
  const route = makeMockApi(localStorage(directory), undefined, generateScaffold);
  const install = (server: Pick<ViteDevServer, "middlewares">) => {
    server.middlewares.use((req, res, next) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
      if (url.pathname !== "/api" && !url.pathname.startsWith("/api/")) return next();
      if (scaffoldOnly && url.pathname !== "/api/scaffold") return next();
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (value) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const method = req.method ?? "GET";
      const request = new Request(url, {
        method, headers,
        ...(method === "GET" || method === "HEAD" ? {} : { body: Readable.toWeb(req) as ReadableStream, duplex: "half" }),
      });
      void route(request).then(async (response) => {
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.flushHeaders();
        if (response.body) await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), res);
        else res.end();
      }).catch((error: unknown) => {
        if (res.destroyed) return;
        if (!res.headersSent) res.writeHead(500);
        res.end();
        console.error(error);
      });
    });
  };
  return { name: "benchscope-mock-api", configureServer: install, configurePreviewServer: install };
}
