import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The daemon E2E owns real subprocesses and short poll timers. Running it
    // beside every CPU-heavy unit file can starve its event loop and turn a
    // lifecycle assertion into a scheduler race.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
    },
    include: ["test/**/*.test.ts"],
    restoreMocks: true,
  },
});
