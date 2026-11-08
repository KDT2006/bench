import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";
import { fileURLToPath } from "node:url";
import { mockApi } from "./mock/api";
import { scaffoldApi } from "./server/scaffold";

const frontendRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => {
  const { VITE_API_BASE_URL } = loadEnv(mode, frontendRoot);
  const { GEMINI_API_KEY, GEMINI_MODEL } = loadEnv(mode, frontendRoot, "GEMINI_");
  const test = Boolean(process.env.BENCHSCOPE_TEST_API);
  const live = Boolean(VITE_API_BASE_URL?.trim());
  return {
    root: frontendRoot,
    envDir: frontendRoot,
    plugins: [react(), tailwind(), ...(test ? [mockApi()] : [scaffoldApi(GEMINI_API_KEY, GEMINI_MODEL), ...(!live ? [mockApi(".benchscope")] : [])])],
  };
});
