/*
  Vitest config: the `@/` alias, the jsdom environment for component tests, and where tests live.
  In the app: nothing at runtime; `pnpm test` and CI "Checks" read it.
  Used by: vitest.
  Uses: tsconfig.json's `@/*` path (kept in step by hand; two lines), the React plugin, jest-dom's matchers.

  Output for agents: Vitest's `agent` reporter (failures only) switches on by itself when it detects
  Claude Code, Cursor, or another agent, so no reporter is set here. Humans get the default.
*/
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    // src only: the harness's own tests (scripts/**/*.test.mjs) run on node:test (`pnpm test:harness`).
    include: ["src/**/*.test.{ts,tsx}"],
    // Component tests need a DOM; the pure domain tests run fine under it too.
    environment: "jsdom",
    // Globals make Testing Library clean the DOM after each test by itself; the matchers come from the package.
    globals: true,
    setupFiles: ["@testing-library/jest-dom/vitest"],
  },
});
