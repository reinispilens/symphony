import { describe, expect, it, vi } from "vitest";

import type { AgentEvent } from "../../src/agent/events.js";
import { AgentError } from "../../src/agent/errors.js";
import type {
  AgentRunOptions,
  AgentRunResult,
} from "../../src/agent/runner.js";
import type { Issue } from "../../src/domain/issue.js";
import { SymphonyError } from "../../src/errors.js";
import type { Logger } from "../../src/observability/logger.js";
import type { RepositoryCleanupAuthority } from "../../src/repository/driver.js";
import { SqliteSymphonyStateStore } from "../../src/state/sqlite-store.js";
import type {
  OrchestratorClock,
  TimerHandle,
} from "../../src/orchestrator/clock.js";
import {
  Orchestrator,
  type AgentExecutionPort,
  type WorkflowSource,
} from "../../src/orchestrator/orchestrator.js";
import type {
  FreshAttemptControl,
  TrackerAdapter,
} from "../../src/tracker/adapter.js";
import type { ServiceConfig } from "../../src/workflow/config.js";
import type { WorkflowSnapshot } from "../../src/workflow/store.js";
import { issue, withTempDirectory } from "../support/factories.js";

const START_MS = Date.parse("2026-08-23T10:00:00Z");

class FakeClock implements OrchestratorClock {
  now = START_MS;
  #nextId = 1;
  readonly #timers = new Map<
    number,
    { readonly callback: () => void; readonly dueAt: number }
  >();

  nowMs(): number {
    return this.now;
  }

  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    const id = this.#nextId++;
    this.#timers.set(id, { callback, dueAt: this.now + delayMs });
    return id as unknown as TimerHandle;
  }

  clearTimeout(handle: TimerHandle): void {
    this.#timers.delete(handle as unknown as number);
  }

  advance(delayMs: number): void {
    this.now += delayMs;
    const due = [...this.#timers.entries()]
      .filter(([, timer]) => timer.dueAt <= this.now)
      .sort((left, right) => left[1].dueAt - right[1].dueAt);
    for (const [id, timer] of due) {
      this.#timers.delete(id);
      timer.callback();
    }
  }
}

type FakeResponse<T> = T | Error;

class FakeTracker implements TrackerAdapter {
  readonly idCalls: string[][] = [];
  readonly stateCalls: string[][] = [];
  readonly #idResponses: FakeResponse<readonly Issue[]>[];
  readonly #stateResponses: FakeResponse<readonly Issue[]>[];
  readonly #freshControl: FreshAttemptControl | null;

  constructor(options: {
    readonly idResponses?: FakeResponse<readonly Issue[]>[];
    readonly stateResponses?: FakeResponse<readonly Issue[]>[];
    readonly freshControl?: FreshAttemptControl;
  }) {
    this.#idResponses = [...(options.idResponses ?? [])];
    this.#stateResponses = [...(options.stateResponses ?? [])];
    this.#freshControl = options.freshControl ?? null;
  }

  async fetchIssuesByStates(
    states: readonly string[],
  ): Promise<readonly Issue[]> {
    this.stateCalls.push([...states]);
    const response = this.#stateResponses.shift() ?? [];
    if (response instanceof Error) throw response;
    return response;
  }

  async fetchIssuesByIds(ids: readonly string[]): Promise<readonly Issue[]> {
    this.idCalls.push([...ids]);
    const response = this.#idResponses.shift() ?? [];
    if (response instanceof Error) throw response;
    return response;
  }

  freshAttemptControl(): FreshAttemptControl {
    if (this.#freshControl === null) throw new Error("No fake fresh control");
    return this.#freshControl;
  }
}

interface PendingRun {
  readonly options: AgentRunOptions;
  readonly reject: (error: unknown) => void;
  readonly resolve: (result: AgentRunResult) => void;
  settled: boolean;
}

class FakeAgentRunner implements AgentExecutionPort {
  readonly cleanups: Array<{ issue: Issue; workflow: WorkflowSnapshot }> = [];
  readonly cleanupErrors: Error[] = [];
  readonly quiescenceChecks: Array<{
    workflow: WorkflowSnapshot;
    authority: RepositoryCleanupAuthority | undefined;
  }> = [];
  readonly quiescenceErrors: Error[] = [];
  readonly runs: PendingRun[] = [];
  autoRejectOnAbort = true;
  quiescenceFailure: Error | null = null;
  onQuiesce: (() => void) | null = null;

  async cleanupWorkspace(
    cleanedIssue: Issue,
    workflow: WorkflowSnapshot,
  ): Promise<void> {
    this.cleanups.push({ issue: cleanedIssue, workflow });
    const error = this.cleanupErrors.shift();
    if (error !== undefined) throw error;
  }

