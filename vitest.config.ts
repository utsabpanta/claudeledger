import { defineConfig } from "vitest/config";

// Force UTC so local-time bucketing (byHour / byWeekday / byDay / activeDays)
// is deterministic across machines and CI. Set before workers fork so each
// worker's V8 reads TZ=UTC at startup.
process.env.TZ = "UTC";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Forked workers inherit the TZ set above.
    pool: "forks",
  },
});
