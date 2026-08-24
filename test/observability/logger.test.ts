import { describe, expect, it, vi } from "vitest";

import { JsonLineLogger } from "../../src/observability/logger.js";

function collectingSink(lines: string[]) {
  return {
    write(chunk: string | Uint8Array) {
      lines.push(String(chunk));
      return true;
    },
  };
}

describe("JsonLineLogger", () => {
  it("writes stable JSON lines, filters levels, and protects core fields", () => {
    const lines: string[] = [];
    const logger = new JsonLineLogger({
      minimumLevel: "info",
      now: () => new Date("2026-08-23T10:00:00Z"),
      sink: collectingSink(lines),
    });

    logger.debug("hidden");
    logger.info("dispatch outcome=started", {
      issue_id: "id-1",
      level: "forged",
      message: "forged",
    });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      timestamp: "2026-08-23T10:00:00.000Z",
      level: "info",
      message: "dispatch outcome=started",
      issue_id: "id-1",
    });
  });

  it("normalizes errors and cycles without throwing", () => {
    const lines: string[] = [];
    const cyclic: Record<string, unknown> = { value: 1 };
    cyclic["self"] = cyclic;
    const logger = new JsonLineLogger({ sink: collectingSink(lines) });

    expect(() =>
      logger.error("worker outcome=failed", {
        cause: new Error("boom"),
        cyclic,
        bigint: 42n,
      }),
    ).not.toThrow();
    expect(JSON.parse(lines[0]!)).toMatchObject({
      cause: { name: "Error", message: "boom" },
      cyclic: { value: 1, self: "[Circular]" },
      bigint: "42",
    });
  });

  it("falls back to stderr when a configured sink throws", () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const logger = new JsonLineLogger({
      sink: {
        write() {
          throw new Error("disk full");
        },
      },
    });

    expect(() => logger.warn("test")).not.toThrow();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("log_sink outcome=failed"),
    );
  });
});
