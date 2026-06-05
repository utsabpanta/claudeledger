/**
 * Render {@link Stats} as a terminal summary: headline numbers, top tools/files,
 * per-project rollup, a per-day token sparkline, and session-duration spread.
 */

import Table from "cli-table3";
import pc from "picocolors";
import type { Stats } from "../types.js";

const SPARK_TICKS = "▁▂▃▄▅▆▇█";

/** Build the full terminal report as a string (caller writes it to stdout). */
export function renderTerminal(stats: Stats): string {
  const out: string[] = [];
  const { totals } = stats;

  out.push(
    pc.bold(pc.cyan("ccstats")) +
      pc.dim(`  ·  ${totals.sessions} sessions · ${totals.projects} projects · ${totals.activeDays} active days`),
  );
  const rangeStr = formatRange(stats.range);
  if (rangeStr) out.push(pc.dim(`  range: ${rangeStr}`));
  out.push("");

  if (totals.unpricedModels.length > 0) {
    out.push(
      pc.yellow(
        `⚠ Cost is incomplete — no price for: ${totals.unpricedModels.join(", ")}.\n` +
          `  Add these to src/pricing.ts. Tokens are still counted.`,
      ),
    );
    out.push("");
  }

  // Headline totals.
  const totalsTable = new Table({ style: { head: [], border: [] } });
  totalsTable.push(
    [pc.bold("Messages"), fmtInt(totals.messages)],
    [pc.bold("Input tokens"), fmtInt(totals.tokens.input)],
    [pc.bold("Output tokens"), fmtInt(totals.tokens.output)],
    [pc.bold("Cache read"), fmtInt(totals.tokens.cacheRead)],
    [pc.bold("Cache write"), fmtInt(totals.tokens.cacheCreation)],
    [pc.bold("Total cost"), fmtCost(totals.costUSD)],
  );
  out.push(totalsTable.toString());

  // Session durations.
  out.push(
    pc.dim(
      `session length — median ${fmtMin(stats.sessionDurations.medianMin)}, ` +
        `p90 ${fmtMin(stats.sessionDurations.p90Min)}, ` +
        `longest ${fmtMin(stats.sessionDurations.longestMin)}`,
    ),
  );
  out.push("");

  // Top tools & top files, side by side conceptually but stacked for width safety.
  if (stats.topTools.length > 0) {
    out.push(pc.bold("Top tools"));
    const t = new Table({
      head: [pc.dim("tool"), pc.dim("calls")],
      colAligns: ["left", "right"],
      style: { head: [], border: [] },
    });
    for (const row of stats.topTools) t.push([row.name, fmtInt(row.count)]);
    out.push(t.toString());
  }

  if (stats.topFiles.length > 0) {
    out.push(pc.bold("Top files"));
    const t = new Table({
      head: [pc.dim("file"), pc.dim("edits")],
      colAligns: ["left", "right"],
      style: { head: [], border: [] },
    });
    for (const row of stats.topFiles) t.push([shorten(row.path, 60), fmtInt(row.edits)]);
    out.push(t.toString());
  }

  // Per-project rollup.
  if (stats.perProject.length > 0) {
    out.push(pc.bold("By project"));
    const t = new Table({
      head: [pc.dim("project"), pc.dim("sessions"), pc.dim("tokens"), pc.dim("cost")],
      colAligns: ["left", "right", "right", "right"],
      style: { head: [], border: [] },
    });
    for (const p of stats.perProject) {
      t.push([shorten(p.name, 40), fmtInt(p.sessions), fmtInt(p.tokens), fmtCost(p.costUSD)]);
    }
    out.push(t.toString());
  }

  // Per-day token sparkline.
  if (stats.byDay.length > 0) {
    out.push("");
    out.push(pc.bold("Tokens per day"));
    const tokensSeries = stats.byDay.map((d) => d.tokens);
    out.push("  " + pc.green(sparkline(tokensSeries)));
    const first = stats.byDay[0];
    const last = stats.byDay[stats.byDay.length - 1];
    if (first && last) {
      out.push(pc.dim(`  ${first.date} → ${last.date} (${stats.byDay.length} days)`));
    }
  }

  // Model mix.
  if (stats.modelMix.length > 0) {
    out.push("");
    out.push(pc.bold("Model mix"));
    const totalModelTokens = stats.modelMix.reduce((s, m) => s + m.tokens, 0) || 1;
    for (const m of stats.modelMix) {
      const pct = ((m.tokens / totalModelTokens) * 100).toFixed(1);
      out.push(`  ${m.model.padEnd(28)} ${fmtInt(m.tokens).padStart(14)}  ${pc.dim(`${pct}%`)}`);
    }
  }

  out.push("");
  out.push(pc.dim(`generated ${stats.generatedAt} · reads ~/.claude locally · sends nothing`));
  return out.join("\n") + "\n";
}

function formatRange(range: Stats["range"]): string {
  if (range.since && range.until) return `${range.since} → ${range.until}`;
  if (range.since) return `since ${range.since}`;
  if (range.until) return `until ${range.until}`;
  return "";
}

function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const max = Math.max(...values, 1);
  return values
    .map((v) => {
      const idx = Math.min(
        SPARK_TICKS.length - 1,
        Math.floor((v / max) * (SPARK_TICKS.length - 1)),
      );
      return SPARK_TICKS[idx];
    })
    .join("");
}

function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtCost(n: number | null): string {
  if (n === null) return pc.dim("unknown");
  return `$${n.toFixed(2)}`;
}

function fmtMin(min: number): string {
  if (min <= 0) return "0m";
  if (min < 60) return `${Math.round(min)}m`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Truncate the MIDDLE of a long path so both ends stay visible. */
function shorten(s: string, max: number): string {
  if (s.length <= max) return s;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return s.slice(0, head) + "…" + s.slice(s.length - tail);
}
