import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin, ViteDevServer } from "vite";
import type { Arch, Lang } from "../src/api/types";
import { MAX_SCAFFOLD_CHARACTERS, scaffoldLength, scaffoldLimitMessage } from "../src/model/scaffoldLimits";
import { createGeminiScaffold, ScaffoldGenerationError } from "./gemini";

const bodyLimit = 16 * 1024;

function json(res: ServerResponse, status: number, value: unknown) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

async function input(req: IncomingMessage): Promise<{ dsl: string; language: Lang; arch: Arch }> {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new ScaffoldGenerationError(415, "Send the translation request as JSON.");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > bodyLimit) throw new ScaffoldGenerationError(413, "Translation request is too large.");
    chunks.push(buffer);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ScaffoldGenerationError(400, "Send a valid JSON translation request."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ScaffoldGenerationError(400, "Send a translation request object.");
  const { dsl, language, arch } = value as Record<string, unknown>;
  if (typeof dsl !== "string" || !dsl.trim() || (language !== "go" && language !== "python") || (arch !== "x86_64" && arch !== "arm64")) {
    throw new ScaffoldGenerationError(400, "Provide pseudocode, a Go or Python language, and a supported architecture.");
  }
  if (scaffoldLength(dsl) > MAX_SCAFFOLD_CHARACTERS) throw new ScaffoldGenerationError(413, scaffoldLimitMessage);
  return { dsl, language, arch };
}

// Translation is server-side and independent of the execution/replay API.
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
          if (req.method !== "POST") {
            res.setHeader("Allow", "POST");
            throw new ScaffoldGenerationError(405, "Use POST to translate pseudocode.");
          }
          if (req.headers.origin) {
            let allowed = false;
            try { allowed = new URL(req.headers.origin).host === url.host; } catch { /* Reject malformed origins. */ }
            if (!allowed) throw new ScaffoldGenerationError(403, "Send translation requests from this frontend's origin.");
          }
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
