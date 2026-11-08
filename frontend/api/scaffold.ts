// Vercel serverless function for POST /api/scaffold. Locally, server/scaffold.ts serves the
// same route from the Vite dev server. Set GEMINI_API_KEY (and optionally GEMINI_MODEL) in
// the Vercel project's Environment Variables.
import type { Arch, Lang } from "../src/api/types.js";
import { createGeminiScaffold, ScaffoldGenerationError } from "../server/gemini.js";

const json = (status: number, value: unknown) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

export async function POST(request: Request): Promise<Response> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) return json(503, { message: "Translation is not configured: set GEMINI_API_KEY in the Vercel project's environment variables." });
  try {
    const { dsl, language, arch } = (await request.json()) as { dsl: string; language: Lang; arch: Arch };
    const generate = createGeminiScaffold(apiKey, process.env.GEMINI_MODEL?.trim() || undefined);
    return json(200, await generate({ dsl, language, arch, signal: request.signal }));
  } catch (error) {
    return json(error instanceof ScaffoldGenerationError ? error.status : 500, {
      message: error instanceof ScaffoldGenerationError ? error.message : "Code translation failed. Try again.",
    });
  }
}
