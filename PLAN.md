# Build Spec: `ccstats` — Claude Code Session Analyzer

> Hand this file to Claude Code. It is written as an executable build plan:
> read it top to bottom, then implement in the order given. Each phase ends
> in a working, committable state.

---

## 0. What we're building (read this first)

A local-first CLI + static web dashboard that reads your own Claude Code
session logs and turns them into **insights** — not just a transcript viewer.
Existing tools (`claude-code-log`, claude-code-tracer) already *render*
conversations. Our differentiation is **analytics**: cost over time, token
burn, tool-call patterns, most-touched files, time-of-day productivity, and
session-length distribution.

**The whole thing runs offline.** It reads files from disk, never sends data
anywhere. That's the headline feature — say it loudly in the README.

**Two surfaces, one core:**
1. `npx ccstats` — prints a summary table to the terminal.
2. `npx ccstats --html` — generates a single self-contained `report.html`
   (charts inlined, no server) and opens it in the browser.

**Stack:** TypeScript, **Node 24 (current Active LTS)**, ESM. Package manager
is **pnpm** (pinned via Corepack — see §3.1). Zero runtime deps where
practical; allowed deps listed in §3. Build with `tsup`. Test with `vitest`.

---

## 1. Where the data lives (verified)

Claude Code writes one JSONL file per session here:

```
~/.claude/projects/<url-encoded-project-path>/<session-id>.jsonl
```

- Project folder names are the absolute project path with `/` replaced by `-`
  (e.g. `/Users/me/code/app` → `-Users-me-code-app`). Decode this back to a
  readable project name for display.
