import { defineConfig } from "vitest/config";

// Real testnet calls — costs real (test) ALGO/USDC from the dispenser and
// takes several seconds per test. Not run by default `npm test`; run
// explicitly with `npm run test:integration`. Per AGENTS.md Rule 2, this
// suite must never mock chain calls — that's what the unit suite is for.
export default defineConfig({
  test: {
    include: ["**/*.integration.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    // Generous because these are real chain round trips, not slow code: the
    // full three-agent demo cast alone is ~40s (3 fundings + 3 paid entries +
    // 2 paid hint purchases, each waiting on Algorand's ~3s finality).
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
