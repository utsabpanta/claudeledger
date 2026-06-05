/**
 * Date handling for the `--since` / `--until` filters.
 *
 * Parsing (which needs "now") lives here behind {@link parseDateBound} so the
 * caller injects the reference date — keeping things testable. The actual
 * filtering ({@link filterByDate}) is pure: it takes millisecond bounds and
 * returns a new session list.
 */

import * as chrono from "chrono-node";
import type { ParsedSession } from "../types.js";

export interface DateBound {
  /** The resolved instant. */
  date: Date;
  /** Whether the input specified a time-of-day (vs. just a calendar date). */
  hadTime: boolean;
}

/**
 * Parse a `--since`/`--until` value. Accepts ISO dates and simple natural
 * language ("7 days ago", "last monday", "2026-01-01"). Returns null if the
 * input can't be understood, so the CLI can report a clear error.
 *
 * @param ref the reference "now" for relative expressions (injected).
 */
export function parseDateBound(input: string, ref: Date): DateBound | null {
  const results = chrono.parse(input, ref);
  const first = results[0];
  if (!first) return null;
  return {
    date: first.start.date(),
    hadTime: first.start.isCertain("hour"),
  };
}

/**
 * Resolve a `--since` value to an inclusive lower-bound in epoch ms.
 * A bare calendar date (no time given) means "from the START of that local
 * day" — chrono otherwise fills the time from the reference clock, which would
 * silently drop that morning's events.
 */
export function sinceMs(bound: DateBound): number {
  if (bound.hadTime) return bound.date.getTime();
  const d = bound.date;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
}

/**
 * Resolve a `--until` value to an inclusive upper-bound in epoch ms.
 * A bare calendar date (no time given) extends to the END of that local day,
 * which is what users expect from `--until 2026-01-15`.
 */
export function untilMs(bound: DateBound): number {
  if (bound.hadTime) return bound.date.getTime();
  const d = bound.date;
  const endOfDay = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    23,
    59,
    59,
    999,
  );
  return endOfDay.getTime();
}

/**
 * Keep only events whose timestamp falls within `[since, until]` (either bound
 * optional). Events without a usable timestamp are dropped when any bound is
 * active. Sessions left with no events are removed entirely.
 *
 * Pure — no clock access.
 */
export function filterByDate(
  sessions: ParsedSession[],
  since?: number,
  until?: number,
): ParsedSession[] {
  if (since === undefined && until === undefined) return sessions;

  const out: ParsedSession[] = [];
  for (const session of sessions) {
    const events = session.events.filter((ev) => {
      const ts = typeof ev.timestamp === "string" ? Date.parse(ev.timestamp) : NaN;
      if (Number.isNaN(ts)) return false;
      if (since !== undefined && ts < since) return false;
      if (until !== undefined && ts > until) return false;
      return true;
    });
    if (events.length > 0) {
      out.push({ ...session, events });
    }
  }
  return out;
}
