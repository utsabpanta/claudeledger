/**
 * Defensive JSONL parsing.
 *
 * Sessions can be 100MB+, so we stream each file line-by-line via `readline`
 * and never load the whole thing into memory or `JSON.parse` it as one blob.
 * Lines that fail to parse (corrupt, or a half-written line in an in-progress
 * session) are skipped and counted, never thrown.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { ParsedSession, RawEvent, SessionFile } from "./types.js";

/**
 * Parse a single session file into events.
 *
 * @returns the events plus a count of unparseable lines. A file that cannot be
 *   opened at all yields zero events and `skippedLines: 0` (it was deleted or
 *   is unreadable — not our concern to surface as a parse failure).
 */
export async function parseSessionFile(
  file: SessionFile,
): Promise<ParsedSession> {
  const events: RawEvent[] = [];
  let skippedLines = 0;

  let stream;
  try {
    stream = createReadStream(file.path, { encoding: "utf8" });
  } catch {
    return { file, events, skippedLines };
  }

  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        // Only objects are events; arrays/scalars are not what we model.
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          events.push(parsed as RawEvent);
        } else {
          skippedLines++;
        }
      } catch {
        skippedLines++;
      }
    }
  } catch {
    // A read error mid-stream (e.g. file deleted while reading) — keep what we
    // have rather than failing the whole run.
  } finally {
    rl.close();
    stream.destroy();
  }

  return { file, events, skippedLines };
}

/**
 * Parse many session files. Returns each parsed session in input order.
 *
 * Files are parsed sequentially to keep peak memory bounded — we never hold
 * more than one file's worth of raw lines beyond the accumulated event arrays.
 */
export async function parseSessions(
  files: SessionFile[],
): Promise<ParsedSession[]> {
  const out: ParsedSession[] = [];
  for (const file of files) {
    out.push(await parseSessionFile(file));
  }
  return out;
}