  async quiesceRuntime(
    workflow: WorkflowSnapshot,
    authority?: RepositoryCleanupAuthority,
  ): Promise<void> {
    this.quiescenceChecks.push({ workflow, authority });
    this.onQuiesce?.();
    if (this.quiescenceFailure !== null) throw this.quiescenceFailure;
    const error = this.quiescenceErrors.shift();
    if (error !== undefined) throw error;
  }

  run(options: AgentRunOptions): Promise<AgentRunResult> {
    return new Promise((resolve, reject) => {
      const pending: PendingRun = {
        options,
        reject,
        resolve,
        settled: false,
      };
      this.runs.push(pending);
      if (this.autoRejectOnAbort) {
        options.signal?.addEventListener(
          "abort",
          () => {
            if (pending.settled) return;
            pending.settled = true;
            reject(new AgentError("turn_cancelled", "fake abort"));
          },
          { once: true },
        );
      }
    });
  }

  resolve(index: number, finalIssue: Issue | null): void {
    const pending = this.runs[index];
    if (pending === undefined || pending.settled)
      throw new Error("run not pending");
    pending.settled = true;
    pending.resolve({
      finalIssue,
      turns: 1,
      workspace: {
        createdNow: true,
        path: `/workspaces/${pending.options.issue.identifier}`,
        workspaceKey: pending.options.issue.identifier,
      },
      lastTurn: {
        status: "completed",
        threadId: `thread-${index}`,
        turnId: `turn-${index}`,
        sessionId: `thread-${index}-turn-${index}`,
        usage: null,
        rateLimits: null,
      },
    });
  }

  reject(index: number, error: unknown): void {
    const pending = this.runs[index];
    if (pending === undefined || pending.settled)
      throw new Error("run not pending");
    pending.settled = true;
    pending.reject(error);
  }

  async emit(index: number, event: AgentEvent): Promise<void> {
    const handler = this.runs[index]?.options.onEvent;
    await handler?.(event);
  }
}

class FakeWorkflowSource implements WorkflowSource {
  current: WorkflowSnapshot;
  preflight: Awaited<ReturnType<WorkflowSource["checkForUpdates"]>> = {
    status: "unchanged",
  };
  watching = false;

  constructor(current: WorkflowSnapshot) {
    this.current = current;
  }

  startWatching(): void {
    this.watching = true;
  }

  async checkForUpdates(): Promise<
    Awaited<ReturnType<WorkflowSource["checkForUpdates"]>>
  > {
    return this.preflight;
  }

  close(): void {
    this.watching = false;
  }
}

function serviceConfig(
  overrides: {
    readonly maxConcurrent?: number;
    readonly maxRetryBackoffMs?: number;
    readonly perState?: ReadonlyMap<string, number>;
    readonly stallTimeoutMs?: number;
    readonly freshAttempt?: boolean;
  } = {},
): ServiceConfig {
  return {
    deployment: null,
    tracker: {
      kind: "test",
      provider: {},
      activeStates:
        overrides.freshAttempt === true
          ? ["Todo", "In Progress", "Rework"]
          : ["Todo", "In Progress"],
      terminalStates: ["Done", "Cancelled"],
      freshAttemptStates: overrides.freshAttempt === true ? ["Rework"] : [],
      freshAttemptFailureState:
        overrides.freshAttempt === true ? "Human Review" : null,
      requiredLabels: ["ready"],
      excludedLabels: ["blocked"],
      secretEnvironmentNames: [],
    },
    repository: null,
    preparation: {
      driver: "none",
      frozenLockfile: true,
      lifecycleScripts: false,
      timeoutMs: 300_000,
    },
    polling: { intervalMs: 1_000_000 },
    workspace: { provider: "directory", root: "/workspaces" },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 60_000,
    },
    agent: {
      maxConcurrentAgents: overrides.maxConcurrent ?? 1,
      maxTurns: 3,
      maxRetryBackoffMs: overrides.maxRetryBackoffMs ?? 300_000,
      maxConcurrentAgentsByState: overrides.perState ?? new Map(),
    },
    codex: {
      command: "fake",
      approvalPolicy: null,
      threadSandbox: null,
      turnSandboxPolicy: null,
      readTimeoutMs: 100,
      turnTimeoutMs: 100,
      stallTimeoutMs: overrides.stallTimeoutMs ?? 300_000,
    },
  };
}

function workflow(config = serviceConfig()): WorkflowSnapshot {
  return {
    config,
    definition: { config: {}, promptTemplate: "Do the work" },
    loadedAt: new Date(START_MS),
    path: "/repo/WORKFLOW.md",
    sourceHash: "workflow-1",
  };
}

function logger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function task(identifier: string, overrides: Partial<Issue> = {}): Issue {
  return issue({
    id: `id-${identifier}`,
    identifier,
    labels: ["ready"],
    state: "Todo",
    ...overrides,
  });
}

