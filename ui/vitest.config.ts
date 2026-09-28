import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      lexical: path.resolve(__dirname, "./node_modules/lexical/dist/Lexical.mjs"),
    },
  },
  test: {
    environment: "node",
    // Keep jsdom-heavy suites within a bounded CPU/memory budget rather than
    // multiplying them by the host's CPU count and timing out unrelated tests.
    maxWorkers: 2,
    setupFiles: ["./vitest.setup.ts"],
  },
});
