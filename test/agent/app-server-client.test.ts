import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  CodexAppServerSession,
  type CodexAppServerSessionOptions,
} from "../../src/agent/app-server-client.js";
import type { AgentEvent } from "../../src/agent/events.js";
import type { AgentToolRuntime } from "../../src/agent/tools.js";
import { withTempDirectory } from "../support/factories.js";

const fixture = fileURLToPath(
  new URL("../fixtures/fake-codex-app-server.mjs", import.meta.url),
);

function fakeCommand(): string {
  return `node ${JSON.stringify(fixture)}`;
}

function environment(scenario: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"],
    FAKE_CODEX_SCENARIO: scenario,
    GH_TOKEN: "must-not-leak",
    GITHUB_TOKEN: "must-not-leak",
    GH_ENTERPRISE_TOKEN: "must-not-leak",
    GITHUB_ENTERPRISE_TOKEN: "must-not-leak",
    CUSTOM_TRACKER_SECRET: "must-not-leak",
    KEEP_ME: "safe",
  };
}

async function startSession(
  cwd: string,
  scenario: string,
  events: AgentEvent[],
  overrides: Partial<CodexAppServerSessionOptions> = {},
): Promise<CodexAppServerSession> {
  return CodexAppServerSession.start({
    command: fakeCommand(),
    cwd,
    readTimeoutMs: 500,
    turnTimeoutMs: 500,
    adapterSecretEnvironmentNames: ["CUSTOM_TRACKER_SECRET"],
    environment: environment(scenario),
    onEvent: (event) => {
      events.push(event);
    },
    title: "SYM-123: Fake issue",
    ...overrides,
  });
}

