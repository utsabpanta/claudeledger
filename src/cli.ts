/**
 * claudeledger CLI entry point: argument parsing, orchestration, and exit codes.
 *
 * Phase 1 wires up discovery + parsing + `--dump-schema`/`--verbose`. The
 * default summary command and report flags are added in later phases.
 */

import { discoverSessions, enrichProjectsFromCwd } from "./discover.js";
import { parseSessions } from "./parse.js";
import { analyze } from "./analyze.js";
import { renderTerminal } from "./report/terminal.js";
import { renderHtml } from "./report/html.js";
import { filterByDate, parseDateBound, sinceMs, untilMs } from "./util/dates.js";
import { openInBrowser } from "./util/open.js";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RawEvent, SessionFile } from "./types.js";

const VERSION = "0.1.0";

interface CliOptions {
  root?: string;
  project?: string;
  since?: string;
  until?: string;
  top: number;
  html: boolean;
  out?: string;
  json: boolean;
  verbose: boolean;
  dumpSchema: boolean;
  help: boolean;
  version: boolean;
}

/** Minimal hand-rolled flag parser — no framework, per the build spec. */
function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    top: 10,
    html: false,
    json: false,
    verbose: false,
    dumpSchema: false,
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) {
        fail(`Missing value for ${arg}`);
      }
      return v;
    };
    switch (arg) {
      case "--root":
        opts.root = next();
        break;
      case "--project":
        opts.project = next();
        break;
      case "--since":
        opts.since = next();
        break;
      case "--until":
        opts.until = next();
        break;
      case "--top":
        opts.top = parsePositiveInt(next(), arg);
        break;
      case "--html":
        opts.html = true;
        break;
      case "--out":
        opts.out = next();
        break;
      case "--json":
        opts.json = true;
        break;
      case "--verbose":
      case "-v":
        opts.verbose = true;
        break;
      case "--dump-schema":
        opts.dumpSchema = true;
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
      case "--version":
      case "-V":
        opts.version = true;
        break;
      default:
        fail(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

function parsePositiveInt(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    fail(`${flag} expects a positive integer, got "${value}"`);
  }
  return n;
}

function fail(message: string): never {
  process.stderr.write(`claudeledger: ${message}\n`);
  process.stderr.write(`Run \`claudeledger --help\` for usage.\n`);
  process.exit(2);
}

const HELP = `claudeledger — local-first analytics for your Claude Code session logs

USAGE
  claudeledger [options]

OPTIONS
  --project <name>     Filter to projects whose path contains <name>
  --since <date>       Only include events on/after <date> (ISO or "7 days ago")
  --until <date>       Only include events on/before <date>
  --top <n>            Rows in "top files"/"top tools" tables (default 10)
  --html               Write a self-contained report.html and open it
  --out <path>         Output path for --html (default ./report.html)
  --json               Emit machine-readable JSON stats to stdout
  --root <path>        Override the ~/.claude directory
  --verbose, -v        Show skipped-line counts, timing, and parse warnings
  --dump-schema        Print observed event types + keys, then exit (dev aid)
  --version, -V        Print version and exit
  --help, -h           Show this help and exit

PRIVACY
  claudeledger only reads JSONL files under ~/.claude (or --root). It never makes a
  network request. Time-of-day stats are bucketed in your local timezone.
`;

/** Aggregate distinct event `type` values and the keys seen on each. */
function dumpSchema(events: RawEvent[]): string {
  const typeCounts = new Map<string, number>();
  const typeKeys = new Map<string, Set<string>>();

  for (const ev of events) {
    const type = typeof ev.type === "string" ? ev.type : "<no type>";
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    let keys = typeKeys.get(type);
    if (!keys) {
      keys = new Set<string>();
      typeKeys.set(type, keys);
    }
    for (const k of Object.keys(ev)) keys.add(k);
  }

  const lines: string[] = [];
  lines.push(`Observed ${events.length} events across ${typeCounts.size} type(s):\n`);
  const sorted = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [type, count] of sorted) {
    const keys = [...(typeKeys.get(type) ?? [])].sort();
    lines.push(`  ${type}  (${count})`);
    lines.push(`    keys: ${keys.join(", ")}`);
  }
  return lines.join("\n") + "\n";
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }
  if (opts.version) {
    process.stdout.write(`claudeledger ${VERSION}\n`);
    return;
  }

  const startedAt = performance.now();
  const discovery = discoverSessions({ root: opts.root });

  if (!discovery.found) {
    process.stdout.write(
      `No Claude Code sessions found at ${discovery.projectsDir}.\n` +
        `Is Claude Code installed? You can point claudeledger elsewhere with --root <path>.\n`,
    );
    return; // exit 0 — this is a normal "nothing to show" state, not an error.
  }

  let parsed = await parseSessions(discovery.sessions);
  const skipped = parsed.reduce((sum, p) => sum + p.skippedLines, 0);

  // Recover real project names from each project's dominant `cwd` (the decoded
  // directory name is lossy). Must happen before --project matching.
  parsed = enrichProjectsFromCwd(parsed);

  // --project: substring match (case-insensitive) on the real project path.
  if (opts.project) {
    const query = opts.project;
    parsed = parsed.filter((p) => matchesProject(p.file, query));
  }

  if (opts.dumpSchema) {
    const events = parsed.flatMap((p) => p.events);
    process.stdout.write(dumpSchema(events));
    if (opts.verbose) printVerbose(parsed.length, events.length, skipped, startedAt);
    return;
  }

  // --since / --until: parse bounds against "now", then filter events.
  const now = new Date();
  const { since, until } = resolveDateBounds(opts, now);
  parsed = filterByDate(parsed, since?.ms, until?.ms);

  if (parsed.length === 0) {
    process.stdout.write("No sessions match the given filters.\n");
    return;
  }

  const stats = analyze(parsed, {
    generatedAt: now.toISOString(),
    topN: opts.top,
    range: { since: since?.label, until: until?.label },
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify(stats, null, 2) + "\n");
  } else if (opts.html) {
    const outPath = resolve(opts.out ?? "report.html");
    writeFileSync(outPath, renderHtml(stats), "utf8");
    process.stdout.write(`Wrote self-contained report to ${outPath}\n`);
    // CLAUDELEDGER_NO_OPEN lets scripts/CI generate the report without launching a browser.
    if (process.env.CLAUDELEDGER_NO_OPEN) {
      process.stdout.write(`Open it in your browser: file://${outPath}\n`);
    } else {
      const opened = await openInBrowser(outPath);
      if (!opened) {
        process.stdout.write(`Open it in your browser: file://${outPath}\n`);
      }
    }
  } else {
    process.stdout.write(renderTerminal(stats));
  }

  if (stats.totals.unpricedModels.length > 0 && opts.json) {
    process.stderr.write(
      `claudeledger: warning — unpriced model(s): ${stats.totals.unpricedModels.join(", ")}. ` +
        `Update src/pricing.ts.\n`,
    );
  }

  if (opts.verbose) {
    const events = parsed.flatMap((p) => p.events);
    printVerbose(parsed.length, events.length, skipped, startedAt);
  }
}

