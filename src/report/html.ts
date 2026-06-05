/**
 * Render {@link Stats} as a single self-contained HTML document.
 *
 * Everything is inlined — CSS in a <style> tag and charts as hand-drawn SVG.
 * There are NO external assets, NO <script>, and NO network references, so the
 * file opens fully offline (and stays private) when double-clicked. Charts use
 * native SVG <title> elements for hover tooltips, which need no JavaScript.
 */

import type { Stats } from "../types.js";

// A small, cohesive palette (used for model-mix segments and accents).
const PALETTE = [
  "#6366f1", // indigo
  "#06b6d4", // cyan
  "#f59e0b", // amber
  "#ec4899", // pink
  "#10b981", // emerald
  "#8b5cf6", // violet
  "#ef4444", // red
  "#14b8a6", // teal
];
const ACCENT = "#6366f1";
const GRID = "#e5e7eb";
const INK = "#111827";
const MUTED = "#6b7280";

/** Build the complete HTML document as a string. */
export function renderHtml(stats: Stats): string {
  const { totals } = stats;

  const warning =
    totals.unpricedModels.length > 0
      ? `<div class="warn">⚠ Cost is incomplete — no price for ${escapeHtml(
          totals.unpricedModels.join(", "),
        )}. Add them to <code>src/pricing.ts</code>; tokens are still counted.</div>`
      : "";

  const kpis = [
    kpi("Sessions", fmtInt(totals.sessions)),
    kpi("Projects", fmtInt(totals.projects)),
    kpi("Messages", fmtInt(totals.messages)),
    kpi("Active days", fmtInt(totals.activeDays)),
    kpi("Total tokens", fmtCompact(totalTokens(stats))),
    kpi("Total cost", totals.costUSD === null ? "unknown" : `$${totals.costUSD.toFixed(2)}`),
  ].join("");

  const rangeStr = formatRange(stats.range);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>claudestats report</title>
<style>${CSS}</style>
</head>
<body>
<main>
  <header>
    <h1>claudestats</h1>
    <p class="sub">Local-first analytics for your Claude Code sessions — generated offline, nothing sent anywhere.</p>
    <p class="meta">generated ${escapeHtml(stats.generatedAt)}${rangeStr ? ` · ${escapeHtml(rangeStr)}` : ""}</p>
  </header>
  ${warning}

  <section class="kpis">${kpis}</section>

  <section class="card">
    <h2>Tokens per day</h2>
    ${lineChart(stats.byDay)}
  </section>

  <div class="grid2">
    <section class="card">
      <h2>Token totals</h2>
      ${tokenBreakdown(stats)}
    </section>
    <section class="card">
      <h2>Model mix</h2>
      ${donut(stats)}
    </section>
  </div>

  <div class="grid2">
    <section class="card">
      <h2>Activity by hour <span class="dim">(local time)</span></h2>
      ${barChart(stats.byHour, (i) => String(i), "hour of day")}
    </section>
    <section class="card">
      <h2>Activity by weekday <span class="dim">(local time)</span></h2>
      ${barChart(stats.byWeekday, (i) => WEEKDAYS[i] ?? String(i), "weekday")}
    </section>
  </div>

  <div class="grid2">
    <section class="card">
      <h2>Top tools</h2>
      ${hBars(stats.topTools.map((t) => ({ label: t.name, value: t.count })), "calls")}
    </section>
    <section class="card">
      <h2>Top files</h2>
      ${hBars(
        stats.topFiles.map((f) => ({ label: shorten(f.path, 48), value: f.edits, full: f.path })),
        "edits",
      )}
    </section>
  </div>

  <section class="card">
    <h2>By project</h2>
    ${projectTable(stats)}
  </section>

  <section class="card">
    <h2>Session length</h2>
    <p class="dim">median ${fmtMin(stats.sessionDurations.medianMin)} ·
       p90 ${fmtMin(stats.sessionDurations.p90Min)} ·
       longest ${fmtMin(stats.sessionDurations.longestMin)}</p>
  </section>

  <footer>Reads <code>~/.claude</code> locally · makes no network calls · MIT licensed</footer>
</main>
</body>
</html>
`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function kpi(label: string, value: string): string {
  return `<div class="kpi"><div class="kpi-val">${escapeHtml(value)}</div><div class="kpi-label">${escapeHtml(
    label,
  )}</div></div>`;
}

function tokenBreakdown(stats: Stats): string {
  const t = stats.totals.tokens;
  const rows: Array<[string, number]> = [
    ["Input", t.input],
    ["Output", t.output],
    ["Cache read", t.cacheRead],
    ["Cache write", t.cacheCreation],
  ];
  return hBars(rows.map(([label, value]) => ({ label, value })), "tokens");
}

function projectTable(stats: Stats): string {
  if (stats.perProject.length === 0) return `<p class="dim">No projects.</p>`;
  const rows = stats.perProject
    .map(
      (p) =>
        `<tr><td>${escapeHtml(p.name)}</td><td class="num">${fmtInt(p.sessions)}</td>` +
        `<td class="num">${fmtInt(p.tokens)}</td>` +
        `<td class="num">${p.costUSD === null ? "—" : "$" + p.costUSD.toFixed(2)}</td></tr>`,
    )
    .join("");
  return `<table><thead><tr><th>Project</th><th class="num">Sessions</th><th class="num">Tokens</th><th class="num">Cost</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/* ---------------------------------------------------------------- SVG charts */

/** Per-day token line chart with a soft area fill. */
function lineChart(byDay: Stats["byDay"]): string {
  const W = 880;
  const H = 240;
  const pad = { l: 56, r: 16, t: 16, b: 28 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;

  if (byDay.length === 0) {
    return emptyChart(W, H, "No dated activity.");
  }

  const values = byDay.map((d) => d.tokens);
  const max = Math.max(...values, 1);
  const n = byDay.length;
  const x = (i: number): number => (n === 1 ? pad.l + plotW / 2 : pad.l + (i / (n - 1)) * plotW);
  const y = (v: number): number => pad.t + plotH - (v / max) * plotH;

  const pts = byDay.map((d, i) => `${x(i).toFixed(1)},${y(d.tokens).toFixed(1)}`);
  const linePath = `M ${pts.join(" L ")}`;
  const areaPath = `M ${x(0).toFixed(1)},${(pad.t + plotH).toFixed(1)} L ${pts.join(" L ")} L ${x(
    n - 1,
  ).toFixed(1)},${(pad.t + plotH).toFixed(1)} Z`;

  // Horizontal gridlines + y labels at 0, 50%, 100%.
  const grid = [0, 0.5, 1]
    .map((frac) => {
      const gy = pad.t + plotH - frac * plotH;
      const label = fmtCompact(Math.round(max * frac));
      return (
        `<line x1="${pad.l}" y1="${gy.toFixed(1)}" x2="${W - pad.r}" y2="${gy.toFixed(1)}" stroke="${GRID}"/>` +
        `<text x="${pad.l - 8}" y="${(gy + 4).toFixed(1)}" text-anchor="end" class="axis">${label}</text>`
      );
    })
    .join("");

  // Dots with tooltips.
  const dots = byDay
    .map((d, i) => {
      const cx = x(i).toFixed(1);
      const cy = y(d.tokens).toFixed(1);
      const cost = d.costUSD === null ? "unknown" : `$${d.costUSD.toFixed(2)}`;
      return `<circle cx="${cx}" cy="${cy}" r="2.6" fill="${ACCENT}"><title>${escapeHtml(
        d.date,
      )}: ${fmtInt(d.tokens)} tokens · ${escapeHtml(cost)}</title></circle>`;
    })
    .join("");

  const first = byDay[0]?.date ?? "";
  const last = byDay[byDay.length - 1]?.date ?? "";

  return svg(
    W,
    H,
    `${grid}
     <path d="${areaPath}" fill="${ACCENT}" fill-opacity="0.12"/>
     <path d="${linePath}" fill="none" stroke="${ACCENT}" stroke-width="2" stroke-linejoin="round"/>
     ${dots}
     <text x="${pad.l}" y="${H - 8}" class="axis">${escapeHtml(first)}</text>
     <text x="${W - pad.r}" y="${H - 8}" text-anchor="end" class="axis">${escapeHtml(last)}</text>`,
  );
}

/** Vertical bar chart for fixed-length series (byHour / byWeekday). */
function barChart(values: number[], labelOf: (i: number) => string, unit: string): string {
  const W = 430;
  const H = 200;
  const pad = { l: 28, r: 8, t: 12, b: 24 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const max = Math.max(...values, 1);
  const n = values.length;
  const slot = plotW / n;
  const barW = slot * 0.7;

  const bars = values
    .map((v, i) => {
      const h = (v / max) * plotH;
      const bx = pad.l + i * slot + (slot - barW) / 2;
      const by = pad.t + plotH - h;
      const showLabel = n <= 7 || i % 3 === 0; // avoid crowding 24 hour labels
      const label = showLabel
        ? `<text x="${(bx + barW / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="axis">${escapeHtml(
            labelOf(i),
          )}</text>`
        : "";
      return (
        `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(
          0,
          h,
        ).toFixed(1)}" rx="2" fill="${ACCENT}" fill-opacity="0.85">` +
        `<title>${escapeHtml(labelOf(i))} (${escapeHtml(unit)}): ${fmtInt(v)}</title></rect>${label}`
      );
    })
    .join("");

  const baseline = `<line x1="${pad.l}" y1="${pad.t + plotH}" x2="${W - pad.r}" y2="${
    pad.t + plotH
  }" stroke="${GRID}"/>`;
  return svg(W, H, baseline + bars);
}

/** Horizontal bars for ranked rows (top tools/files, token breakdown). */
function hBars(
  rows: Array<{ label: string; value: number; full?: string }>,
  unit: string,
): string {
  if (rows.length === 0) return `<p class="dim">Nothing to show.</p>`;
  const W = 430;
  const rowH = 26;
  const labelW = 150;
  const valueW = 64;
  const barAreaW = W - labelW - valueW;
  const H = rows.length * rowH + 8;
  const max = Math.max(...rows.map((r) => r.value), 1);

  const bars = rows
    .map((r, i) => {
      const y = i * rowH + 4;
      const w = (r.value / max) * barAreaW;
      const title = r.full ?? r.label;
      return (
        `<text x="0" y="${y + rowH / 2 + 4}" class="hbar-label">${escapeHtml(r.label)}</text>` +
        `<rect x="${labelW}" y="${y + 3}" width="${Math.max(1, w).toFixed(1)}" height="${rowH - 10}" rx="3" fill="${ACCENT}" fill-opacity="0.85">` +
        `<title>${escapeHtml(title)} (${escapeHtml(unit)}): ${fmtInt(r.value)}</title></rect>` +
        `<text x="${W}" y="${y + rowH / 2 + 4}" text-anchor="end" class="hbar-val">${fmtCompact(
          r.value,
        )}</text>`
      );
    })
    .join("");
  return svg(W, H, bars);
}

/** Donut chart of model token share, with a legend. */
function donut(stats: Stats): string {
  const segments = stats.modelMix.filter((m) => m.tokens > 0);
  const total = segments.reduce((s, m) => s + m.tokens, 0);
  if (total === 0) return `<p class="dim">No token usage to chart.</p>`;

  const size = 180;
  const r = 70;
  const cx = size / 2;
  const cy = size / 2;
  const C = 2 * Math.PI * r;
  const stroke = 26;

  let offset = 0;
  const arcs = segments
    .map((m, i) => {
      const frac = m.tokens / total;
      const len = frac * C;
      const color = PALETTE[i % PALETTE.length] ?? ACCENT;
      const pct = (frac * 100).toFixed(1);
      const arc =
        `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}" ` +
        `stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(
          2,
        )}" transform="rotate(-90 ${cx} ${cy})">` +
        `<title>${escapeHtml(m.model)}: ${fmtInt(m.tokens)} tokens · ${pct}%</title></circle>`;
      offset += len;
      return arc;
    })
    .join("");

  const legend = segments
    .map((m, i) => {
      const color = PALETTE[i % PALETTE.length] ?? ACCENT;
      const pct = ((m.tokens / total) * 100).toFixed(1);
      return `<li><span class="swatch" style="background:${color}"></span>${escapeHtml(
        m.model,
      )} <span class="dim">${pct}%</span></li>`;
    })
    .join("");

  return `<div class="donut-wrap">${svg(size, size, arcs)}<ul class="legend">${legend}</ul></div>`;
}

function emptyChart(w: number, h: number, msg: string): string {
  return svg(
    w,
    h,
    `<text x="${w / 2}" y="${h / 2}" text-anchor="middle" class="dim-svg">${escapeHtml(msg)}</text>`,
  );
}

function svg(w: number, h: number, inner: string): string {
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img" class="chart">${inner}</svg>`;
}

/* ---------------------------------------------------------------- formatting */

function totalTokens(stats: Stats): number {
  const t = stats.totals.tokens;
  return t.input + t.output + t.cacheRead + t.cacheCreation;
}

function formatRange(range: Stats["range"]): string {
  if (range.since && range.until) return `${range.since} → ${range.until}`;
  if (range.since) return `since ${range.since}`;
  if (range.until) return `until ${range.until}`;
  return "";
}

function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

function fmtMin(min: number): string {
  if (min <= 0) return "0m";
  if (min < 60) return `${Math.round(min)}m`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function shorten(s: string, max: number): string {
  if (s.length <= max) return s;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return s.slice(0, head) + "…" + s.slice(s.length - tail);
}

/** Escape text destined for HTML/SVG so paths/model names can't break markup. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 24px;
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: ${INK}; background: #f8fafc;
}
main { max-width: 960px; margin: 0 auto; }
header h1 { margin: 0; font-size: 30px; letter-spacing: -0.02em; }
header .sub { margin: 4px 0 0; color: ${MUTED}; }
header .meta { margin: 2px 0 18px; color: ${MUTED}; font-size: 13px; }
.warn {
  background: #fffbeb; border: 1px solid #fde68a; color: #92400e;
  padding: 10px 14px; border-radius: 10px; margin-bottom: 18px; font-size: 14px;
}
.warn code, footer code, .sub code { background: #00000010; padding: 1px 5px; border-radius: 5px; }
.kpis { display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; margin-bottom: 18px; }
.kpi { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 14px; text-align: center; }
.kpi-val { font-size: 22px; font-weight: 650; letter-spacing: -0.01em; }
.kpi-label { font-size: 12px; color: ${MUTED}; margin-top: 2px; }
.card {
  background: #fff; border: 1px solid #e5e7eb; border-radius: 14px;
  padding: 18px 20px; margin-bottom: 18px;
}
.card h2 { margin: 0 0 12px; font-size: 16px; }
.card h2 .dim { font-weight: 400; color: ${MUTED}; font-size: 13px; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.chart { width: 100%; height: auto; display: block; }
.axis { fill: ${MUTED}; font-size: 11px; }
.hbar-label { fill: ${INK}; font-size: 12px; }
.hbar-val { fill: ${MUTED}; font-size: 12px; }
.dim, .dim-svg { color: ${MUTED}; }
.dim-svg { fill: ${MUTED}; font-size: 13px; }
.donut-wrap { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
.legend { list-style: none; margin: 0; padding: 0; font-size: 13px; }
.legend li { margin: 4px 0; }
.swatch { display: inline-block; width: 11px; height: 11px; border-radius: 3px; margin-right: 7px; vertical-align: -1px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #f1f5f9; }
th { color: ${MUTED}; font-weight: 600; font-size: 12px; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
footer { color: ${MUTED}; font-size: 13px; text-align: center; margin: 8px 0 24px; }
@media (max-width: 720px) {
  .kpis { grid-template-columns: repeat(3, 1fr); }
  .grid2 { grid-template-columns: 1fr; }
}
`;