async function settle(orchestrator: Orchestrator): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await orchestrator.whenIdle();
  await new Promise((resolve) => setImmediate(resolve));
  await orchestrator.whenIdle();
}

function createHarness(options: {
  readonly config?: ServiceConfig;
  readonly stateStore?: SqliteSymphonyStateStore;
  readonly tracker: FakeTracker;
}) {
  const clock = new FakeClock();
  const agentRunner = new FakeAgentRunner();
  const stateStore =
    options.stateStore ?? SqliteSymphonyStateStore.openInMemory();
  const workflowSource = new FakeWorkflowSource(workflow(options.config));
  const orchestrator = new Orchestrator({
    agentRunner,
    clock,
    logger: logger(),
    stateStore,
    trackerFactory: () => options.tracker,
    workflowStore: workflowSource,
  });
  return { agentRunner, clock, orchestrator, stateStore, workflowSource };
}

function seedExpiredRuntimeLease(
  stateStore: SqliteSymphonyStateStore,
  active: Issue,
) {
  const repositoryIdentity = "workflow:/repo/WORKFLOW.md";
  const session = stateStore.getOrCreateTrackerSession({
    trackerKind: "test",
    repositoryIdentity,
    issueId: active.id,
    issueIdentifier: active.identifier,
    issueUrl: active.url,
    intent: active.title,
    controllerId: `tracker:test:${repositoryIdentity}`,
    doctrine: null,
    configuration: null,
    now: new Date(START_MS - 3_000).toISOString(),
  });
  const started = stateStore.startAttempt({
    sessionId: session.id,
    controllerGeneration: session.controller.generation,
    holderId: "departed-daemon",
    trackerAttempt: null,
    freshAttemptGeneration: null,
    now: new Date(START_MS - 2_000).toISOString(),
    leaseExpiresAt: new Date(START_MS - 1_000).toISOString(),
  });
  return { session, started };
}