/** Does a session belong to a project matching the user's --project substring? */
function matchesProject(s: SessionFile, query: string): boolean {
  const q = query.toLowerCase();
  return (
    s.projectPath.toLowerCase().includes(q) || s.projectName.toLowerCase().includes(q)
  );
}

interface ResolvedBound {
  ms: number;
  label: string;
}

/** Parse --since/--until into epoch-ms bounds, failing clearly on bad input. */
function resolveDateBounds(
  opts: CliOptions,
  now: Date,
): { since?: ResolvedBound; until?: ResolvedBound } {
  let since: ResolvedBound | undefined;
  let until: ResolvedBound | undefined;
  if (opts.since !== undefined) {
    const b = parseDateBound(opts.since, now);
    if (!b) fail(`could not understand --since "${opts.since}"`);
    since = { ms: sinceMs(b), label: opts.since };
  }
  if (opts.until !== undefined) {
    const b = parseDateBound(opts.until, now);
    if (!b) fail(`could not understand --until "${opts.until}"`);
    until = { ms: untilMs(b), label: opts.until };
  }
  return { since, until };
}

function printVerbose(
  sessionCount: number,
  eventCount: number,
  skipped: number,
  startedAt: number,
): void {
  const elapsedMs = performance.now() - startedAt;
  process.stderr.write(
    `\n[verbose] ${sessionCount} session(s), ${eventCount} event(s), ` +
      `${skipped} skipped line(s), ${elapsedMs.toFixed(0)}ms\n`,
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`claudeledger: unexpected error: ${message}\n`);
  process.exit(1);
});
