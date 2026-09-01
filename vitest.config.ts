import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/e2e/**/*.e2e.test.ts"],
    // E2E suites drive real sockets/timers (pong-timeout ~20s) — keep generous defaults.
    testTimeout: 40_000,
    hookTimeout: 20_000,
  },
});
