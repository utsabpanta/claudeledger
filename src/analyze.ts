/**
 * The analytics core: parsed sessions in, {@link Stats} out.
 *
 * This module is intentionally PURE — no filesystem access, no `Date.now()`,
 * no other ambient state. The "current time" is injected via
 * {@link AnalyzeOptions.generatedAt}. That keeps it trivially unit-testable:
 * feed it known events and assert exact numbers. All IO lives in
 * `discover.ts`/`cli.ts`.
 *
 * Time-of-day, weekday, and per-day buckets use the host's LOCAL timezone,
 * because "when am I productive" is a local-time question. Source timestamps
 * are UTC ISO strings.
 */

import type {
  ParsedSession,
  RawContentBlock,
  RawEvent,
  Stats,
  TokenTotals,
} from "./types.js";
import { cost as priceCost } from "./pricing.js";

export interface AnalyzeOptions {
  /** ISO timestamp to stamp on the report (injected — never read from a clock). */
  generatedAt: string;
  /** The active date filter, echoed into the output for display. */
  range?: { since?: string; until?: string };
  /** How many rows to keep in topTools / topFiles. Default 10. */
  topN?: number;
}

interface ProjectAcc {
  name: string;
  sessions: number; // top-level (non-subagent) files only
  tokens: number;
  cost: number;
  hasUnpriced: boolean;
}

interface DayAcc {
  tokens: number;
  cost: number;
  hasUnpriced: boolean;
}

/** Analyze parsed sessions into the full {@link Stats} object. */
export function analyze(
  sessions: ParsedSession[],
  options: AnalyzeOptions,
): Stats {
  const topN = options.topN ?? 10;

  const tokens: TokenTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
  };
  let messages = 0;
  let totalCost = 0;
  let anyUnpricedWithTokens = false;
  const unpricedModels = new Set<string>();

  const modelTokens = new Map<string, number>();
  const toolCounts = new Map<string, number>();
  const fileCounts = new Map<string, number>();
  const byHour = new Array<number>(24).fill(0);
  const byWeekday = new Array<number>(7).fill(0);
  const byDay = new Map<string, DayAcc>();
  const activeDays = new Set<string>();
  const projects = new Map<string, ProjectAcc>();
  const durationsMin: number[] = [];

  let topLevelSessions = 0;

  for (const session of sessions) {
    // Group by the stable projectDir key, display the (possibly cwd-enriched)
    // project name.
    const project = getProject(projects, session.file.projectDir, session.file.projectName);
    if (!session.file.isSubagent) {
      project.sessions++;
      topLevelSessions++;
    }

    let minTs = Infinity;
    let maxTs = -Infinity;

    for (const ev of session.events) {
      const localDate = localDateParts(ev.timestamp);

      if (localDate) {
        activeDays.add(localDate.day);
        if (ev.type === "user" || ev.type === "assistant") {
          byHour[localDate.hour] = (byHour[localDate.hour] ?? 0) + 1;
          byWeekday[localDate.weekday] = (byWeekday[localDate.weekday] ?? 0) + 1;
        }
      }

      if (ev.type === "user" || ev.type === "assistant") messages++;

      // Track first/last timestamp for session-duration (top-level only).
      if (!session.file.isSubagent && localDate) {
        if (localDate.epochMs < minTs) minTs = localDate.epochMs;
        if (localDate.epochMs > maxTs) maxTs = localDate.epochMs;
      }

      if (ev.type !== "assistant") continue;

      const usage = ev.message?.usage;
      const evTokens = {
        input: numOr0(usage?.input_tokens),
        output: numOr0(usage?.output_tokens),
        cacheRead: numOr0(usage?.cache_read_input_tokens),
        cacheCreation: numOr0(usage?.cache_creation_input_tokens),
      };
      const evTotal =
        evTokens.input +
        evTokens.output +
        evTokens.cacheRead +
        evTokens.cacheCreation;

      tokens.input += evTokens.input;
      tokens.output += evTokens.output;
      tokens.cacheRead += evTokens.cacheRead;
      tokens.cacheCreation += evTokens.cacheCreation;

      const model = typeof ev.message?.model === "string" ? ev.message.model : undefined;
      if (model) {
        modelTokens.set(model, (modelTokens.get(model) ?? 0) + evTotal);
      }

      // Cost. Unknown models count tokens but their cost is "unknown"; we only
      // treat a model as cost-nulling if it actually carries tokens (skips the
      // all-zero `<synthetic>` noise).
      const evCost = model ? priceCost(model, evTokens) : null;
      const unpriced = model !== undefined && evCost === null && evTotal > 0;
      if (unpriced && model) {
        unpricedModels.add(model);
        anyUnpricedWithTokens = true;
        project.hasUnpriced = true;
      } else if (evCost !== null) {
        totalCost += evCost;
        project.cost += evCost;
      }

      project.tokens += evTotal;

      // Per-day token + cost attribution (each event to its own local day).
      if (localDate) {
        const day = getDay(byDay, localDate.day);
        day.tokens += evTotal;
        if (unpriced) day.hasUnpriced = true;
        else if (evCost !== null) day.cost += evCost;
      }

      // Tool calls and file edits from tool_use content blocks.
      const content = ev.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          countToolUse(block, toolCounts, fileCounts);
        }
      }
    }

    if (!session.file.isSubagent && minTs !== Infinity && maxTs > minTs) {
      durationsMin.push((maxTs - minTs) / 60_000);
    }
  }

  const costUSD = anyUnpricedWithTokens ? null : round2(totalCost);

  return {
    generatedAt: options.generatedAt,
    range: { since: options.range?.since, until: options.range?.until },
    totals: {
      sessions: topLevelSessions,
      projects: projects.size,
      messages,
      tokens,
      costUSD,
      unpricedModels: [...unpricedModels].sort(),
      activeDays: activeDays.size,
    },
    perProject: [...projects.values()]
      .map((p) => ({
        name: p.name,
        sessions: p.sessions,
        tokens: p.tokens,
        costUSD: p.hasUnpriced ? null : round2(p.cost),
      }))
      .sort((a, b) => b.tokens - a.tokens),
    topTools: topEntries(toolCounts, topN).map(([name, count]) => ({ name, count })),
    topFiles: topEntries(fileCounts, topN).map(([path, edits]) => ({ path, edits })),
    byHour,
    byWeekday,
    byDay: [...byDay.entries()]
      .map(([date, acc]) => ({
        date,
        tokens: acc.tokens,
        costUSD: acc.hasUnpriced ? null : round2(acc.cost),
      }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
    sessionDurations: durationStats(durationsMin),
    modelMix: [...modelTokens.entries()]
      .map(([model, t]) => ({ model, tokens: t }))
      .sort((a, b) => b.tokens - a.tokens),
  };
}

function countToolUse(
  block: RawContentBlock,
  toolCounts: Map<string, number>,
  fileCounts: Map<string, number>,
): void {
  if (block.type !== "tool_use") return;
  const name = typeof block.name === "string" ? block.name : "<unknown>";
  toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);

  // Detect a file operation by the SHAPE of its input (presence of a
  // file_path/path), not by the tool name — names vary across versions.
  const input = block.input;
  if (input && typeof input === "object") {
    const fp = input["file_path"] ?? input["path"];
    if (typeof fp === "string" && fp !== "") {
      fileCounts.set(fp, (fileCounts.get(fp) ?? 0) + 1);
    }
  }
}