describe("Orchestrator", () => {
  it("proves an expired runtime quiescent before releasing its lease and redispatching", async () => {
    const active = task("EXPIRED-QUIESCENT");
    const stateStore = SqliteSymphonyStateStore.openInMemory();
    const { session, started } = seedExpiredRuntimeLease(stateStore, active);
    const harness = createHarness({
      stateStore,
      tracker: new FakeTracker({ stateResponses: [[], [active]] }),
    });
    harness.agentRunner.onQuiesce = () => {
      expect(
        stateStore.getSession(session.id)?.attempts[0]?.runtimeLease.status,
      ).toBe("active");
    };

    await harness.orchestrator.start();
    await settle(harness.orchestrator);

    expect(harness.agentRunner.quiescenceChecks).toEqual([
      {
        workflow: harness.workflowSource.current,
        authority: {
          workSessionId: session.id,
          controllerGeneration: session.controller.generation,
        },
      },
    ]);
    expect(stateStore.getSession(session.id)?.attempts).toMatchObject([
      {
        id: started.attemptId,
        status: "interrupted",
        runtimeLease: { status: "expired" },
      },
      { status: "running", runtimeLease: { status: "active" } },
    ]);
    expect(harness.agentRunner.runs).toHaveLength(1);
    await harness.orchestrator.stop();
  });

  it("retains an expired lease and blocks dispatch when runtime quiescence is unproven", async () => {
    const active = task("EXPIRED-STILL-LIVE");
    const stateStore = SqliteSymphonyStateStore.openInMemory();
    const { session, started } = seedExpiredRuntimeLease(stateStore, active);
    const harness = createHarness({
      stateStore,
      tracker: new FakeTracker({ stateResponses: [[], [active]] }),
    });
    harness.agentRunner.quiescenceFailure = new SymphonyError(
      "runtime_quiescence_refused",
      "descendant still alive",
    );

    await harness.orchestrator.start();
    await settle(harness.orchestrator);

    expect(harness.agentRunner.quiescenceChecks).toHaveLength(2);
    expect(harness.agentRunner.runs).toHaveLength(0);
    expect(stateStore.getSession(session.id)?.attempts).toMatchObject([
      {
        id: started.attemptId,
        status: "running",
        runtimeLease: { status: "active" },
      },
    ]);
    await harness.orchestrator.stop();
  });

  it("retains the active lease when worker finalization cannot prove quiescence", async () => {
    const active = task("FINALIZATION-STILL-LIVE");
    const harness = createHarness({
      tracker: new FakeTracker({ stateResponses: [[], [active]] }),
    });
    await harness.orchestrator.start();
    await settle(harness.orchestrator);
    const session = harness.stateStore.getTrackerSession(
      "test",
      "workflow:/repo/WORKFLOW.md",
      active.id,
    );

    harness.agentRunner.reject(
      0,
      new SymphonyError("runtime_quiescence_refused", "descendant still alive"),
    );
    await settle(harness.orchestrator);

    expect(harness.orchestrator.snapshot().counts).toEqual({
      running: 0,
      retrying: 0,
    });
    expect(harness.stateStore.getSession(session!.id)?.attempts).toMatchObject([
      { status: "running", runtimeLease: { status: "active" } },
    ]);
    await harness.orchestrator.stop();
  });

  it("hands a refused fresh attempt to humans without launching a retry", async () => {
    const rework = task("REWORK-REFUSED", { state: "Rework" });
    const refuse = vi.fn(async () => undefined);
    const tracker = new FakeTracker({
      stateResponses: [[], [rework]],
      freshControl: { resetWorkpad: vi.fn(), refuse },
    });
    const harness = createHarness({
      config: serviceConfig({ freshAttempt: true }),
      tracker,
    });
    await harness.orchestrator.start();
    await settle(harness.orchestrator);

    expect(harness.agentRunner.runs[0]?.options.freshAttemptGeneration).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    harness.agentRunner.reject(
      0,
      new AgentError("fresh_attempt_refused", "fresh branch was not safe"),
    );
    await settle(harness.orchestrator);

    expect(refuse).toHaveBeenCalledWith(
      "fresh branch was not safe",
      "Human Review",
    );
    expect(harness.agentRunner.runs).toHaveLength(1);
    expect(harness.orchestrator.snapshot().counts).toEqual({
      running: 0,
      retrying: 0,
    });
    await harness.orchestrator.stop();
  });

  it("retries only the human handoff when its first tracker mutation fails", async () => {
    const rework = task("REWORK-HANDOFF-RETRY", { state: "Rework" });
    const refuse = vi
      .fn<FreshAttemptControl["refuse"]>()
      .mockRejectedValueOnce(new Error("temporary GitHub failure"))
      .mockResolvedValueOnce(undefined);
    const tracker = new FakeTracker({
      stateResponses: [[], [rework]],
      idResponses: [[rework]],
      freshControl: { resetWorkpad: vi.fn(), refuse },
    });
    const harness = createHarness({
      config: serviceConfig({ freshAttempt: true }),
      tracker,
    });
    await harness.orchestrator.start();
    await settle(harness.orchestrator);
    harness.agentRunner.reject(
      0,
      new AgentError("fresh_attempt_refused", "old workspace retained"),
    );
    await settle(harness.orchestrator);
    expect(harness.orchestrator.snapshot().retrying[0]).toMatchObject({
      kind: "fresh_handoff",
      error: "old workspace retained",
    });
    expect(harness.stateStore.listPendingEffects()).toHaveLength(1);

    harness.clock.advance(10_000);
    await settle(harness.orchestrator);
    expect(refuse).toHaveBeenCalledTimes(2);
    expect(harness.stateStore.listPendingEffects()).toHaveLength(0);
    expect(harness.agentRunner.runs).toHaveLength(1);
    expect(harness.orchestrator.snapshot().counts).toEqual({
      running: 0,
      retrying: 0,
    });
    await harness.orchestrator.stop();
  });

  it("invalidates an ordinary retry when the Rework state generation changes", async () => {
    const first = task("REWORK-NEW-GENERATION", {
      state: "Rework",
      state_version: "state-entry-1",
    });
    const second = {
      ...first,
      state_version: "state-entry-2",
    };
    const tracker = new FakeTracker({
      stateResponses: [[], [first]],
      idResponses: [[second]],
    });
    const harness = createHarness({
      config: serviceConfig({ freshAttempt: true }),
      tracker,
    });
    await harness.orchestrator.start();
    await settle(harness.orchestrator);
    const firstGeneration =
      harness.agentRunner.runs[0]?.options.freshAttemptGeneration;
    harness.agentRunner.reject(0, new Error("ordinary execution failure"));
    await settle(harness.orchestrator);

    harness.clock.advance(10_000);
    await settle(harness.orchestrator);
    expect(harness.agentRunner.runs[1]?.options).toMatchObject({
      attempt: null,
      issue: { state_version: "state-entry-2" },
    });
    expect(
      harness.agentRunner.runs[1]?.options.freshAttemptGeneration,
    ).not.toBe(firstGeneration);
    await harness.orchestrator.stop();
  });

  it("keeps the proven fresh worker when it advances to another active state", async () => {
    const rework = task("REWORK-IN-PROGRESS", {
      state: "Rework",
      state_version: "rework-entry",
    });
    const inProgress = {
      ...rework,
      state: "In Progress",
      state_version: "in-progress-entry",
    };
    const tracker = new FakeTracker({
      stateResponses: [[], [rework], []],
      idResponses: [[inProgress]],
    });
    const harness = createHarness({
      config: serviceConfig({ freshAttempt: true }),
      tracker,
    });
    await harness.orchestrator.start();
    await settle(harness.orchestrator);

    await harness.orchestrator.tick();
    await settle(harness.orchestrator);

    expect(harness.agentRunner.runs).toHaveLength(1);
    expect(harness.agentRunner.runs[0]?.options.signal?.aborted).toBe(false);
    expect(harness.orchestrator.snapshot().running[0]?.state).toBe(
      "In Progress",
    );
    await harness.orchestrator.stop();
  });

  it("pauses dispatch while workflow preflight is invalid", async () => {
    const active = task("BLOCKED-BY-CONFIG");
    const tracker = new FakeTracker({
      stateResponses: [[], [active], [active]],
    });
    const harness = createHarness({ tracker });
    harness.workflowSource.preflight = {
      status: "rejected",
      error: new Error("invalid workflow edit"),
    };

    await harness.orchestrator.start();
    await settle(harness.orchestrator);
    expect(harness.agentRunner.runs).toHaveLength(0);
    expect(tracker.stateCalls).toEqual([
      ["Done", "Cancelled"],
      ["Todo", "In Progress", "Done", "Cancelled"],
    ]);

    harness.workflowSource.preflight = { status: "unchanged" };
    await harness.orchestrator.tick();
    await settle(harness.orchestrator);
    expect(harness.agentRunner.runs[0]?.options.issue.id).toBe(active.id);
    await harness.orchestrator.stop();
  });

  it("deduplicates concurrent graceful-stop requests", async () => {
    const active = task("SHUTDOWN");
    const tracker = new FakeTracker({ stateResponses: [[], [active]] });
    const harness = createHarness({ tracker });
    await harness.orchestrator.start();
    await settle(harness.orchestrator);

    const first = harness.orchestrator.stop();
    const second = harness.orchestrator.stop();
    expect(second).toBe(first);
    await first;
    expect(harness.workflowSource.watching).toBe(false);
    expect(harness.orchestrator.snapshot().counts).toEqual({
      running: 0,
      retrying: 0,
    });
  });

  it("cleans terminal workspaces, sorts candidates, and enforces global/per-state claims", async () => {
    const terminal = task("DONE-1", { state: "Done", dispatchable: false });
    const todoP2 = task("TODO-P2", { priority: 2 });
    const todoP1 = task("TODO-P1", { priority: 1 });
    const progressP1 = task("PROGRESS-P1", {
      priority: 1,
      state: "In Progress",
      created_at: new Date(START_MS + 1),
    });
    const unroutable = task("NO-LABEL", { labels: [] });
    const tracker = new FakeTracker({
      stateResponses: [
        [terminal],
        [terminal, todoP2, progressP1, unroutable, todoP1],
        [todoP1, progressP1],
      ],
      idResponses: [[todoP1, progressP1]],
    });
    const harness = createHarness({
      config: serviceConfig({
        maxConcurrent: 2,
        perState: new Map([["todo", 1]]),
      }),
      tracker,
    });

    await harness.orchestrator.start();
    await settle(harness.orchestrator);
    expect(harness.agentRunner.cleanups.map((entry) => entry.issue.id)).toEqual(
      [terminal.id],
    );
    expect(harness.agentRunner.runs.map((run) => run.options.issue.id)).toEqual(
      [todoP1.id, progressP1.id],
    );

    await harness.orchestrator.tick();
    await settle(harness.orchestrator);
    expect(harness.agentRunner.runs).toHaveLength(2);
    expect(harness.orchestrator.snapshot().counts).toEqual({
      running: 2,
      retrying: 0,
    });
    await harness.orchestrator.stop();
  });

  it("schedules a one-second continuation and redispatches attempt 1", async () => {
    const active = task("CONTINUE");
    const tracker = new FakeTracker({
      stateResponses: [[], [active]],
      idResponses: [[active]],
    });
    const harness = createHarness({ tracker });
    await harness.orchestrator.start();
    await settle(harness.orchestrator);

    const session = harness.stateStore.getTrackerSession(
      "test",
      "workflow:/repo/WORKFLOW.md",
      active.id,
    );
    expect(session).toMatchObject({
      origin: { kind: "tracker", issueId: active.id },
      attempts: [{ status: "running" }],
    });
    await harness.agentRunner.runs[0]?.options.onWorkspace?.({
      createdNow: true,
      path: "/workspaces/CONTINUE",
      workspaceKey: "CONTINUE",
    });
    await harness.agentRunner.emit(0, {
      event: "session_started",
      timestamp: new Date(START_MS).toISOString(),
      codex_app_server_pid: 4321,
      session_id: "codex-session-1",
      thread_id: "thread-1",
      turn_id: "turn-1",
    });

    harness.agentRunner.resolve(0, active);
    await settle(harness.orchestrator);
    expect(harness.stateStore.getSession(session!.id)).toMatchObject({
      attempts: [
        {
          status: "completed",
          workspaceLease: {
            mode: "legacy-directory",
            path: "/workspaces/CONTINUE",
          },
          runtimeCorrelation: {
            processId: 4321,
            sessionId: "codex-session-1",
          },
        },
      ],
      retry: { kind: "continuation", attempt: 1 },
    });
    expect(harness.orchestrator.snapshot().retrying).toEqual([
      expect.objectContaining({
        issue_id: active.id,
        attempt: 1,
        kind: "continuation",
        due_at: new Date(START_MS + 1_000).toISOString(),
      }),
    ]);

    harness.clock.advance(999);
    await settle(harness.orchestrator);
    expect(harness.agentRunner.runs).toHaveLength(1);
    harness.clock.advance(1);
    await settle(harness.orchestrator);
    expect(harness.agentRunner.runs[1]?.options.attempt).toBe(1);
    expect(harness.agentRunner.runs[1]?.options.issue.id).toBe(active.id);
    expect(harness.stateStore.getSession(session!.id)?.attempts).toHaveLength(
      2,
    );
    await harness.orchestrator.stop();
  });

  it("recovers a durable retry after daemon restart without a duplicate WorkSession", async () => {
    await withTempDirectory(async (directory) => {
      const active = task("RESTART-RETRY");
      const databasePath = `${directory}/state.sqlite`;
      const firstStore = SqliteSymphonyStateStore.open(databasePath);
      const first = createHarness({
        stateStore: firstStore,
        tracker: new FakeTracker({ stateResponses: [[], [active]] }),
      });
      await first.orchestrator.start();
      await settle(first.orchestrator);
      first.agentRunner.reject(0, new Error("transient provider failure"));
      await settle(first.orchestrator);
      const original = firstStore.getTrackerSession(
        "test",
        "workflow:/repo/WORKFLOW.md",
        active.id,
      );
      expect(original?.retry).toMatchObject({ kind: "failure", attempt: 1 });
      await first.orchestrator.stop();
      firstStore.close();

      const secondStore = SqliteSymphonyStateStore.open(databasePath);
      const second = createHarness({
        stateStore: secondStore,
        tracker: new FakeTracker({
          stateResponses: [[], [active], [active]],
        }),
      });
      await second.orchestrator.start();
      await settle(second.orchestrator);
      expect(second.agentRunner.runs).toHaveLength(0);
      expect(second.orchestrator.snapshot().retrying).toEqual([
        expect.objectContaining({
          issue_id: active.id,
          attempt: 1,
          kind: "failure",
        }),
      ]);

      second.clock.advance(10_000);
      await second.orchestrator.tick();
      await settle(second.orchestrator);
      expect(second.agentRunner.runs).toHaveLength(1);
      expect(second.agentRunner.runs[0]?.options.attempt).toBe(1);
      const recovered = secondStore.getTrackerSession(
        "test",
        "workflow:/repo/WORKFLOW.md",
        active.id,
      );
      expect(recovered?.id).toBe(original?.id);
      expect(recovered?.attempts).toHaveLength(2);
      await second.orchestrator.stop();
      secondStore.close();
    });
  });

  it("cleans a newly terminal workspace after its non-active continuation released the claim", async () => {
    const active = task("TERMINAL-AFTER-RELEASE");
    const humanReview = {
      ...active,
      state: "Human Review",
      dispatchable: false,
    };
    const cancelled = {
      ...humanReview,
      state: "Cancelled",
    };
    const tracker = new FakeTracker({
      stateResponses: [[], [active], [], [cancelled]],
      idResponses: [[humanReview]],
    });
    const harness = createHarness({ tracker });
    await harness.orchestrator.start();
    await settle(harness.orchestrator);

    harness.agentRunner.resolve(0, humanReview);
    await settle(harness.orchestrator);
    harness.clock.advance(1_000);
    await settle(harness.orchestrator);
    expect(harness.orchestrator.snapshot().counts).toEqual({
      running: 0,
      retrying: 0,
    });
    expect(harness.agentRunner.cleanups).toHaveLength(0);

    await harness.orchestrator.tick();
    await settle(harness.orchestrator);
    expect(harness.agentRunner.cleanups).toHaveLength(0);

    await harness.orchestrator.tick();
    await settle(harness.orchestrator);
    expect(
      harness.agentRunner.cleanups.map((entry) => ({
        id: entry.issue.id,
        state: entry.issue.state,
      })),
    ).toEqual([{ id: cancelled.id, state: "Cancelled" }]);
    expect(harness.agentRunner.runs).toHaveLength(1);
    await harness.orchestrator.stop();
  });

  it("uses capped exponential backoff after worker failure", async () => {
    const active = task("RETRY");
    const tracker = new FakeTracker({
      stateResponses: [[], [active]],
      idResponses: [[active]],
    });
    const harness = createHarness({
      config: serviceConfig({ maxRetryBackoffMs: 15_000 }),
      tracker,
    });
    await harness.orchestrator.start();
    await settle(harness.orchestrator);

    harness.agentRunner.reject(0, new Error("boom"));
    await settle(harness.orchestrator);
    expect(harness.orchestrator.snapshot().retrying[0]).toMatchObject({
      attempt: 1,
      error: "boom",
      kind: "failure",
      due_at: new Date(START_MS + 10_000).toISOString(),
    });

    harness.clock.advance(10_000);
    await settle(harness.orchestrator);
    expect(harness.agentRunner.runs[1]?.options.attempt).toBe(1);
    harness.agentRunner.reject(1, new Error("again"));
    await settle(harness.orchestrator);
    expect(harness.orchestrator.snapshot().retrying[0]).toMatchObject({
      attempt: 2,
      due_at: new Date(START_MS + 25_000).toISOString(),
    });
    await harness.orchestrator.stop();
  });

  it("cancels and cleans a running issue that becomes terminal", async () => {
    const active = task("TERMINAL");
    const done = { ...active, state: "Done", dispatchable: false };
    const tracker = new FakeTracker({
      stateResponses: [[], [active], [done]],
      idResponses: [[done]],
    });
    const harness = createHarness({ tracker });
    await harness.orchestrator.start();
    await settle(harness.orchestrator);

    await harness.orchestrator.tick();
    await settle(harness.orchestrator);
    expect(harness.agentRunner.runs[0]?.options.signal?.aborted).toBe(true);
    expect(
      harness.agentRunner.cleanups.map((entry) => entry.issue.state),
    ).toEqual(["Done"]);
    expect(harness.orchestrator.snapshot().counts).toEqual({
      running: 0,
      retrying: 0,
    });
    await harness.orchestrator.stop();
  });

  it("keeps the WorkSession active and retries a refused terminal cleanup", async () => {
    const active = task("TERMINAL-CLEANUP-RETRY");
    const done = { ...active, state: "Done", dispatchable: false };
    const tracker = new FakeTracker({
      stateResponses: [[], [active], [done], [done]],
      idResponses: [[done]],
    });
    const harness = createHarness({ tracker });
    harness.agentRunner.cleanupErrors.push(new Error("workspace is ambiguous"));
    await harness.orchestrator.start();
    await settle(harness.orchestrator);
    const session = harness.stateStore.getTrackerSession(
      "test",
      "workflow:/repo/WORKFLOW.md",
      active.id,
    );

    await harness.orchestrator.tick();
    await settle(harness.orchestrator);
    expect(harness.agentRunner.cleanups).toHaveLength(1);
    expect(harness.stateStore.getSession(session!.id)?.status).toBe("active");

    await harness.orchestrator.tick();
    await settle(harness.orchestrator);
    expect(harness.agentRunner.cleanups).toHaveLength(2);
    expect(harness.stateStore.getSession(session!.id)?.status).toBe(
      "completed",
    );
    await harness.orchestrator.stop();
  });

  it("releases a running issue when an excluded label appears", async () => {
    const active = task("DRIVER-CONFLICT");
    const conflicting = { ...active, labels: ["ready", "blocked"] };
    const tracker = new FakeTracker({
      stateResponses: [[], [active], [conflicting]],
      idResponses: [[conflicting]],
    });
    const harness = createHarness({ tracker });
    await harness.orchestrator.start();
    await settle(harness.orchestrator);

    await harness.orchestrator.tick();
    await settle(harness.orchestrator);
    expect(harness.agentRunner.runs[0]?.options.signal?.aborted).toBe(true);
    expect(harness.agentRunner.cleanups).toHaveLength(0);
    expect(harness.orchestrator.snapshot().counts).toEqual({
      running: 0,
      retrying: 0,
    });
    await harness.orchestrator.stop();
  });

  it("releases non-active work without cleanup and retries stalled work", async () => {
    const active = task("RECONCILE");
    const paused = { ...active, state: "Human Review", dispatchable: false };
    const nonActiveTracker = new FakeTracker({
      stateResponses: [[], [active], []],
      idResponses: [[paused]],
    });
    const nonActive = createHarness({ tracker: nonActiveTracker });
    await nonActive.orchestrator.start();
    await settle(nonActive.orchestrator);
    await nonActive.orchestrator.tick();
    await settle(nonActive.orchestrator);
    expect(nonActive.agentRunner.cleanups).toHaveLength(0);
    expect(nonActive.orchestrator.snapshot().counts).toEqual({
      running: 0,
      retrying: 0,
    });
    await nonActive.orchestrator.stop();

    const stalledTracker = new FakeTracker({
      stateResponses: [[], [active], []],
    });
    const stalled = createHarness({
      config: serviceConfig({ stallTimeoutMs: 1_000 }),
      tracker: stalledTracker,
    });
    await stalled.orchestrator.start();
    await settle(stalled.orchestrator);
    stalled.clock.advance(1_001);
    await stalled.orchestrator.tick();
    await settle(stalled.orchestrator);
    expect(stalled.agentRunner.runs[0]?.options.signal?.aborted).toBe(true);
    expect(stalled.orchestrator.snapshot().retrying[0]).toMatchObject({
      attempt: 1,
      kind: "failure",
      error: "no agent event for 1001ms",
    });
    await stalled.orchestrator.stop();
  });

  it("keeps workers after a failed refresh, applies a later active-state refresh, and releases missing work", async () => {
    const active = task("REFRESH");
    const progress = { ...active, state: "In Progress" };
    const tracker = new FakeTracker({
      stateResponses: [[], [active], [], []],
      idResponses: [new Error("tracker unavailable"), [progress], []],
    });
    const harness = createHarness({ tracker });
    await harness.orchestrator.start();
    await settle(harness.orchestrator);

    await harness.orchestrator.tick();
    await settle(harness.orchestrator);
    expect(harness.orchestrator.snapshot().running[0]?.state).toBe("Todo");
    expect(harness.agentRunner.runs[0]?.options.signal?.aborted).toBe(false);

    await harness.orchestrator.tick();
    await settle(harness.orchestrator);
    expect(harness.orchestrator.snapshot().running[0]?.state).toBe(
      "In Progress",
    );

    await harness.orchestrator.tick();
    await settle(harness.orchestrator);
    expect(harness.agentRunner.runs[0]?.options.signal?.aborted).toBe(true);
    expect(harness.agentRunner.cleanups).toHaveLength(0);
    expect(harness.orchestrator.snapshot().counts).toEqual({
      running: 0,
      retrying: 0,
    });
    await harness.orchestrator.stop();
  });

  it("requeues a due retry with an explicit reason while all slots are occupied", async () => {
    const retrying = task("RETRY-NO-SLOT");
    const occupying = task("OCCUPYING", { state: "In Progress" });
    const tracker = new FakeTracker({
      stateResponses: [[], [retrying], [occupying]],
      idResponses: [[retrying]],
    });
    const harness = createHarness({ tracker });
    await harness.orchestrator.start();
    await settle(harness.orchestrator);

    harness.agentRunner.reject(0, new Error("initial failure"));
    await settle(harness.orchestrator);
    await harness.orchestrator.tick();
    await settle(harness.orchestrator);
    expect(harness.agentRunner.runs[1]?.options.issue.id).toBe(occupying.id);

    harness.clock.advance(10_000);
    await settle(harness.orchestrator);
    expect(harness.orchestrator.snapshot().retrying[0]).toMatchObject({
      issue_id: retrying.id,
      attempt: 1,
      error: "no available orchestrator slots",
      kind: "failure",
    });
    expect(harness.agentRunner.runs).toHaveLength(2);
    await harness.orchestrator.stop();
  });

  it("aggregates absolute usage once and reports live plus ended runtime", async () => {
    const active = task("METRICS");
    const tracker = new FakeTracker({ stateResponses: [[], [active]] });
    const harness = createHarness({ tracker });
    await harness.orchestrator.start();
    await settle(harness.orchestrator);

    await harness.agentRunner.emit(0, {
      event: "session_started",
      timestamp: new Date(START_MS).toISOString(),
      codex_app_server_pid: 987,
      session_id: "thread-1-turn-1",
      thread_id: "thread-1",
      turn_id: "turn-1",
    });
    await harness.agentRunner.emit(0, {
      event: "usage",
      timestamp: new Date(START_MS).toISOString(),
      usage: { total: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
    });
    await harness.agentRunner.emit(0, {
      event: "usage",
      timestamp: new Date(START_MS).toISOString(),
      usage: { total: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
    });
    await harness.agentRunner.emit(0, {
      event: "usage",
      timestamp: new Date(START_MS).toISOString(),
      usage: { total: { inputTokens: 14, outputTokens: 9, totalTokens: 23 } },
    });
    await harness.agentRunner.emit(0, {
      event: "rate_limits",
      timestamp: new Date(START_MS).toISOString(),
      rate_limits: { limitId: "codex" },
    });
    harness.clock.advance(2_500);

    expect(harness.orchestrator.snapshot()).toMatchObject({
      codex_totals: {
        input_tokens: 14,
        output_tokens: 9,
        total_tokens: 23,
        seconds_running: 2.5,
      },
      rate_limits: { limitId: "codex" },
      running: [
        {
          pid: 987,
          session_id: "thread-1-turn-1",
          turn_count: 1,
          tokens: { input_tokens: 14, output_tokens: 9, total_tokens: 23 },
        },
      ],
    });

    harness.agentRunner.resolve(0, active);
    await settle(harness.orchestrator);
    expect(harness.orchestrator.snapshot().codex_totals.seconds_running).toBe(
      2.5,
    );
    await harness.orchestrator.stop();
  });
});
