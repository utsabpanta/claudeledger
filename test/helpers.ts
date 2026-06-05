import type { ParsedSession, RawEvent, SessionFile } from "../src/types.js";

/** Build a SessionFile with sensible defaults for tests. */
export function makeFile(overrides: Partial<SessionFile> = {}): SessionFile {
  return {
    path: "/fake/projects/-proj/s.jsonl",
    sessionId: "s",
    projectDir: "-proj",
    projectPath: "/proj",
    projectName: "proj",
    isSubagent: false,
    ...overrides,
  };
}

/** Wrap events in a ParsedSession with a given (or default) file. */
export function makeSession(
  events: RawEvent[],
  fileOverrides: Partial<SessionFile> = {},
  skippedLines = 0,
): ParsedSession {
  return { file: makeFile(fileOverrides), events, skippedLines };
}
