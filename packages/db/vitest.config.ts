import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Schema fixtures each load an isolated database; bound aggregate memory.
    maxWorkers: 1,
    include: ["src/**/*.test.ts"],
  },
});
