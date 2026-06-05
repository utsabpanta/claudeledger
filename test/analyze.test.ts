import { describe, it, expect } from "vitest";
import { analyze } from "../src/analyze.js";
import type { RawEvent } from "../src/types.js";
import { makeSession } from "./helpers.js";

const GEN = "2026-06-04T00:00:00.000Z";
const opts = { generatedAt: GEN };

// Convenience builders for assistant events.
function assistant(
  ts: string,
  model: string,
  usage: Record<string, number>,
  tools: Array<{ name: string; file?: string }> = [],
): RawEvent {
  const content = tools.map((t) => ({
    type: "tool_use",
    name: t.name,
    input: t.file ? { file_path: t.file } : {},
  }));
  return { type: "assistant", timestamp: ts, message: { model, usage, content } };
}

function user(ts: string): RawEvent {
  return { type: "user", timestamp: ts, message: { content: "hi" } };
}

describe("analyze — known-answer fixture", () => {
  // One session: 1 user + 2 assistant (opus then haiku), 4 tool calls,
  // /a/b.ts edited twice, /a/c.ts read once. All on 2026-01-15 (a Thursday).
  const stats = analyze(
    [
      makeSession([
        user("2026-01-15T10:00:00.000Z"),
        assistant(
          "2026-01-15T10:00:05.000Z",
          "claude-opus-4-8",
          {
            input_tokens: 1000,
            output_tokens: 500,
            cache_read_input_tokens: 200,
            cache_creation_input_tokens: 100,
          },
          [{ name: "Bash" }, { name: "Write", file: "/a/b.ts" }, { name: "Edit", file: "/a/b.ts" }],
        ),
        assistant(
          "2026-01-15T10:30:00.000Z",
          "claude-haiku-4-5",
          { input_tokens: 100, output_tokens: 50 },
          [{ name: "Read", file: "/a/c.ts" }],
        ),
      ]),
    ],
    opts,
  );

  it("counts sessions, projects, and messages", () => {
    expect(stats.totals.sessions).toBe(1);
    expect(stats.totals.projects).toBe(1);
    expect(stats.totals.messages).toBe(3);
  });

  it("splits token totals four ways", () => {
    expect(stats.totals.tokens).toEqual({
      input: 1100,
      output: 550,
      cacheRead: 200,
      cacheCreation: 100,
    });
  });

  it("computes cost from the pricing map", () => {
    // opus: (1000*5 + 500*25 + 200*0.5 + 100*6.25)/1e6 = 0.018225
    // haiku: (100*1 + 50*5)/1e6                          = 0.00035
    // total 0.018575 -> round2 0.02
    expect(stats.totals.costUSD).toBe(0.02);
    expect(stats.totals.unpricedModels).toEqual([]);
  });

  it("ranks tools and files by frequency", () => {
    expect(stats.topTools).toEqual([
      { name: "Bash", count: 1 },
      { name: "Edit", count: 1 },
      { name: "Read", count: 1 },
      { name: "Write", count: 1 },
    ]);
    expect(stats.topFiles).toEqual([
      { path: "/a/b.ts", edits: 2 },
      { path: "/a/c.ts", edits: 1 },
    ]);
  });

  it("buckets time in UTC (forced via vitest config)", () => {
    expect(stats.totals.activeDays).toBe(1);
    expect(stats.byHour[10]).toBe(3);
    expect(stats.byHour.reduce((a, b) => a + b, 0)).toBe(3);
    expect(stats.byWeekday[4]).toBe(3); // 2026-01-15 is a Thursday
    expect(stats.byDay).toEqual([{ date: "2026-01-15", tokens: 1950, costUSD: 0.02 }]);
  });

  it("reports model mix and session duration", () => {
    expect(stats.modelMix).toEqual([
      { model: "claude-opus-4-8", tokens: 1800 },
      { model: "claude-haiku-4-5", tokens: 150 },
    ]);
    expect(stats.sessionDurations).toEqual({ medianMin: 30, p90Min: 30, longestMin: 30 });
  });

  it("aggregates per project", () => {
    expect(stats.perProject).toEqual([
      { name: "proj", sessions: 1, tokens: 1950, costUSD: 0.02 },
    ]);
  });
});

describe("analyze — unpriced models", () => {
  it("nulls cost when an unknown model carries tokens", () => {
    const stats = analyze(
      [makeSession([assistant("2026-01-01T00:00:00.000Z", "future-model-x", { input_tokens: 1000 })])],
      opts,
    );
    expect(stats.totals.costUSD).toBeNull();
    expect(stats.totals.unpricedModels).toEqual(["future-model-x"]);
    expect(stats.totals.tokens.input).toBe(1000); // tokens still counted
  });

  it("ignores zero-token unknown models (e.g. <synthetic>)", () => {
    const stats = analyze(
      [
        makeSession([
          assistant("2026-01-01T00:00:00.000Z", "claude-opus-4-8", { input_tokens: 1000 }),
          assistant("2026-01-01T00:01:00.000Z", "<synthetic>", {
            input_tokens: 0,
            output_tokens: 0,
          }),
        ]),
      ],
      opts,
    );
    expect(stats.totals.unpricedModels).toEqual([]);
    expect(stats.totals.costUSD).toBe(0.01); // opus 1000*5/1e6 = 0.005 -> 0.01
  });
});

describe("analyze — subagent attribution", () => {
  it("counts subagent tokens but excludes them from session count & duration", () => {
    const stats = analyze(
      [
        makeSession([
          user("2026-03-01T09:00:00.000Z"),
          assistant("2026-03-01T09:10:00.000Z", "claude-opus-4-8", { input_tokens: 1000 }),
        ]),
        makeSession(
          [assistant("2026-03-01T09:05:00.000Z", "claude-opus-4-8", { input_tokens: 500 })],
          { isSubagent: true, sessionId: "agent-1" },
        ),
      ],
      opts,
    );
    expect(stats.totals.sessions).toBe(1); // subagent file excluded
    expect(stats.totals.tokens.input).toBe(1500); // both counted
    expect(stats.sessionDurations.longestMin).toBe(10); // only top-level session
    expect(stats.perProject[0]?.tokens).toBe(1500);
  });
});

describe("analyze — multi-day attribution", () => {
  it("attributes each event to its own local day", () => {
    const stats = analyze(
      [
        makeSession([
          assistant("2026-04-01T23:30:00.000Z", "claude-opus-4-8", { input_tokens: 1000 }),
          assistant("2026-04-02T00:30:00.000Z", "claude-opus-4-8", { input_tokens: 500 }),
        ]),
      ],
      opts,
    );
    expect(stats.totals.activeDays).toBe(2);
    expect(stats.byDay.map((d) => d.date)).toEqual(["2026-04-01", "2026-04-02"]);
    expect(stats.byDay.map((d) => d.tokens)).toEqual([1000, 500]);
  });
});

describe("analyze — empty input", () => {
  it("produces a zeroed but well-formed Stats", () => {
    const stats = analyze([], opts);
    expect(stats.totals.sessions).toBe(0);
    expect(stats.totals.costUSD).toBe(0);
    expect(stats.byHour).toHaveLength(24);
    expect(stats.byWeekday).toHaveLength(7);
    expect(stats.byDay).toEqual([]);
    expect(stats.sessionDurations).toEqual({ medianMin: 0, p90Min: 0, longestMin: 0 });
    expect(stats.generatedAt).toBe(GEN);
  });
});
