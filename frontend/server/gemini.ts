import type { Arch, Lang, ScaffoldResponse } from "../src/api/types";
import { parseSweep, serializeSweep } from "../src/model/sweep";
import { assembleSections, directives, parseSections, type Sections } from "../src/model/sections";

type ScaffoldInput = { dsl: string; language: Lang; arch: Arch; signal?: AbortSignal };
export type ScaffoldGenerator = (input: ScaffoldInput) => Promise<ScaffoldResponse>;

export class ScaffoldGenerationError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const defaultModel = "gemini-3.5-flash";
const instructions = `Translate the supplied pseudocode into executable section bodies in the requested language.
Preserve its algorithm and workload.
Return imports, globals, setup, bench and cleanup as separate strings without directive headers or Markdown.
For Go, imports contains only import specifications (e.g. "sort"), not an import block.
The executor already imports encoding/json, fmt, os, profiler and time: do not repeat them or alias those packages.
Globals contains package-level variables and helper functions. Do not emit a package declaration, main, Benchmark, benchmark, timers or a standalone harness.
For Go, sweep parameters are int variables already declared by the executor before setup. Use them without redeclaring them; do not hardcode their values.
The Go executor places setup and cleanup in an iteration function, with bench in an inner closure. Values needed by cleanup must be declared in setup or globals, not inside bench.
For Python, imports contains import statements and globals contains module-level code; return section bodies rather than a function wrapper.
Setup runs before EACH measured iteration; cleanup runs after EACH measured iteration. Keep their work out of bench.
Only bench contains the measured workload. Translate sink(value) into assignment to an appropriately typed global sink so results remain observable.
Use standard library operations.
Use warnings to describe limitations; never silently replace the workload.`;

const codeSections = directives.filter((name) => name !== "sweep");
const schema = {
  type: "OBJECT",
  properties: {
    ...Object.fromEntries(codeSections.map((name) => [name, { type: "STRING" }])),
    warnings: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: [...codeSections, "warnings"],
};

interface GeminiResponse {
  candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean }[] } }[];
}

export function createGeminiScaffold(apiKey: string, model = defaultModel, send = fetch): ScaffoldGenerator {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  return async ({ dsl, language, arch, signal: requestSignal }) => {
    const parsed = parseSweep(dsl);
    if (parsed.errors.length) throw new ScaffoldGenerationError(400, parsed.errors[0]);

    const document = parseSections(dsl);
    if (document.errors.length) throw new ScaffoldGenerationError(400, document.errors[0].message);
    const { sweep: _sweep, ...source } = document.sections;
    const params = parsed.sweep.map(({ name, values }) => ({ name, types: [...new Set(values.map((value) => typeof value))] }));
    let response: Response;
    const timeout = AbortSignal.timeout(35_000);
    const signal = requestSignal ? AbortSignal.any([timeout, requestSignal]) : timeout;
    try {
      response = await send(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: instructions }] },
          contents: [{ role: "user", parts: [{ text: JSON.stringify({ language, arch, params, pseudocode: source }) }] }],
          generationConfig: { responseMimeType: "application/json", responseSchema: schema },
        }),
      });
    } catch {
      if (requestSignal?.aborted) throw new DOMException("Translation cancelled.", "AbortError");
      if (timeout.aborted) throw new ScaffoldGenerationError(504, "Code generation timed out. Try again.");
      throw new ScaffoldGenerationError(502, "Couldn’t reach Gemini. Try again.");
    }
    if (response.status === 429) throw new ScaffoldGenerationError(429, "Gemini quota was reached. Try again later or check the project’s quota.");
    if (!response.ok) throw new ScaffoldGenerationError(502, "Gemini rejected the request. Check the API key and model in the server configuration.");

    let output: unknown;
    try {
      const payload: GeminiResponse = await response.json();
      const candidate = payload.candidates?.[0];
      if (candidate?.finishReason !== "STOP") throw new Error();
      const text = candidate.content?.parts?.filter((part) => !part.thought).map((part) => part.text ?? "").join("");
      output = JSON.parse(text ?? "");
    } catch {
      throw new ScaffoldGenerationError(502, "Gemini didn’t return a complete code response. Try again.");
    }
    const result = output as (Partial<Sections> & { warnings?: unknown }) | null;
    if (!result || codeSections.some((name) => typeof result[name] !== "string") || !result.bench?.trim() ||
        !Array.isArray(result.warnings) || result.warnings.some((warning) => typeof warning !== "string")) {
      throw new ScaffoldGenerationError(502, "Gemini returned an unexpected response. Try again.");
    }
    return { code: assembleSections({ ...(result as Sections), sweep: serializeSweep(parsed.sweep) }), warnings: result.warnings as string[], model };
  };
}
