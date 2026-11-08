import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin, ViteDevServer } from "vite";
import type { Arch, Lang } from "../src/api/types";
import { createGeminiScaffold, ScaffoldGenerationError } from "./gemini";

function json(res: ServerResponse, status: number, value: unknown) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

async function input(req: IncomingMessage): Promise<{ dsl: string; language: Lang; arch: Arch }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const { dsl, language, arch } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return { dsl, language, arch };
}

// Translation is server-side and independent of the execution proxy.
export function scaffoldApi(apiKey?: string, model?: string): Plugin {
  const generate = apiKey?.trim() ? createGeminiScaffold(apiKey.trim(), model?.trim() || undefined) : undefined;
  const install = (server: Pick<ViteDevServer, "middlewares">) => {
    server.middlewares.use((req, res, next) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
      if (url.pathname !== "/api/scaffold") return next();
      const controller = new AbortController();
      const disconnected = () => { if (!res.writableEnded) controller.abort(); };
      res.once("close", disconnected);
      void (async () => {
        try {
          const body = await input(req);
          if (!generate) throw new ScaffoldGenerationError(503, "Set GEMINI_API_KEY in frontend/.env.local (next to vite.config.ts), then restart Vite to translate pseudocode.");
          const result = await generate({ ...body, signal: controller.signal });
          json(res, 200, result);
        } catch (error) {
          if (controller.signal.aborted) return;
          json(res, error instanceof ScaffoldGenerationError ? error.status : 500, {
            message: error instanceof ScaffoldGenerationError ? error.message : "Code translation failed. Try again.",
          });
        } finally { res.off("close", disconnected); }
      })();
    });
  };
  return { name: "benchscope-gemini-scaffold", configureServer: install, configurePreviewServer: install };
}
