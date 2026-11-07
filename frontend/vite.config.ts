import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";
import { mockApi } from "./mock/api";

export default defineConfig(({ mode }) => {
  const { VITE_API_BASE_URL } = loadEnv(mode, process.cwd());
  return {
    plugins: [react(), tailwind(), !VITE_API_BASE_URL?.trim() && mockApi(process.env.BENCHSCOPE_TEST_API ? undefined : ".benchscope")],
  };
});