function getProject(
  map: Map<string, ProjectAcc>,
  key: string,
  name: string,
): ProjectAcc {
  let acc = map.get(key);
  if (!acc) {
    acc = { name, sessions: 0, tokens: 0, cost: 0, hasUnpriced: false };
    map.set(key, acc);
  }
  return acc;
}

function getDay(map: Map<string, DayAcc>, day: string): DayAcc {
  let acc = map.get(day);
  if (!acc) {
    acc = { tokens: 0, cost: 0, hasUnpriced: false };
    map.set(day, acc);
  }
  return acc;
}

interface LocalDateParts {
  day: string; // local YYYY-MM-DD
  hour: number; // 0–23 local
  weekday: number; // 0 (Sun) – 6 (Sat) local
  epochMs: number;
}

/** Parse an ISO timestamp into local-time parts, or null if unparseable. */
function localDateParts(ts: unknown): LocalDateParts | null {
  if (typeof ts !== "string") return null;
  const d = new Date(ts);
  const epochMs = d.getTime();
  if (Number.isNaN(epochMs)) return null;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return {
    day: `${yyyy}-${mm}-${dd}`,
    hour: d.getHours(),
    weekday: d.getDay(),
    epochMs,
  };
}

function durationStats(minutes: number[]): Stats["sessionDurations"] {
  if (minutes.length === 0) {
    return { medianMin: 0, p90Min: 0, longestMin: 0 };
  }
  const sorted = [...minutes].sort((a, b) => a - b);
  return {
    medianMin: round2(percentile(sorted, 0.5)),
    p90Min: round2(percentile(sorted, 0.9)),
    longestMin: round2(sorted[sorted.length - 1] ?? 0),
  };
}

/** Linear-interpolated percentile of a pre-sorted ascending array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0] ?? 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const loVal = sorted[lo] ?? 0;
  const hiVal = sorted[hi] ?? 0;
  if (lo === hi) return loVal;
  return loVal + (hiVal - loVal) * (idx - lo);
}

function topEntries(
  map: Map<string, number>,
  n: number,
): Array<[string, number]> {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, n);
}

function numOr0(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
