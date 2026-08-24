import { isRecord } from "../shared/json.js";
import type { AgentEvent } from "../agent/events.js";

export interface TokenTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

const ZERO_TOKENS: TokenTotals = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
};

function count(
  source: Record<string, unknown>,
  camelCase: string,
  snakeCase: string,
): number | null {
  const value = source[camelCase] ?? source[snakeCase];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/** Extract only absolute totals from the normalized usage event. */
export function absoluteTokenTotals(event: AgentEvent): TokenTotals | null {
  if (event.event !== "usage" || !isRecord(event["usage"])) return null;
  const usage = event["usage"];
  const selected = isRecord(usage["total"])
    ? usage["total"]
    : isRecord(usage["total_token_usage"])
      ? usage["total_token_usage"]
      : usage;
  const inputTokens = count(selected, "inputTokens", "input_tokens");
  const outputTokens = count(selected, "outputTokens", "output_tokens");
  const totalTokens = count(selected, "totalTokens", "total_tokens");
  if (inputTokens === null && outputTokens === null && totalTokens === null) {
    return null;
  }
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    totalTokens: totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0),
  };
}

export function tokenDelta(
  previous: TokenTotals,
  current: TokenTotals,
): TokenTotals {
  return {
    inputTokens: Math.max(current.inputTokens - previous.inputTokens, 0),
    outputTokens: Math.max(current.outputTokens - previous.outputTokens, 0),
    totalTokens: Math.max(current.totalTokens - previous.totalTokens, 0),
  };
}

/** Preserve the highest absolute baseline when a partial or stale report moves backward. */
export function monotonicTokenTotals(
  previous: TokenTotals,
  current: TokenTotals,
): TokenTotals {
  return {
    inputTokens: Math.max(previous.inputTokens, current.inputTokens),
    outputTokens: Math.max(previous.outputTokens, current.outputTokens),
    totalTokens: Math.max(previous.totalTokens, current.totalTokens),
  };
}

export function zeroTokenTotals(): TokenTotals {
  return { ...ZERO_TOKENS };
}