- One `.jsonl` file per session. Each **line** is one JSON object (an "event").
- On Windows the root is `%USERPROFILE%\.claude\`. Resolve via `os.homedir()`.
- Allow override via `CLAUDE_ROOT` env var (some users relocate it) and a
  `--root <path>` flag.
- **Old sessions get auto-deleted by Claude Code**, so never assume a file
  you saw before still exists. Re-scan every run.

### JSONL format reality check (important)

The format is **undocumented and evolving** — Anthropic does not publish a
spec, and fields have changed across versions. Therefore:

- **Parse defensively.** Every field access must tolerate `undefined`.
- Skip lines that fail `JSON.parse` (log a count of skipped lines in
  `--verbose`, don't crash).
- Do not hard-code an exhaustive schema. Match on the fields you need and
  ignore the rest.

Fields you can rely on being present on *most* event objects (validate at
runtime, treat all as optional):

| Field | Meaning | Notes |
|---|---|---|
| `type` | event kind | e.g. `"user"`, `"assistant"`, `"summary"`, system events. Branch on this. |
| `timestamp` | ISO 8601 string | use for time-series + session duration |
| `sessionId` | session UUID | also recoverable from filename |
| `cwd` | working dir | fallback for project name |
| `message` | the model/user message object | for assistant events, holds `usage` and `content` |
| `message.usage` | token counts | `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` — **all optional** |
| `message.model` | model id string | e.g. an Opus/Sonnet/Haiku identifier; used for cost calc |
| `message.content[]` | array of blocks | blocks with `type: "tool_use"` have a `name` (the tool) and `input`; use these for tool-call + file stats |

> **Build a tiny corpus first.** Before writing analytics, run the scanner in
> `--dump-schema` mode (you'll add this in Phase 1) that prints the set of
> distinct `type` values and the keys seen on each. Implement against what's
> actually on disk, not against this table. This table is a starting hint, not
> gospel.

### Deriving the stats from events

- **Tokens:** sum `message.usage.*` across assistant events. Track input,
  output, cache-read, and cache-creation separately — cache reads are cheap and
  conflating them wrecks the cost number.
- **Cost:** `tokens × per-model price`. Prices live in a single editable
  `src/pricing.ts` map keyed by model id, with a clearly-marked
  `LAST_UPDATED` date and a comment linking to Anthropic's pricing page.
  **Do not fetch prices at runtime.** If a model id isn't in the map, count
  its tokens but mark cost as "unknown" rather than guessing — and surface a
  one-line warning telling the user to update `pricing.ts`.
- **Tool calls:** count `tool_use` blocks by `name`.
- **Files touched:** from tool_use blocks for file tools (Edit/Write/Read-type
  names — detect by inspecting `input.file_path` / `input.path` presence rather
  than hard-coding tool names, since names vary by version). Rank by frequency.
- **Time-of-day / day-of-week:** bucket `timestamp` into local-time histograms.
- **Session duration:** last timestamp − first timestamp within a file.
- **Session length:** event count and message count per session.

---

## 2. Commands & flags

```
ccstats                      # summary table for ALL projects, all time
ccstats --project <name>     # filter to one project (substring match on decoded path)
ccstats --since "7 days ago" # date filter; support ISO dates + simple natural language
ccstats --until <date>
ccstats --html               # write report.html and open in browser
ccstats --out <path>         # custom output path for the html
ccstats --json               # emit machine-readable JSON to stdout (for piping)
ccstats --root <path>        # override ~/.claude
ccstats --top <n>            # how many rows in "top files"/"top tools" (default 10)
ccstats --verbose            # show skipped-line counts, timing, parse warnings
ccstats --dump-schema        # dev aid: print observed event types + keys, then exit
ccstats --version / --help
```

Flag parsing: use a tiny parser (see allowed deps). No heavy framework.

---

## 3. Allowed dependencies

Keep it lean. Permitted:

- `picocolors` — terminal color (tiny).
- `cli-table3` — the terminal summary table.
- `chrono-node` — natural-language date parsing for `--since/--until`. (If you
  want zero-dep, hand-roll "N days/weeks ago" + ISO and drop this.)
- Dev only: `typescript`, `tsup`, `vitest`, `@types/node`.

Install with pnpm, e.g. `pnpm add picocolors cli-table3 chrono-node` and
`pnpm add -D typescript tsup vitest @types/node`.

**Charts in the HTML report:** do **not** add a chart npm dep. Inline a pinned
copy of a small charting lib (or hand-draw SVG) into the generated HTML so the
report is fully self-contained and offline. Prefer hand-drawn SVG bar/line
charts — it's a stronger portfolio signal and removes a dep. Only reach for a
vendored lib if a chart genuinely needs it.

No telemetry. No network calls anywhere in the runtime path. This is a hard rule.

### 3.1 Toolchain pinning (do this in Phase 1, first thing)

- Target **Node 24** (Active LTS). Add an `.nvmrc` containing `24` and an
  `engines` field: `"engines": { "node": ">=24" }`.
- Pin **pnpm via Corepack** so every contributor (and CI) uses the same
  version without a global install:
  - Add `"packageManager": "pnpm@10.x.x"` to `package.json` (use the exact
    current pnpm 10 patch version — run `pnpm --version` after enabling and
    paste it in; don't leave the `x`s).
  - Document the one-time setup in the README: `corepack enable` then
    `corepack prepare pnpm@<pinned> --activate`.
- Use a `pnpm-lock.yaml` (commit it). Do **not** commit a `package-lock.json`
  or `yarn.lock` — add them to `.gitignore` to prevent accidental mixing.
- Scripts in `package.json` use pnpm conventions:
  `"build": "tsup"`, `"test": "vitest run"`, `"dev": "tsup --watch"`.
- If you add CI later (stretch), use `actions/setup-node@v4` with
  `node-version: 24` and `cache: pnpm`, plus `pnpm/action-setup`.

---

## 4. Architecture / file layout

```
ccstats/
  package.json          # "bin": { "ccstats": "./dist/cli.js" }, type: module,
                        #   packageManager: "pnpm@10.x.x", engines.node ">=24"
  pnpm-lock.yaml        # commit this
  .nvmrc                # contains: 24
  tsconfig.json
  tsup.config.ts
  README.md
  LICENSE               # MIT
  src/
    cli.ts              # arg parsing, orchestration, exit codes
    discover.ts         # find ~/.claude/projects, list session files, decode project names
    parse.ts            # JSONL → typed Event[] (defensive, streaming line-by-line)
    pricing.ts          # model→price map + LAST_UPDATED + cost() helper
    analyze.ts          # Event[] → Stats object (the core; pure functions, no IO)
    report/
      terminal.ts       # Stats → cli-table3 output
      html.ts           # Stats → self-contained HTML string (inlined SVG charts)
    types.ts            # shared types
    util/
      dates.ts          # since/until filtering, natural-language parse wrapper
  test/
    fixtures/           # 2-3 hand-crafted .jsonl samples + 1 anonymized real one
    parse.test.ts
    analyze.test.ts     # the important one: assert stats on known fixtures
