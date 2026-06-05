import { describe, it, expect } from "vitest";
import {
  parseDateBound,
  sinceMs,
  untilMs,
  filterByDate,
} from "../src/util/dates.js";
import type { RawEvent } from "../src/types.js";
import { makeSession } from "./helpers.js";

const REF = new Date("2026-01-15T12:00:00.000Z");

describe("parseDateBound", () => {
  it("parses an ISO calendar date and flags it as time-less", () => {
    const b = parseDateBound("2026-01-10", REF);
    expect(b).not.toBeNull();
    expect(b?.hadTime).toBe(false);
    // A date-only --since floors to the start of that local day.
    expect(new Date(sinceMs(b!)).toISOString()).toBe("2026-01-10T00:00:00.000Z");
  });

  it("parses relative natural language against the ref date", () => {
    const b = parseDateBound("7 days ago", REF);
    expect(b?.date.toISOString().slice(0, 10)).toBe("2026-01-08");
  });

  it("returns null for unparseable input", () => {
    expect(parseDateBound("not a date", REF)).toBeNull();
  });
});

describe("since/until bounds", () => {
  it("extends a date-only --until to the end of the local day", () => {
    const b = parseDateBound("2026-01-10", REF);
    expect(b).not.toBeNull();
    // UTC is forced in vitest config, so end-of-day is 23:59:59.999Z.
    expect(new Date(untilMs(b!)).toISOString()).toBe("2026-01-10T23:59:59.999Z");
    expect(new Date(sinceMs(b!)).toISOString()).toBe("2026-01-10T00:00:00.000Z");
  });
});

describe("filterByDate", () => {
  const ev = (ts?: string): RawEvent => ({ type: "user", timestamp: ts, message: {} });
  const sessions = [
    makeSession([ev("2026-01-01T00:00:00.000Z"), ev("2026-01-10T00:00:00.000Z")]),
    makeSession([ev("2026-02-01T00:00:00.000Z")]),
  ];

  it("returns the input untouched when no bounds are given", () => {
    expect(filterByDate(sessions)).toBe(sessions);
  });

  it("keeps only events within [since, until] and drops empty sessions", () => {
    const since = Date.parse("2026-01-05T00:00:00.000Z");
    const until = Date.parse("2026-01-31T23:59:59.999Z");
    const out = filterByDate(sessions, since, until);
    expect(out).toHaveLength(1);
    expect(out[0]?.events).toHaveLength(1);
    expect(out[0]?.events[0]?.timestamp).toBe("2026-01-10T00:00:00.000Z");
  });

  it("drops events with no usable timestamp when a bound is active", () => {
    const out = filterByDate(
      [makeSession([ev(undefined), ev("2026-01-10T00:00:00.000Z")])],
      Date.parse("2026-01-01T00:00:00.000Z"),
    );
    expect(out[0]?.events).toHaveLength(1);
  });
});
