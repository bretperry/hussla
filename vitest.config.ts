/*
  Vitest config: the `@/` alias and where tests live.
  In the app: nothing at runtime; `pnpm test` and CI "Checks" read it.
  Used by: vitest.
  Uses: tsconfig.json's `@/*` path (kept in step by hand; two lines).

  Output for agents: Vitest's `agent` reporter (failures only) switches on by itself when it detects
  Claude Code, Cursor, or another agent, so no reporter is set here. Humans get the default.
*/
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    // src only: the harness's own tests (scripts/**/*.test.mjs) run on node:test (`pnpm test:harness`).
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
