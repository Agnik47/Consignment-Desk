import { defineConfig } from "vitest/config";

// Real testnet calls — costs real (test) ALGO/USDC from the dispenser and
// takes several seconds per test. Not run by default `npm test`; run
// explicitly with `npm run test:integration`. Per AGENTS.md Rule 2, this
// suite must never mock chain calls — that's what the unit suite is for.
export default defineConfig({
  test: {
    include: ["**/*.integration.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
