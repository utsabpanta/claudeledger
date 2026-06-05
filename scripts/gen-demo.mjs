// Generate a synthetic ~/.claude tree of session logs for demos and README
// assets — so we never commit real, personal paths/costs. Deterministic (seeded
// PRNG) so the output is reproducible.
//
//   node scripts/gen-demo.mjs [outDir]   (default: ./.demo-claude)
//
// Then:  node dist/cli.js --root <outDir> --html

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const outDir = process.argv[2] ?? ".demo-claude";

// --- deterministic PRNG (mulberry32) -------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20260604);
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const randInt = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

// --- synthetic shape ------------------------------------------------------
const PROJECTS = [
  { dir: "/home/dev/acme-web", files: ["src/app.tsx", "src/api/client.ts", "README.md", "src/components/Nav.tsx"] },
  { dir: "/home/dev/data-pipeline", files: ["pipeline/etl.py", "pipeline/load.py", "tests/test_etl.py", "config.yaml"] },
  { dir: "/home/dev/ml-experiments", files: ["train.py", "model.py", "notebooks/eval.ipynb"] },
  { dir: "/home/dev/docs-site", files: ["docs/intro.md", "docs/guide.md", "astro.config.mjs"] },
];
const MODELS = [
  { id: "claude-opus-4-8", weight: 6 },
  { id: "claude-sonnet-4-6", weight: 3 },
  { id: "claude-haiku-4-5", weight: 2 },
];
const TOOLS = ["Bash", "Read", "Write", "Edit", "Grep", "WebSearch", "TaskUpdate"];

function weightedModel() {
  const total = MODELS.reduce((s, m) => s + m.weight, 0);
  let r = rng() * total;
  for (const m of MODELS) {
    if ((r -= m.weight) <= 0) return m.id;
  }
  return MODELS[0].id;
}

function encodeDir(absPath) {
  return absPath.replace(/\//g, "-");
}

// 30-day window ending 2026-06-01, with a few busy days for an interesting chart.
const END = Date.UTC(2026, 5, 1, 18, 0, 0);
const DAY = 86_400_000;
const busyDays = new Set([4, 11, 12, 19, 25]);

function sessionEvents(project, startMs) {
  const events = [];
  const events_n = randInt(18, 70);
  let t = startMs;
  for (let i = 0; i < events_n; i++) {
    t += randInt(20_000, 240_000); // 20s–4m between events
    const cwd = project.dir;
    if (rng() < 0.45) {
      events.push({ type: "user", timestamp: new Date(t).toISOString(), cwd, message: { role: "user", content: "..." } });
      continue;
    }
    const model = weightedModel();
    const blocks = [{ type: "text", text: "working" }];
    const nTools = randInt(0, 3);
    for (let k = 0; k < nTools; k++) {
      const tool = pick(TOOLS);
      const fileTool = ["Read", "Write", "Edit"].includes(tool);
      blocks.push({
        type: "tool_use",
        name: tool,
        input: fileTool ? { file_path: join(project.dir, pick(project.files)) } : { query: "x" },
      });
    }
    events.push({
      type: "assistant",
      timestamp: new Date(t).toISOString(),
      cwd,
      message: {
        model,
        usage: {
          input_tokens: randInt(200, 4000),
          output_tokens: randInt(100, 2500),
          cache_read_input_tokens: randInt(20_000, 320_000),
          cache_creation_input_tokens: randInt(0, 18_000),
        },
        content: blocks,
      },
    });
  }
  return events;
}

// --- write the tree -------------------------------------------------------
rmSync(outDir, { recursive: true, force: true });
let fileCount = 0;
for (const project of PROJECTS) {
  const projDir = join(outDir, "projects", encodeDir(project.dir));
  mkdirSync(projDir, { recursive: true });
  const nSessions = randInt(4, 7);
  for (let s = 0; s < nSessions; s++) {
    const dayOffset = busyDays.size && rng() < 0.3 ? pick([...busyDays]) : randInt(0, 29);
    const start = END - (29 - dayOffset) * DAY + randInt(0, 8) * 3_600_000;
    const events = sessionEvents(project, start);
    const id = `${randInt(10000000, 99999999).toString(16)}-demo-${s}`;
    writeFileSync(join(projDir, `${id}.jsonl`), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    fileCount++;
  }
}
console.log(`Wrote ${fileCount} synthetic session files to ${join(outDir, "projects")}`);
