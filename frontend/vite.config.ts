import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";
import { fileURLToPath } from "node:url";
import { scaffoldApi } from "./server/scaffold";

const frontendRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => {
  const { GEMINI_API_KEY, GEMINI_MODEL } = loadEnv(mode, frontendRoot, "GEMINI_");
  return {
    root: frontendRoot,
    envDir: frontendRoot,
    plugins: [react(), tailwind(), scaffoldApi(GEMINI_API_KEY, GEMINI_MODEL)],
    build: {
      rollupOptions: {
        output: {
          // Keep the lazily loaded chart and editor libraries out of the shared chunks, each under the 500 kB warning.
          manualChunks(id: string) {
            if (id.includes("node_modules/zrender")) return "zrender";
            if (id.includes("node_modules/echarts")) return "echarts";
            if (id.includes("node_modules/@replit")) return "codemirror-vim";
            if (id.includes("node_modules/@codemirror/lang-") || id.includes("node_modules/@lezer/go") || id.includes("node_modules/@lezer/python")) return "codemirror-lang";
            if (id.includes("node_modules/@codemirror") || id.includes("node_modules/@lezer")) return "codemirror";
          },
        },
      },
    },
  };
});
