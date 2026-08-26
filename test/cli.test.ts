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

  it("parses the five manual WorkSession commands with an explicit binding", () => {
    const binding = "/etc/symphony/widget.json";
    expect(
      parseCliArguments([
        "work",
        "start",
        "--intent",
        "Build the widget",
        "--binding",
        binding,
      ]),
    ).toEqual({
      action: "work",
      command: {
        action: "start",
        bindingPath: binding,
        intent: "Build the widget",
      },
    });
    expect(
      parseCliArguments([
        "work",
        "attach",
        "--binding",
        binding,
        "--session",
        "session-1",
        "--expected-revision",
        "4",
        "--path",
        "/worktrees/widget",
      ]),
    ).toEqual({
      action: "work",
      command: {
        action: "attach",
        bindingPath: binding,
        sessionId: "session-1",
        expectedRevision: 4,
        path: "/worktrees/widget",
      },
    });
    expect(
      parseCliArguments([
        "work",
        "plan",
        "--binding",
        binding,
        "--session",
        "session-1",
        "--expected-revision",
        "5",
        "--file",
        "plan.md",
      ]),
    ).toMatchObject({
      action: "work",
      command: { action: "plan", filePath: "plan.md" },
    });
    expect(
      parseCliArguments([
        "work",
        "steer",
        "--binding",
        binding,
        "--session",
        "session-1",
        "--expected-revision",
        "6",
        "--message",
        "Keep the adapter thin",
      ]),
    ).toMatchObject({
      action: "work",
      command: { action: "steer", message: "Keep the adapter thin" },
    });
    expect(
      parseCliArguments([
        "work",
        "status",
        "--session",
        "session-1",
        "--json",
        "--binding",
        binding,
      ]),
    ).toEqual({
      action: "work",
      command: {
        action: "status",
        bindingPath: binding,
        sessionId: "session-1",
        json: true,
      },
    });
  });

  it("refuses ambiguous or unsafe manual WorkSession arguments", () => {
    expect(() =>
      parseCliArguments([
        "work",
        "start",
        "--binding",
        "relative.json",
        "--intent",
        "work",
      ]),
    ).toThrow("--binding must be an absolute path");
    expect(() =>
      parseCliArguments([
        "work",
        "attach",
        "--binding",
        "/binding.json",
        "--session",
        "one",
        "--expected-revision",
        "0",
        "--path",
        "/repo",
      ]),
    ).toThrow("integer >= 1");
    expect(() =>
      parseCliArguments([
        "work",
        "status",
        "--binding",
        "/binding.json",
        "--session",
        "one",
        "--json",
        "--json",
      ]),
    ).toThrow("only once");
    expect(() => parseCliArguments(["work", "launch"])).toThrow(
      "unknown work command",
    );
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
    await expect(
      runCli(["work", "--help"], { hostFactory, stdout: writer(stdout) }),
    ).resolves.toBe(0);
    expect(stdout.join("")).toContain("Usage: symphony");
    expect(stdout.join("")).toContain("symphony 0.1.0");
    expect(stdout.join("")).toContain("symphony work start");
    expect(hostFactory).not.toHaveBeenCalled();
  });

  it("runs a manual command without constructing a daemon or logger", async () => {
    const stdout: string[] = [];
    const hostFactory = vi.fn();
    const workCommandRunner = vi.fn(
      async () => "WorkSession session-1 updated.",
    );
    await expect(
      runCli(
        [
          "work",
          "plan",
          "--binding",
          "/etc/symphony/widget.json",
          "--session",
          "session-1",
          "--expected-revision",
          "3",
          "--file",
          "plans/current.md",
        ],
        {
          cwd: "/repo",
          environment: { TEST_TOKEN: "present" },
          hostFactory,
          stdout: writer(stdout),
          workCommandRunner,
        },
      ),
    ).resolves.toBe(0);
    expect(workCommandRunner).toHaveBeenCalledWith(
      {
        action: "plan",
        bindingPath: "/etc/symphony/widget.json",
        sessionId: "session-1",
        expectedRevision: 3,
        filePath: "/repo/plans/current.md",
      },
      { environment: { TEST_TOKEN: "present" } },
    );
    expect(stdout.join("")).toBe("WorkSession session-1 updated.\n");
    expect(hostFactory).not.toHaveBeenCalled();
  });

  it("reports a manual command failure without daemon JSON logging", async () => {
    const stderr: string[] = [];
    await expect(
      runCli(
        [
          "work",
          "status",
          "--binding",
          "/etc/symphony/widget.json",
          "--session",
          "missing",
        ],
        {
          stderr: writer(stderr),
          workCommandRunner: async () => {
            throw new Error("session was not found");
          },
        },
      ),
    ).resolves.toBe(1);
    expect(stderr.join("")).toBe("symphony work: session was not found\n");
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
