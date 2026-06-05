import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseSessionFile } from "../src/parse.js";
import { makeFile } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => join(here, "fixtures", name);

describe("parseSessionFile", () => {
  it("parses every valid line of a clean session", async () => {
    const { events, skippedLines } = await parseSessionFile(
      makeFile({ path: fixture("session-basic.jsonl") }),
    );
    expect(events).toHaveLength(3);
    expect(skippedLines).toBe(0);
    expect(events[0]?.type).toBe("user");
    expect(events[1]?.message?.usage?.input_tokens).toBe(1000);
  });

  it("skips and counts corrupt / non-object lines without throwing", async () => {
    const { events, skippedLines } = await parseSessionFile(
      makeFile({ path: fixture("session-corrupt.jsonl") }),
    );
    // 2 valid object events; garbage line + `[]` array + bare string are skipped.
    expect(events).toHaveLength(2);
    expect(skippedLines).toBe(3);
    expect(events.map((e) => e.type)).toEqual(["user", "assistant"]);
  });

  it("returns empty for a non-existent file rather than throwing", async () => {
    const { events, skippedLines } = await parseSessionFile(
      makeFile({ path: fixture("does-not-exist.jsonl") }),
    );
    expect(events).toEqual([]);
    expect(skippedLines).toBe(0);
  });
});
