import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";
import { mockApi } from "./mock/api";
import { createGeminiScaffold } from "./server/gemini";

export default defineConfig(({ mode }) => {
  const { VITE_API_BASE_URL } = loadEnv(mode, process.cwd());
  const { GEMINI_API_KEY, GEMINI_MODEL } = loadEnv(mode, process.cwd(), "GEMINI_");
  const test = Boolean(process.env.BENCHSCOPE_TEST_API);
  const key = GEMINI_API_KEY?.trim();
  const generateScaffold = !test && key ? createGeminiScaffold(key, GEMINI_MODEL?.trim() || undefined) : undefined;
  return {
    plugins: [react(), tailwind(), !VITE_API_BASE_URL?.trim() && mockApi(test ? undefined : ".benchscope", generateScaffold)],
  };
});
