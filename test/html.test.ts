import { describe, it, expect } from "vitest";
import { analyze } from "../src/analyze.js";
import { renderHtml } from "../src/report/html.js";
import type { RawEvent } from "../src/types.js";
import { makeSession } from "./helpers.js";

function buildStats() {
  // A file path containing HTML metacharacters, to prove escaping.
  const evil = "/repo/<script>alert(1)</script>.ts";
  const ev: RawEvent = {
    type: "assistant",
    timestamp: "2026-01-15T10:00:00.000Z",
    message: {
      model: "claude-opus-4-8",
      usage: { input_tokens: 1000, output_tokens: 200 },
      content: [{ type: "tool_use", name: "Write", input: { file_path: evil } }],
    },
  };
  return { stats: analyze([makeSession([ev])], { generatedAt: "2026-06-04T00:00:00.000Z" }), evil };
}

describe("renderHtml", () => {
  it("produces a self-contained document with no scripts or external assets", () => {
    const { stats } = buildStats();
    const html = renderHtml(stats);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/https?:\/\//); // no remote references
    expect(html).not.toContain("<link");
    expect(html).toContain("<svg"); // charts are inlined SVG
  });

  it("escapes user-controlled strings (file paths) to prevent broken markup", () => {
    const { stats, evil } = buildStats();
    const html = renderHtml(stats);
    expect(html).not.toContain(evil); // raw, unescaped form must be absent
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders headline totals", () => {
    const { stats } = buildStats();
    const html = renderHtml(stats);
    expect(html).toContain("Sessions");
    expect(html).toContain("Total cost");
  });
});
