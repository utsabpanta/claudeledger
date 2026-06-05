/**
 * Model pricing, in USD per 1,000,000 tokens.
 *
 * Prices are hard-coded here on purpose — claudeledger never fetches prices at
 * runtime (it makes no network calls at all). When a model is missing from this
 * map, its tokens are still counted but its cost is reported as "unknown" and
 * the CLI prints a one-line warning telling you to update this file.
 *
 * LAST_UPDATED: 2026-06-04
 * Source: Anthropic pricing — https://platform.claude.com/docs/en/about-claude/pricing
 *
 * Cache economics (used to derive the cache rows below):
 *   - cache READ  ≈ 0.1× the input rate
 *   - cache WRITE ≈ 1.25× the input rate (5-minute TTL)
 */

export const LAST_UPDATED = "2026-06-04";

/** Per-million-token rates for one model. */
export interface ModelPrice {
  /** Uncached input tokens. */
  input: number;
  /** Output tokens. */
  output: number;
  /** Tokens served from the prompt cache (cheap). */
  cacheRead: number;
  /** Tokens written to the prompt cache (5-min TTL). */
  cacheWrite: number;
}

/**
 * Pricing keyed by exact model id. Both bare aliases and dated ids are listed
 * because Claude Code writes either form depending on version.
 */
export const PRICING: Record<string, ModelPrice> = {
  // Opus 4.x — $5 in / $25 out per 1M.
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  // Sonnet 4.6 — $3 in / $15 out per 1M.
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  // Haiku 4.5 — $1 in / $5 out per 1M (bare alias + dated id seen in logs).
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

/** Token counts for a single cost calculation, split by billing category. */
export interface CostInput {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/**
 * Compute the USD cost of some token usage for a given model.
 *
 * @returns the dollar cost, or `null` if the model id is not in {@link PRICING}
 *   (the caller should surface this as an "unpriced model" warning rather than
 *   guess at a price).
 */
export function cost(model: string, tokens: CostInput): number | null {
  const price = PRICING[model];
  if (!price) return null;
  return (
    (tokens.input * price.input +
      tokens.output * price.output +
      tokens.cacheRead * price.cacheRead +
      tokens.cacheCreation * price.cacheWrite) /
    1_000_000
  );
}

/** Whether a model id has a known price. */
export function isPriced(model: string): boolean {
  return model in PRICING;
}
