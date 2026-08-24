import { describe, expect, it } from "vitest";

import type { AgentEvent } from "../../src/agent/events.js";
import {
  absoluteTokenTotals,
  monotonicTokenTotals,
  tokenDelta,
  zeroTokenTotals,
} from "../../src/orchestrator/token-accounting.js";

function event(usage: AgentEvent["usage"]): AgentEvent {
  return {
    event: "usage",
    timestamp: "2026-08-23T10:00:00Z",
    usage,
  };
}

describe("token accounting", () => {
  it("extracts absolute camelCase and snake_case totals but ignores generic events", () => {
    expect(
      absoluteTokenTotals(
        event({
          total: {
            inputTokens: 12,
            outputTokens: 8,
            totalTokens: 20,
          },
          last: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        }),
      ),
    ).toEqual({ inputTokens: 12, outputTokens: 8, totalTokens: 20 });
    expect(
      absoluteTokenTotals(
        event({
          total_token_usage: { input_tokens: 5, output_tokens: 7 },
        }),
      ),
    ).toEqual({ inputTokens: 5, outputTokens: 7, totalTokens: 12 });
    expect(
      absoluteTokenTotals({
        event: "notification",
        timestamp: "2026-08-23T10:00:00Z",
        usage: { totalTokens: 999 },
      }),
    ).toBeNull();
  });

  it("adds only growth between repeated absolute reports", () => {
    const first = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
    const second = { inputTokens: 14, outputTokens: 9, totalTokens: 23 };
    expect(tokenDelta(zeroTokenTotals(), first)).toEqual(first);
    expect(tokenDelta(first, first)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
    expect(tokenDelta(first, second)).toEqual({
      inputTokens: 4,
      outputTokens: 4,
      totalTokens: 8,
    });
    expect(
      monotonicTokenTotals(second, {
        inputTokens: 0,
        outputTokens: 8,
        totalTokens: 20,
      }),
    ).toEqual(second);
  });
});
