/**
 * Shared types for claudestats.
 *
 * The Claude Code JSONL format is undocumented and evolves across versions, so
 * every field on {@link RawEvent} is optional and must be accessed defensively.
 * {@link Stats} is the pure analytics output (see `analyze.ts`).
 */

/** One token-usage record off an assistant message. All fields optional. */
export interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  // Other keys (cache_creation, inference_geo, service_tier, ...) are ignored.
  [key: string]: unknown;
}

/** One content block inside `message.content[]`. */
export interface RawContentBlock {
  type?: string;
  name?: string;
  input?: Record<string, unknown>;
  [key: string]: unknown;
}

/** The `message` object carried by user/assistant events. */
export interface RawMessage {
  model?: string;
  usage?: RawUsage;
  content?: RawContentBlock[] | string;
  [key: string]: unknown;
}

/**
 * One parsed JSONL line. This intentionally models only the fields claudestats
 * reads; unknown keys are preserved via the index signature but never assumed.
 */
export interface RawEvent {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  message?: RawMessage;
  [key: string]: unknown;
}

/** A discovered session file plus the metadata derived from its location. */
export interface SessionFile {
  /** Absolute path to the `.jsonl` file. */
  path: string;
  /** Session id recovered from the filename (without extension). */
  sessionId: string;
  /** Raw url-encoded project directory name (e.g. `-Users-me-app`). */
  projectDir: string;
  /** Decoded, human-readable project path (e.g. `/Users/me/app`). */
  projectPath: string;
  /** Last path segment of {@link projectPath} — a short display name. */
  projectName: string;
  /**
   * True for nested subagent transcripts
   * (`<project>/<session-id>/subagents/agent-*.jsonl`). Their tokens, tool
   * calls, and file edits are real activity and ARE counted, but they are not
   * top-level sessions — session counts and duration stats exclude them.
   */
  isSubagent: boolean;
}

/** Result of parsing a single session file. */
export interface ParsedSession {
  file: SessionFile;
  events: RawEvent[];
  /** Count of lines that failed `JSON.parse` (partial/corrupt lines). */
  skippedLines: number;
}

/** Token totals, split so cheap cache reads never get conflated with input. */
export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** The full analytics result. Pure function of the parsed sessions + a clock. */
export interface Stats {
  /** ISO timestamp the report was generated (injected, never read from clock). */
  generatedAt: string;
  /** The active date filter, echoed back for display. */
  range: { since?: string; until?: string };
  totals: {
    sessions: number;
    projects: number;
    messages: number;
    tokens: TokenTotals;
    /** null if any model in the data was unpriced. */
    costUSD: number | null;
    /** Model ids encountered with no entry in the pricing map. */
    unpricedModels: string[];
    /** Distinct local-time calendar days with at least one event. */
    activeDays: number;
  };
  perProject: Array<{
    name: string;
    sessions: number;
    tokens: number;
    costUSD: number | null;
  }>;
  topTools: Array<{ name: string; count: number }>;
  topFiles: Array<{ path: string; edits: number }>;
  /** Length 24, message counts bucketed by local hour. */
  byHour: number[];
  /** Length 7, message counts bucketed by local weekday (0 = Sunday). */
  byWeekday: number[];
  /** Per-day time series, attributed to the local day each event occurred. */
  byDay: Array<{ date: string; tokens: number; costUSD: number | null }>;
  sessionDurations: { medianMin: number; p90Min: number; longestMin: number };
  modelMix: Array<{ model: string; tokens: number }>;
}
