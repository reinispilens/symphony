import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  buildDaemonHost,
  parseCliArguments,
  runCli,
  type DaemonHost,
  type DaemonHostFactoryOptions,
} from "../src/cli.js";
import type { Logger } from "../src/observability/logger.js";
import { withTempDirectory } from "./support/factories.js";

function logger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function writer(chunks: string[]) {
  return {
    write(chunk: string | Uint8Array) {
      chunks.push(String(chunk));
      return true;
    },
  };
}

function host(): DaemonHost & {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    snapshot: () => ({
      generated_at: new Date(0).toISOString(),
      counts: { running: 0, retrying: 0 },
      running: [],
      retrying: [],
      codex_totals: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        seconds_running: 0,
      },
      rate_limits: null,
    }),
  };
}

describe("Symphony CLI", () => {
  it("refuses a repository-owned workflow as managed Git deployment authority", async () => {
    await expect(
      buildDaemonHost({
        source: {
          kind: "workflow",
          path: path.resolve("WORKFLOW.example.md"),
        },
        environment: {},
        logger: logger(),
      }),
    ).rejects.toMatchObject({ code: "deployment_binding_refused" });
  });

  it("parses one positional workflow and rejects unknown or competing arguments", () => {
    expect(parseCliArguments([])).toEqual({
      action: "run",
      source: { kind: "workflow", path: undefined },
    });
    expect(parseCliArguments(["repo/WORKFLOW.md"])).toEqual({
      action: "run",
      source: { kind: "workflow", path: "repo/WORKFLOW.md" },
    });
    expect(parseCliArguments(["--binding", "deploy/widget.json"])).toEqual({
      action: "run",
      source: { kind: "binding", path: "deploy/widget.json" },
    });
    expect(() => parseCliArguments(["--port", "3"])).toThrow("unknown option");
    expect(() => parseCliArguments(["one", "two"])).toThrow(
      "at most one workflow path",
    );
    expect(() =>
      parseCliArguments(["WORKFLOW.md", "--binding", "deploy.json"]),
    ).toThrow("cannot be combined");
  });

  it("prints help and version without constructing a daemon", async () => {
    const stdout: string[] = [];
    const hostFactory = vi.fn();
    await expect(
      runCli(["--help"], { hostFactory, stdout: writer(stdout) }),
    ).resolves.toBe(0);
    await expect(
      runCli(["--version"], { hostFactory, stdout: writer(stdout) }),
    ).resolves.toBe(0);
    expect(stdout.join("")).toContain("Usage: symphony");
    expect(stdout.join("")).toContain("symphony 0.1.0");
    expect(hostFactory).not.toHaveBeenCalled();
  });

  it("resolves explicit and cwd-default workflow paths and shuts down normally", async () => {
    const created: DaemonHostFactoryOptions[] = [];
    const firstHost = host();
    const secondHost = host();
    const hosts = [firstHost, secondHost];
    const hostFactory = async (options: DaemonHostFactoryOptions) => {
      created.push(options);
      return hosts.shift()!;
    };
    const dependencies = {
      cwd: "/srv/repository",
      environment: {},
      hostFactory,
      logger: logger(),
      waitForShutdown: async () => "test-complete",
    };

    await expect(runCli([], dependencies)).resolves.toBe(0);
    await expect(runCli(["config/WORKFLOW.md"], dependencies)).resolves.toBe(0);
    expect(created.map((entry) => entry.source)).toEqual([
      { kind: "workflow", path: "/srv/repository/WORKFLOW.md" },
      {
        kind: "workflow",
        path: "/srv/repository/config/WORKFLOW.md",
      },
    ]);
    expect(firstHost.start).toHaveBeenCalledOnce();
    expect(firstHost.stop).toHaveBeenCalledOnce();
    expect(secondHost.start).toHaveBeenCalledOnce();
    expect(secondHost.stop).toHaveBeenCalledOnce();
  });

  it("returns nonzero for a missing default workflow", async () => {
    await withTempDirectory(async (directory) => {
      const testLogger = logger();
      await expect(
        runCli([], {
          cwd: directory,
          environment: {},
          logger: testLogger,
          waitForShutdown: async () => "unused",
        }),
      ).resolves.toBe(1);
      expect(testLogger.error).toHaveBeenCalledWith(
        "service outcome=failed",
        expect.objectContaining({
          configuration_kind: "workflow",
          configuration_path: path.join(directory, "WORKFLOW.md"),
        }),
      );
    });
  });

  it("stops a started host and returns nonzero when host waiting fails", async () => {
    const testHost = host();
    await expect(
      runCli(["WORKFLOW.md"], {
        cwd: "/repo",
        hostFactory: async () => testHost,
        logger: logger(),
        waitForShutdown: async () => {
          throw new Error("host failed");
        },
      }),
    ).resolves.toBe(1);
    expect(testHost.start).toHaveBeenCalledOnce();
    expect(testHost.stop).toHaveBeenCalledOnce();
  });
});