describe("CodexAppServerSession", () => {
  it("initializes one process/thread and reuses both across continuation turns", async () => {
    await withTempDirectory(async (directory) => {
      const events: AgentEvent[] = [];
      const session = await startSession(directory, "normal", events);
      try {
        const first = await session.runTurn("first prompt");
        const second = await session.runTurn("continuation guidance");

        expect(first).toMatchObject({
          status: "completed",
          threadId: "thread-fake-1",
          turnId: "turn-fake-1",
          sessionId: "thread-fake-1-turn-fake-1",
          usage: { total: { totalTokens: 21 } },
          rateLimits: { limitId: "codex" },
        });
        expect(second).toMatchObject({
          threadId: first.threadId,
          turnId: "turn-fake-2",
        });
        expect(
          events
            .filter((event) => event.event === "session_started")
            .map((event) => event["continuation"]),
        ).toEqual([false, true]);
        expect(events.some((event) => event.event === "usage")).toBe(true);
        expect(events.some((event) => event.event === "rate_limits")).toBe(
          true,
        );
      } finally {
        await session.close();
      }
    });
  });

  it.each([
    ["approval", "item/commandExecution/requestApproval"],
    ["file-approval", "item/fileChange/requestApproval"],
  ])(
    "auto-approves %s requests for the live session",
    async (scenario, method) => {
      await withTempDirectory(async (directory) => {
        const events: AgentEvent[] = [];
        const session = await startSession(directory, scenario, events);
        try {
          await expect(session.runTurn("use a command")).resolves.toMatchObject(
            {
              status: "completed",
            },
          );
          expect(events).toContainEqual(
            expect.objectContaining({
              event: "approval_auto_approved",
              method,
            }),
          );
        } finally {
          await session.close();
        }
      });
    },
  );

  it("declines requests to expand filesystem or network permissions", async () => {
    await withTempDirectory(async (directory) => {
      const events: AgentEvent[] = [];
      const session = await startSession(
        directory,
        "permission-approval",
        events,
      );
      try {
        await expect(
          session.runTurn("access something outside the sandbox"),
        ).resolves.toMatchObject({ status: "completed" });
        expect(events).toContainEqual(
          expect.objectContaining({
            event: "permission_request_declined",
            method: "item/permissions/requestApproval",
          }),
        );
      } finally {
        await session.close();
      }
    });
  });

  it("declines MCP elicitation and rejects unknown server requests without stalling", async () => {
    await withTempDirectory(async (directory) => {
      const elicitation = await startSession(directory, "mcp-elicitation", []);
      try {
        await expect(elicitation.runTurn("do not ask")).resolves.toMatchObject({
          status: "completed",
        });
      } finally {
        await elicitation.close();
      }

      const events: AgentEvent[] = [];
      const unknown = await startSession(directory, "unknown-request", events);
      try {
        await expect(unknown.runTurn("future request")).resolves.toMatchObject({
          status: "completed",
        });
        expect(events).toContainEqual(
          expect.objectContaining({
            event: "unsupported_server_request",
            method: "future/serverRequest",
          }),
        );
      } finally {
        await unknown.close();
      }
    });
  });

  it("advertises and executes one immutable host-side tool snapshot", async () => {
    await withTempDirectory(async (directory) => {
      const events: AgentEvent[] = [];
      const execute = vi.fn(async () => ({
        success: true as const,
        output: { updated: true },
      }));
      const toolRuntime: AgentToolRuntime = {
        specs: [
          {
            name: "fake_tracker_update",
            description: "Update the fake tracker",
            inputSchema: {
              type: "object",
              properties: { status: { type: "string" } },
              required: ["status"],
              additionalProperties: false,
            },
          },
        ],
        execute,
      };
      const session = await startSession(directory, "tool", events, {
        toolRuntime,
      });
      try {
        await expect(session.runTurn("update status")).resolves.toMatchObject({
          status: "completed",
        });
        expect(execute).toHaveBeenCalledWith("fake_tracker_update", {
          status: "Human Review",
        });
        expect(events).toContainEqual(
          expect.objectContaining({
            event: "tool_call_completed",
            success: true,
          }),
        );
      } finally {
        await session.close();
      }
    });
  });

  it("returns a structured failure for an unadvertised tool without stalling", async () => {
    await withTempDirectory(async (directory) => {
      const events: AgentEvent[] = [];
      const session = await startSession(directory, "unsupported-tool", events);
      try {
        await expect(
          session.runTurn("call unknown tool"),
        ).resolves.toMatchObject({ status: "completed" });
        expect(
          events.some((event) => event.event === "unsupported_tool_call"),
        ).toBe(true);
      } finally {
        await session.close();
      }
    });
  });

  it("fails unattended user-input requests and interrupts the turn", async () => {
    await withTempDirectory(async (directory) => {
      const events: AgentEvent[] = [];
      const session = await startSession(directory, "user-input", events);
      try {
        await expect(session.runTurn("ask me something")).rejects.toMatchObject(
          {
            code: "turn_input_required",
          },
        );
        expect(
          events.some((event) => event.event === "turn_input_required"),
        ).toBe(true);
      } finally {
        await session.close();
      }
    });
  });

  it("enforces startup response and active-turn silence timeouts", async () => {
    await withTempDirectory(async (directory) => {
      await expect(
        startSession(directory, "read-timeout", [], { readTimeoutMs: 25 }),
      ).rejects.toMatchObject({ code: "response_timeout" });

      const session = await startSession(directory, "stall", [], {
        turnTimeoutMs: 30,
      });
      try {
        await expect(session.runTurn("stall")).rejects.toMatchObject({
          code: "turn_timeout",
        });
      } finally {
        await session.close();
      }
    });
  });

  it("resets the silence timeout on every app-server output message", async () => {
    await withTempDirectory(async (directory) => {
      const session = await startSession(directory, "heartbeat", [], {
        turnTimeoutMs: 35,
      });
      try {
        await expect(session.runTurn("keep alive")).resolves.toMatchObject({
          status: "completed",
        });
      } finally {
        await session.close();
      }
    });
  });

  it.each([
    ["failed", "turn_failed"],
    ["interrupted", "turn_cancelled"],
    ["exit", "port_exit"],
    ["malformed", "malformed_message"],
  ])("maps %s termination to %s", async (scenario, code) => {
    await withTempDirectory(async (directory) => {
      const session = await startSession(directory, scenario, []);
      try {
        await expect(session.runTurn(scenario)).rejects.toMatchObject({ code });
      } finally {
        await session.close();
      }
    });
  });

  it("rejects an oversized protocol line", async () => {
    await withTempDirectory(async (directory) => {
      const events: AgentEvent[] = [];
      const session = await startSession(directory, "large-line", events, {
        maxLineBytes: 512,
      });
      try {
        await expect(session.runTurn("large line")).rejects.toMatchObject({
          code: "line_too_large",
        });
        expect(events.some((event) => event.event === "malformed")).toBe(true);
      } finally {
        await session.close();
      }
    });
  });

  it("maps missing commands and invalid workspaces before a turn can start", async () => {
    await withTempDirectory(async (directory) => {
      await expect(
        CodexAppServerSession.start({
          command: "definitely-not-a-real-codex-command",
          cwd: directory,
          environment: { PATH: process.env["PATH"] },
          readTimeoutMs: 500,
          turnTimeoutMs: 500,
        }),
      ).rejects.toMatchObject({ code: "codex_not_found" });

      await expect(
        CodexAppServerSession.start({
          command: fakeCommand(),
          cwd: `${directory}/missing`,
          environment: environment("normal"),
          readTimeoutMs: 500,
          turnTimeoutMs: 500,
        }),
      ).rejects.toMatchObject({ code: "invalid_workspace_cwd" });
    });
  });
});
