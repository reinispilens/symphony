import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  CodexAppServerSessionOptions,
  CodexTurnResult,
} from "../../src/agent/app-server-client.js";
import { AgentError } from "../../src/agent/errors.js";
import { AgentRunner, type LiveCodexSession } from "../../src/agent/runner.js";
import type { AgentToolRuntime } from "../../src/agent/tools.js";
import type { Issue } from "../../src/domain/issue.js";
import type { TrackerAdapter } from "../../src/tracker/adapter.js";
import type { ServiceConfig } from "../../src/workflow/config.js";
import type { WorkflowSnapshot } from "../../src/workflow/store.js";
import { issue, withTempDirectory } from "../support/factories.js";

function workflow(
  directory: string,
  overrides: {
    readonly beforeRun?: string | null;
    readonly afterRun?: string | null;
    readonly freshAttempt?: boolean;
    readonly maxTurns?: number;
  } = {},
): WorkflowSnapshot {
  const config: ServiceConfig = {
    deployment: null,
    tracker: {
      kind: "test",
      provider: {},
      activeStates: ["Todo", "In Progress", "Rework"],
      terminalStates: ["Done"],
      freshAttemptStates: overrides.freshAttempt === true ? ["Rework"] : [],
      freshAttemptFailureState:
        overrides.freshAttempt === true ? "Human Review" : null,
      requiredLabels: ["ready"],
      excludedLabels: ["driver:direct"],
      secretEnvironmentNames: ["TEST_TRACKER_TOKEN"],
    },
    repository: null,
    preparation: {
      driver: "none",
      frozenLockfile: true,
      lifecycleScripts: false,
      timeoutMs: 300_000,
    },
    polling: { intervalMs: 30_000 },
    workspace: {
      provider: "directory",
      root: path.join(directory, "workspaces"),
    },
    hooks: {
      afterCreate: null,
      beforeRun: overrides.beforeRun ?? null,
      afterRun: overrides.afterRun ?? null,
      beforeRemove: null,
      timeoutMs: 1_000,
    },
    agent: {
      maxConcurrentAgents: 1,
      maxTurns: overrides.maxTurns ?? 3,
      maxRetryBackoffMs: 300_000,
      maxConcurrentAgentsByState: new Map(),
    },
    codex: {
      command: "fake app-server",
      approvalPolicy: null,
      threadSandbox: null,
      turnSandboxPolicy: null,
      readTimeoutMs: 100,
      turnTimeoutMs: 100,
      stallTimeoutMs: 1_000,
    },
  };
  return {
    config,
    definition: {
      config: {},
      promptTemplate:
        "Work on {{ issue.identifier }}: {{ issue.title }} (attempt={{ attempt }})",
    },
    loadedAt: new Date("2026-08-23T10:00:00Z"),
    path: path.join(directory, "WORKFLOW.md"),
    sourceHash: "hash-1",
  };
}

function turnResult(number: number): CodexTurnResult {
  return {
    status: "completed",
    threadId: "thread-1",
    turnId: `turn-${number}`,
    sessionId: `thread-1-turn-${number}`,
    usage: null,
    rateLimits: null,
  };
}

class FakeSession implements LiveCodexSession {
  readonly pid = 123;
  readonly threadId = "thread-1";
  readonly prompts: string[] = [];
  closeCount = 0;
  failTurn = false;
  pendingUntilClosed = false;
  #pendingReject: ((error: AgentError) => void) | null = null;

  async runTurn(input: string): Promise<CodexTurnResult> {
    this.prompts.push(input);
    if (this.failTurn) {
      throw new AgentError("turn_failed", "fake failure");
    }
    if (this.pendingUntilClosed) {
      return new Promise<CodexTurnResult>((_resolve, reject) => {
        this.#pendingReject = reject;
      });
    }
    return turnResult(this.prompts.length);
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.#pendingReject?.(
      new AgentError("turn_cancelled", "fake session closed"),
    );
    this.#pendingReject = null;
  }
}

class FakeTracker implements TrackerAdapter {
  readonly refreshes: Issue[][];
  readonly toolRuntime: AgentToolRuntime | null;
  readonly requestedIds: string[][] = [];

  constructor(
    refreshes: Issue[][],
    toolRuntime: AgentToolRuntime | null = null,
  ) {
    this.refreshes = [...refreshes];
    this.toolRuntime = toolRuntime;
  }

  async fetchIssuesByStates(
    _stateNames: readonly string[],
  ): Promise<readonly Issue[]> {
    return [];
  }

