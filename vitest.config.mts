import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Network-dependent checks run on demand via `npm run test:live`, so the
    // default suite stays deterministic and offline.
    exclude: ["src/**/*.live.test.ts", "node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["src/lib/**", "src/providers/**"],
    },
  },
});
