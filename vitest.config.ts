import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@sacty/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/daemon/src/**/*.test.ts",
      "apps/web/src/lib/**/*.test.ts",
    ],
  },
});