  async fetchIssuesByIds(ids: readonly string[]): Promise<readonly Issue[]> {
    this.requestedIds.push([...ids]);
    return this.refreshes.shift() ?? [];
  }

  agentToolRuntime(): AgentToolRuntime {
    return (
      this.toolRuntime ?? {
        specs: [],
        execute: async () => ({
          success: false,
          error: { code: "unsupported_tool", message: "No fake tools" },
        }),
      }
    );
  }
}

describe("AgentRunner", () => {
  it("finishes fresh provisioning before Codex and does not reset a ready generation twice", async () => {
    await withTempDirectory(async (directory) => {
      const resetWorkpad = vi.fn(async () => undefined);
      const tracker: TrackerAdapter = {
        fetchIssuesByStates: async () => [],
        fetchIssuesByIds: async () => [
          issue({ state: "Human Review", dispatchable: false }),
        ],
        freshAttemptControl: () => ({
          resetWorkpad,
          refuse: vi.fn(async () => undefined),
        }),
      };
      const sessions: FakeSession[] = [];
      const runner = new AgentRunner({
        sessionFactory: async () => {
          const session = new FakeSession();
          sessions.push(session);
          return session;
        },
      });
      const snapshot = workflow(directory, { freshAttempt: true });
      const rework = issue({ state: "Rework" });

      const first = await runner.run({
        attempt: null,
        freshAttemptGeneration: "generation-1",
        issue: rework,
        tracker,
        workflow: snapshot,
      });
      await writeFile(
        path.join(first.workspace.path, "new-attempt-marker"),
        "keep",
        "utf8",
      );
      const second = await runner.run({
        attempt: 1,
        freshAttemptGeneration: "generation-1",
        issue: rework,
        tracker,
        workflow: snapshot,
      });

      expect(resetWorkpad).toHaveBeenCalledTimes(1);
      expect(sessions).toHaveLength(2);
      expect(
        await readFile(
          path.join(second.workspace.path, "new-attempt-marker"),
          "utf8",
        ),
      ).toBe("keep");
    });
  });

  it("returns a typed refusal and never launches Codex when fresh setup fails", async () => {
    await withTempDirectory(async (directory) => {
      const sessionFactory = vi.fn(async () => new FakeSession());
      const tracker: TrackerAdapter = {
        fetchIssuesByStates: async () => [],
        fetchIssuesByIds: async () => [],
        freshAttemptControl: () => ({
          resetWorkpad: async () => {
            throw new Error("GitHub unavailable");
          },
          refuse: vi.fn(async () => undefined),
        }),
      };
      const runner = new AgentRunner({ sessionFactory });

      await expect(
        runner.run({
          attempt: null,
          freshAttemptGeneration: "generation-1",
          issue: issue({ state: "Rework" }),
          tracker,
          workflow: workflow(directory, { freshAttempt: true }),
        }),
      ).rejects.toMatchObject({
        code: "fresh_attempt_refused",
        message: expect.stringContaining("GitHub unavailable"),
      });
      expect(sessionFactory).not.toHaveBeenCalled();
    });
  });

  it("prepares once, uses a full first prompt, and continues on the same live session", async () => {
    await withTempDirectory(async (directory) => {
      const session = new FakeSession();
      const sessionOptions: CodexAppServerSessionOptions[] = [];
      const tools: AgentToolRuntime = {
        specs: [],
        execute: vi.fn(),
      };
      const tracker = new FakeTracker(
        [
          [issue({ state: "In Progress" })],
          [issue({ state: "Human Review", dispatchable: false })],
        ],
        tools,
      );
      const snapshot = workflow(directory, {
        beforeRun: 'printf "before:%s\\n" "$SYMPHONY_ATTEMPT" >> hooks.log',
        afterRun: 'printf "after:%s\\n" "$SYMPHONY_RUN_STATUS" >> hooks.log',
      });
      const runner = new AgentRunner({
        processEnvironment: {
          PATH: process.env["PATH"],
          TEST_TRACKER_TOKEN: "parent-only",
        },
        sessionFactory: async (options) => {
          sessionOptions.push(options);
          return session;
        },
      });

      const result = await runner.run({
        attempt: 2,
        freshAttemptGeneration: null,
        issue: issue(),
        tracker,
        workflow: snapshot,
      });

      expect(result).toMatchObject({
        turns: 2,
        finalIssue: { state: "Human Review" },
      });
      expect(session.prompts[0]).toBe(
        "Work on SYM-123: Build the safe foundation (attempt=2)",
      );
      expect(session.prompts[1]).toContain("continuation turn 2 of 3");
      expect(session.closeCount).toBe(1);
      expect(sessionOptions[0]).toMatchObject({
        adapterSecretEnvironmentNames: ["TEST_TRACKER_TOKEN"],
        command: "fake app-server",
        title: "SYM-123: Build the safe foundation",
        toolRuntime: tools,
      });
      expect(sessionOptions[0]?.cwd).toBe(result.workspace.path);
      expect(tracker.requestedIds).toEqual([["opaque-1"], ["opaque-1"]]);
      expect(
        await readFile(path.join(result.workspace.path, "hooks.log"), "utf8"),
      ).toBe("before:2\nafter:succeeded\n");
    });
  });

  it("stops at max_turns even when the refreshed issue remains active", async () => {
    await withTempDirectory(async (directory) => {
      const session = new FakeSession();
      const tracker = new FakeTracker([
        [issue({ state: "Todo" })],
        [issue({ state: "Todo" })],
      ]);
      const runner = new AgentRunner({
        sessionFactory: async () => session,
      });
      const result = await runner.run({
        attempt: null,
        freshAttemptGeneration: null,
        issue: issue(),
        tracker: {
          fetchIssuesByStates: (states) => tracker.fetchIssuesByStates(states),
          fetchIssuesByIds: (ids) => tracker.fetchIssuesByIds(ids),
        },
        workflow: workflow(directory, { maxTurns: 2 }),
      });

      expect(result.turns).toBe(2);
      expect(session.prompts).toHaveLength(2);
      expect(tracker.requestedIds).toHaveLength(2);
    });
  });

  it("stops before a continuation when an excluded label appears", async () => {
    await withTempDirectory(async (directory) => {
      const session = new FakeSession();
      const tracker = new FakeTracker([
        [issue({ labels: ["ready", "driver:direct"], state: "In Progress" })],
      ]);
      const runner = new AgentRunner({ sessionFactory: async () => session });

      const result = await runner.run({
        attempt: null,
        freshAttemptGeneration: null,
        issue: issue(),
        tracker: {
          fetchIssuesByStates: (states) => tracker.fetchIssuesByStates(states),
          fetchIssuesByIds: (ids) => tracker.fetchIssuesByIds(ids),
        },
        workflow: workflow(directory),
      });

      expect(result.turns).toBe(1);
      expect(session.prompts).toHaveLength(1);
      expect(result.finalIssue?.labels).toContain("driver:direct");
    });
  });

  it("closes the session and runs after_run after a failed turn", async () => {
    await withTempDirectory(async (directory) => {
      const session = new FakeSession();
      session.failTurn = true;
      const snapshot = workflow(directory, {
        afterRun: 'printf "%s\\n" "$SYMPHONY_RUN_STATUS" > after-run-status',
      });
      const runner = new AgentRunner({
        sessionFactory: async () => session,
      });
      const tracker: TrackerAdapter = {
        fetchIssuesByStates: async () => [],
        fetchIssuesByIds: async () => [],
      };

      await expect(
        runner.run({
          attempt: null,
          freshAttemptGeneration: null,
          issue: issue(),
          tracker,
          workflow: snapshot,
        }),
      ).rejects.toMatchObject({ code: "turn_failed" });
      expect(session.closeCount).toBe(1);
      expect(
        await readFile(
          path.join(
            snapshot.config.workspace.root,
            "SYM-123",
            "after-run-status",
          ),
          "utf8",
        ),
      ).toBe("failed\n");
    });
  });

  it("turns an AbortSignal into deterministic reconciliation cancellation", async () => {
    await withTempDirectory(async (directory) => {
      const session = new FakeSession();
      session.pendingUntilClosed = true;
      const controller = new AbortController();
      const runner = new AgentRunner({
        sessionFactory: async () => session,
      });
      const tracker: TrackerAdapter = {
        fetchIssuesByStates: async () => [],
        fetchIssuesByIds: async () => [],
      };
      const running = runner.run({
        attempt: null,
        freshAttemptGeneration: null,
        issue: issue(),
        signal: controller.signal,
        tracker,
        workflow: workflow(directory),
      });

      while (session.prompts.length === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      controller.abort();
      await expect(running).rejects.toMatchObject({ code: "turn_cancelled" });
      expect(session.closeCount).toBeGreaterThanOrEqual(1);
    });
  });
});
