/*
  Vite config: the React build and the dev server that proxies the API to a local Go server.
  In the app: `pnpm dev` (UI work) and `pnpm build` (the bundle the Go binary embeds, Phase 6).
  Used by: vite, vitest (the plugins and alias are shared so tests see what the browser sees).
  Uses: @vitejs/plugin-react, @tailwindcss/vite, the HUSSLA_API env var for the proxy target.
*/
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Where `hussla` serves its local listener in development; override with HUSSLA_API.
const DEFAULT_API_TARGET = "http://localhost:8484";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    proxy: {
      "/api": process.env["HUSSLA_API"] ?? DEFAULT_API_TARGET,
      "/signin": process.env["HUSSLA_API"] ?? DEFAULT_API_TARGET,
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
