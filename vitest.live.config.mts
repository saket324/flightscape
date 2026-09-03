import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Config for the live integration checks.
 *
 * Kept separate from vitest.config.mts so `npm test` stays offline and
 * deterministic, while `npm run test:live` deliberately hits real upstream
 * services to confirm the providers still match reality.
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.live.test.ts"],
    // Real network calls; no point running these in parallel against a
    // community feed.
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