```

**Design rule:** `analyze.ts` is pure (Events in, Stats out, no fs/clock).
That makes it trivially testable and is what makes the project look senior.
All IO lives in `discover.ts`/`cli.ts`. All clock access is injected.

---

## 5. The `Stats` shape (target output of `analyze`)

```ts
interface Stats {
  generatedAt: string;
  range: { since?: string; until?: string };
  totals: {
    sessions: number;
    projects: number;
    messages: number;
    tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
    costUSD: number | null;        // null if any model was unpriced
    unpricedModels: string[];      // surfaced as a warning
    activeDays: number;
  };
  perProject: Array<{ name: string; sessions: number; tokens: number; costUSD: number | null }>;
  topTools: Array<{ name: string; count: number }>;
  topFiles: Array<{ path: string; edits: number }>;
  byHour: number[];                // length 24, message counts
  byWeekday: number[];             // length 7
  byDay: Array<{ date: string; tokens: number; costUSD: number | null }>; // time series
  sessionDurations: { medianMin: number; p90Min: number; longestMin: number };
  modelMix: Array<{ model: string; tokens: number }>;
}
```

The terminal report shows totals + topTools + topFiles + a sparkline of `byDay`.
The HTML report shows everything, with SVG charts for `byDay` (line),
`byHour` (bar), `topFiles`/`topTools` (horizontal bars), and `modelMix` (donut
or stacked bar).

---

## 6. Build phases (each ends committable)

**Phase 1 — Toolchain + discovery + parsing skeleton.**
First: scaffold with pnpm per §3.1 (`.nvmrc`, `packageManager`, `engines`,
ESM `package.json`, `tsup`, `vitest`). Verify `pnpm install && pnpm build`
runs clean on Node 24. Then `discover.ts` finds session files and decodes
project names. `parse.ts` streams a file into events defensively. Implement
`--dump-schema` and `--verbose`. Goal: `node dist/cli.js --dump-schema` prints
real event types from your own logs without crashing. Commit.

**Phase 2 — Analytics core.**
`pricing.ts` + `analyze.ts`. Write `analyze.test.ts` against hand-built
fixtures with *known* answers (e.g. a fixture with exactly 3 tool calls and
1000 input tokens → assert the numbers). Get totals, tokens, cost, topTools,
topFiles correct. Commit.

**Phase 3 — Terminal report.**
`report/terminal.ts` + wire up `cli.ts` for the default command, `--project`,
`--since/--until`, `--top`, `--json`. Make `ccstats` produce a clean table.
Commit.

**Phase 4 — HTML report.**
`report/html.ts` generates one self-contained file with inlined SVG charts and
a little CSS. `--html`/`--out` writes it and opens the browser. No server, no
external assets. Commit.

**Phase 5 — Polish + ship.**
README with an animated GIF of the terminal output and a screenshot of the
HTML report (this is what earns stars — lead with visuals). `npx`-ability
verified. `bin` shebang `#!/usr/bin/env node`. Add `--help`. Tag `v0.1.0`.

> **pnpm vs npx — don't get confused here.** You *develop* with pnpm, but
> `npx ccstats` is what end users run, and it resolves from the **npm
> registry** regardless of your dev package manager — pnpm and npx coexist
> fine. To publish: `pnpm build` then `pnpm publish` (pnpm can publish to the
> npm registry). To smoke-test the published `npx` path locally before
> releasing, use `pnpm pack` to produce a tarball and run it with
> `npx ./ccstats-0.1.0.tgz`. Confirm the `bin`, shebang, and `files` field in
> `package.json` are correct so the published package actually exposes the CLI.

---

## 7. Edge cases to handle (don't skip — this is where quality shows)

- `~/.claude/projects` doesn't exist → friendly message ("No Claude Code
  sessions found at <path>. Is Claude Code installed?"), exit 0, not a stack trace.
- Empty / partially-written JSONL files (a session in progress) → parse what's
  valid, skip the rest.
- A session spanning multiple days → attribute tokens to the day each event
  occurred, not the session start.
- Huge files (100MB+ sessions exist) → stream line-by-line, never
  `JSON.parse` the whole file or load it all into memory.
- Unknown / future model ids → count tokens, cost `null`, warn once.
- Timezone: bucket by **local** time (that's what "time of day productivity"
  means to the user); note this in `--help`.
- Mixed event schemas across Claude Code versions → never assume a key exists.

---

## 8. README outline (Phase 5)

1. One-line pitch + the offline/privacy hook.
2. Animated GIF of `npx ccstats`.
3. Screenshot of the HTML report.
4. `npx ccstats` quickstart (no install).
5. What it reads & the privacy guarantee (reads `~/.claude` locally, sends
   nothing — link to the relevant lines in `discover.ts` so people can verify).
6. Commands & flags table.
7. "How costs are calculated" + how to update `pricing.ts`.
8. Caveat: parses an undocumented, evolving log format; PRs welcome when it
   drifts. (Honesty here builds trust and invites contribution.)
9. Contributing + MIT license.

---

## 9. Definition of done

- `npx ccstats` works on a fresh machine against real logs.
- `npx ccstats --html` opens a self-contained, offline report.
- `vitest` green; `analyze.ts` covered against fixtures.
- Zero network calls in runtime (grep the build for `fetch`/`http` to confirm).
- README has a GIF and a screenshot.
- Tagged `v0.1.0`, MIT licensed.

## 10. Stretch (after v0.1.0 — do NOT do these first)

- `--watch` live-tail of the active session.
- Multi-tool: also parse Cursor logs (different format — separate parser).
- Weekly email/markdown digest generator.
- Diff two date ranges ("this week vs last week").

> Resist scope creep. A finished, polished v0.1.0 that does the core well beats
> a half-built tool with five features. Ship Phase 1–5, then stop and publish.