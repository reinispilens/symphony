import type { AgentRunOptions, AgentRunResult } from "../agent/runner.js";
import { AgentError } from "../agent/errors.js";
import type { AgentEvent } from "../agent/events.js";
import type { Issue } from "../domain/issue.js";
import { errorMessage } from "../errors.js";
import { nullLogger, type Logger } from "../observability/logger.js";
import type { JsonValue } from "../shared/json.js";
import type { TrackerAdapter } from "../tracker/adapter.js";
import { freshAttemptGeneration } from "../workspace/fresh-attempt.js";
import type { ReloadResult, WorkflowSnapshot } from "../workflow/store.js";
import {
  compareIssuesForDispatch,
  failureRetryDelayMs,
  issueEligibleByConfig,
  issueRoutable,
  normalizedTrackerValue,
  stateIncluded,
} from "./eligibility.js";
import {
  systemClock,
  type OrchestratorClock,
  type TimerHandle,
} from "./clock.js";
import {
  absoluteTokenTotals,
  monotonicTokenTotals,
  tokenDelta,
  zeroTokenTotals,
  type TokenTotals,
} from "./token-accounting.js";

const CONTINUATION_DELAY_MS = 1_000;

type TerminationIntent = "released" | "stalled" | "stopping" | "terminal";
type RetryKind = "continuation" | "failure" | "fresh_handoff";

export interface AgentExecutionPort {
  cleanupWorkspace(issue: Issue, workflow: WorkflowSnapshot): Promise<void>;
  run(options: AgentRunOptions): Promise<AgentRunResult>;
}

export type TrackerAdapterFactory = (
  workflow: WorkflowSnapshot,
) => TrackerAdapter;

export interface WorkflowSource {
  readonly current: WorkflowSnapshot;
  checkForUpdates(): Promise<ReloadResult>;
  close(): void;
  startWatching(): void;
}

export interface OrchestratorOptions {
  readonly agentRunner: AgentExecutionPort;
  readonly trackerFactory: TrackerAdapterFactory;
  readonly workflowStore: WorkflowSource;
  readonly clock?: OrchestratorClock;
  readonly logger?: Logger;
}

interface RunningEntry {
  readonly abortController: AbortController;
  readonly attempt: number | null;
  readonly freshAttemptGeneration: string | null;
  readonly startedAtMs: number;
  readonly tracker: TrackerAdapter;
  readonly workflow: WorkflowSnapshot;
  issue: Issue;
  lastEvent: string | null;
  lastEventAtMs: number | null;
  lastMessage: string | null;
  lastTokens: TokenTotals;
  pid: number | null;
  seenTurnIds: Set<string>;
  sessionId: string | null;
  terminationError: string | null;
  terminationIntent: TerminationIntent | null;
  turnCount: number;
  worker: Promise<AgentRunResult> | null;
}

interface RetryEntry {
  readonly attempt: number;
  readonly dueAtMs: number;
  readonly error: string | null;
  readonly freshAttemptGeneration: string | null;
  readonly issue: Issue;
  readonly kind: RetryKind;
  readonly timer: TimerHandle;
  readonly workspaceWorkflow: WorkflowSnapshot;
}

interface MutableAggregateTotals {
  inputTokens: number;
  outputTokens: number;
  secondsEnded: number;
  totalTokens: number;
}

export interface RunningSnapshotRow {
  readonly attempt: number | null;
  readonly issue_id: string;
  readonly issue_identifier: string;
  readonly issue_url: string | null;
  readonly last_event: string | null;
  readonly last_event_at: string | null;
  readonly last_message: string | null;
  readonly pid: number | null;
  readonly session_id: string | null;
  readonly started_at: string;
  readonly state: string;
  readonly terminating: TerminationIntent | null;
  readonly tokens: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly total_tokens: number;
  };
  readonly turn_count: number;
}

export interface RetrySnapshotRow {
  readonly attempt: number;
  readonly due_at: string;
  readonly error: string | null;
  readonly issue_id: string;
  readonly issue_identifier: string;
  readonly issue_url: string | null;
  readonly kind: RetryKind;
}

export interface RuntimeSnapshot {
  readonly codex_totals: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly seconds_running: number;
    readonly total_tokens: number;
  };
  readonly counts: { readonly retrying: number; readonly running: number };
  readonly generated_at: string;
  readonly rate_limits: JsonValue | null;
  readonly retrying: readonly RetrySnapshotRow[];
  readonly running: readonly RunningSnapshotRow[];
}

function nextFailureAttempt(attempt: number | null): number {
  return attempt === null ? 1 : attempt + 1;
}

function generationForIssue(
  issue: Issue,
  workflow: WorkflowSnapshot,
): string | null {
  return stateIncluded(issue.state, workflow.config.tracker.freshAttemptStates)
    ? freshAttemptGeneration(issue)
    : null;
}

function issueInFreshAttemptState(
  issue: Issue,
  workflow: WorkflowSnapshot,
): boolean {
  return stateIncluded(issue.state, workflow.config.tracker.freshAttemptStates);
}

function isFreshAttemptRefusal(error: unknown): error is AgentError {
  return error instanceof AgentError && error.code === "fresh_attempt_refused";
}

function eventMessage(event: AgentEvent): string | null {
  for (const key of ["error", "message", "method", "error_code"] as const) {
    const value = event[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

function iso(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

/**
 * The single mutable authority for claims, workers, retries, and aggregates.
 * Long-running workers report back through a serialized mutation queue.
 */
export class Orchestrator {
  readonly #agentRunner: AgentExecutionPort;
  readonly #claimed = new Set<string>();
  readonly #clock: OrchestratorClock;
  readonly #logger: Logger;
  readonly #observedTerminalIssueIds = new Set<string>();
  readonly #retries = new Map<string, RetryEntry>();
  readonly #running = new Map<string, RunningEntry>();
  readonly #totals: MutableAggregateTotals = {
    inputTokens: 0,
    outputTokens: 0,
    secondsEnded: 0,
    totalTokens: 0,
  };
  readonly #trackerFactory: TrackerAdapterFactory;
  readonly #workflowStore: WorkflowSource;
  #authority: Promise<void> = Promise.resolve();
  #latestRateLimits: JsonValue | null = null;
  #pollTimer: TimerHandle | null = null;
  #started = false;
  #stopPromise: Promise<void> | null = null;
  #stopping = false;

  constructor(options: OrchestratorOptions) {
    this.#agentRunner = options.agentRunner;
    this.#clock = options.clock ?? systemClock;
    this.#logger = options.logger ?? nullLogger;
    this.#trackerFactory = options.trackerFactory;
    this.#workflowStore = options.workflowStore;
  }

  async start(): Promise<void> {
    await this.#enqueue(async () => {
      if (this.#started) return;
      this.#started = true;
      this.#stopping = false;
      try {
        this.#workflowStore.startWatching();
        await this.#startupCleanup();
        await this.#performTick();
        this.#schedulePoll();
      } catch (error) {
        this.#clearPollTimer();
        this.#workflowStore.close();
        this.#started = false;
        this.#stopping = false;
        throw error;
      }
    });
  }

  async tick(): Promise<void> {
    await this.#enqueue(async () => {
      if (!this.#started || this.#stopping) return;
      this.#clearPollTimer();
      await this.#performTick();
      this.#schedulePoll();
    });
  }

  stop(): Promise<void> {
    if (this.#stopPromise === null) {
      this.#stopPromise = this.#performStop().finally(() => {
        this.#stopPromise = null;
      });
    }
    return this.#stopPromise;
  }

  async #performStop(): Promise<void> {
    const workers = await this.#enqueue(() => {
      if (!this.#started || this.#stopping) return [];
      this.#stopping = true;
      this.#clearPollTimer();
      this.#workflowStore.close();

      for (const retry of this.#retries.values()) {
        this.#clock.clearTimeout(retry.timer);
        this.#claimed.delete(retry.issue.id);
      }
      this.#retries.clear();
      const activeWorkers: Promise<AgentRunResult>[] = [];
      for (const entry of this.#running.values()) {
        this.#terminate(entry, "stopping", "service shutdown");
        if (entry.worker !== null) activeWorkers.push(entry.worker);
      }
      return activeWorkers;
    });

    await Promise.allSettled(workers);
    await this.#enqueue(() => {
      this.#started = false;
      this.#stopping = false;
    });
  }

  async whenIdle(): Promise<void> {
    await this.#enqueue(() => undefined);
  }

  snapshot(): RuntimeSnapshot {
    const now = this.#clock.nowMs();
    const running = [...this.#running.values()].map((entry) => ({
      issue_id: entry.issue.id,
      issue_identifier: entry.issue.identifier,
      issue_url: entry.issue.url,
      state: entry.issue.state,
      session_id: entry.sessionId,
      pid: entry.pid,
      turn_count: entry.turnCount,
      last_event: entry.lastEvent,
      last_message: entry.lastMessage,
      started_at: iso(entry.startedAtMs),
      last_event_at:
        entry.lastEventAtMs === null ? null : iso(entry.lastEventAtMs),
      attempt: entry.attempt,
      terminating: entry.terminationIntent,
      tokens: {
        input_tokens: entry.lastTokens.inputTokens,
        output_tokens: entry.lastTokens.outputTokens,
        total_tokens: entry.lastTokens.totalTokens,
      },
    }));
    const retrying = [...this.#retries.values()]
      .sort((left, right) => left.dueAtMs - right.dueAtMs)
      .map((entry) => ({
        issue_id: entry.issue.id,
        issue_identifier: entry.issue.identifier,
        issue_url: entry.issue.url,
        attempt: entry.attempt,
        due_at: iso(entry.dueAtMs),
        error: entry.error,
        kind: entry.kind,
      }));
    const activeSeconds = [...this.#running.values()].reduce(
      (sum, entry) => sum + Math.max(now - entry.startedAtMs, 0) / 1_000,
      0,
    );
    return {
      generated_at: iso(now),
      counts: { running: running.length, retrying: retrying.length },
      running,
      retrying,
      codex_totals: {
        input_tokens: this.#totals.inputTokens,
        output_tokens: this.#totals.outputTokens,
        total_tokens: this.#totals.totalTokens,
        seconds_running: this.#totals.secondsEnded + activeSeconds,
      },
      rate_limits: this.#latestRateLimits,
    };
  }

  async #performTick(): Promise<void> {
    await this.#reconcileRunning();
    let dispatchAllowed = true;
    try {
      const preflight = await this.#workflowStore.checkForUpdates();
      if (preflight.status === "rejected") {
        dispatchAllowed = false;
        this.#logger.error("dispatch outcome=skipped reason=workflow_invalid", {
          error: errorMessage(preflight.error),
          workflow_path: this.#workflowStore.current.path,
        });
      }
    } catch (error) {
      dispatchAllowed = false;
      this.#logger.error("dispatch outcome=skipped reason=workflow_preflight", {
        error: errorMessage(error),
      });
    }
    const workflow = this.#workflowStore.current;
    let tracker: TrackerAdapter;
    try {
      tracker = this.#trackerFactory(workflow);
    } catch (error) {
      this.#logger.error("dispatch outcome=skipped reason=tracker_factory", {
        error: errorMessage(error),
        workflow_path: workflow.path,
      });
      return;
    }

    let observedIssues: readonly Issue[];
    try {
      observedIssues = await tracker.fetchIssuesByStates([
        ...workflow.config.tracker.activeStates,
        ...workflow.config.tracker.terminalStates,
      ]);
    } catch (error) {
      this.#logger.error("dispatch outcome=skipped reason=tracker_fetch", {
        error: errorMessage(error),
      });
      return;
    }

    await this.#reconcileTerminalWorkspaces(observedIssues, workflow);
    if (!dispatchAllowed) return;

    for (const issue of [...observedIssues].sort(compareIssuesForDispatch)) {
      if (!this.#hasGlobalSlot(workflow)) break;
      if (!this.#shouldDispatch(issue, workflow)) continue;
      if (!this.#hasStateSlot(issue, workflow)) continue;
      this.#dispatch(
        issue,
        null,
        generationForIssue(issue, workflow),
        tracker,
        workflow,
      );
    }
  }

  async #startupCleanup(): Promise<void> {
    const workflow = this.#workflowStore.current;
    this.#observedTerminalIssueIds.clear();
    try {
      const tracker = this.#trackerFactory(workflow);
      const terminalIssues = await tracker.fetchIssuesByStates(
        workflow.config.tracker.terminalStates,
      );
      await this.#reconcileTerminalWorkspaces(
        terminalIssues,
        workflow,
        "startup_terminal",
      );
    } catch (error) {
      this.#logger.warn(
        "workspace_cleanup outcome=skipped reason=startup_fetch",
        {
          error: errorMessage(error),
        },
      );
    }
  }

  async #reconcileTerminalWorkspaces(
    issues: readonly Issue[],
    workflow: WorkflowSnapshot,
    reason = "poll_terminal",
  ): Promise<void> {
    const terminalIssueIds = new Set<string>();
    for (const issue of issues) {
      if (!stateIncluded(issue.state, workflow.config.tracker.terminalStates)) {
        continue;
      }
      terminalIssueIds.add(issue.id);
      if (
        this.#observedTerminalIssueIds.has(issue.id) ||
        this.#claimed.has(issue.id)
      ) {
        continue;
      }
      await this.#cleanupWorkspace(issue, workflow, reason);
    }

    this.#observedTerminalIssueIds.clear();
    for (const issueId of terminalIssueIds) {
      this.#observedTerminalIssueIds.add(issueId);
    }
  }

  async #reconcileRunning(): Promise<void> {
    if (this.#running.size === 0) return;
    const workflow = this.#workflowStore.current;
    const stallTimeoutMs = workflow.config.codex.stallTimeoutMs;
    const now = this.#clock.nowMs();

    if (stallTimeoutMs > 0) {
      for (const entry of this.#running.values()) {
        if (entry.terminationIntent !== null) continue;
        const lastActivity = entry.lastEventAtMs ?? entry.startedAtMs;
        if (now - lastActivity > stallTimeoutMs) {
          this.#terminate(
            entry,
            "stalled",
            `no agent event for ${now - lastActivity}ms`,
          );
        }
      }
    }

    const groups = new Map<TrackerAdapter, RunningEntry[]>();
    for (const entry of this.#running.values()) {
      if (entry.terminationIntent !== null) continue;
      const group = groups.get(entry.tracker) ?? [];
      group.push(entry);
      groups.set(entry.tracker, group);
    }

    await Promise.all(
      [...groups.entries()].map(async ([tracker, entries]) => {
        let refreshed: readonly Issue[];
        try {
          refreshed = await tracker.fetchIssuesByIds(
            entries.map((entry) => entry.issue.id),
          );
        } catch (error) {
          this.#logger.debug(
            "reconcile outcome=deferred reason=tracker_fetch_failed",
            { error: errorMessage(error), issue_count: entries.length },
          );
          return;
        }

        const byId = new Map(refreshed.map((issue) => [issue.id, issue]));
        for (const entry of entries) {
          const issue = byId.get(entry.issue.id);
          if (issue === undefined) {
            this.#terminate(entry, "released", "issue no longer visible");
          } else if (
            stateIncluded(issue.state, workflow.config.tracker.terminalStates)
          ) {
            entry.issue = issue;
            this.#terminate(entry, "terminal", `terminal state ${issue.state}`);
          } else if (
            stateIncluded(issue.state, workflow.config.tracker.activeStates) &&
            issueRoutable(
              issue,
              workflow.config.tracker.requiredLabels,
              workflow.config.tracker.excludedLabels,
            )
          ) {
            const remainsFresh = issueInFreshAttemptState(issue, workflow);
            const generation = generationForIssue(issue, workflow);
            entry.issue = issue;
            if (remainsFresh && generation !== entry.freshAttemptGeneration) {
              this.#terminate(
                entry,
                "released",
                "fresh-attempt state generation changed",
              );
            }
          } else {
            entry.issue = issue;
            this.#terminate(
              entry,
              "released",
              `non-active or unroutable state ${issue.state}`,
            );
          }
        }
      }),
    );
  }

  #dispatch(
    issue: Issue,
    attempt: number | null,
    freshGeneration: string | null,
    tracker: TrackerAdapter,
    workflow: WorkflowSnapshot,
  ): void {
    const abortController = new AbortController();
    const entry: RunningEntry = {
      abortController,
      attempt,
      freshAttemptGeneration: freshGeneration,
      issue,
      lastEvent: null,
      lastEventAtMs: null,
      lastMessage: null,
      lastTokens: zeroTokenTotals(),
      pid: null,
      seenTurnIds: new Set(),
      sessionId: null,
      startedAtMs: this.#clock.nowMs(),
      terminationError: null,
      terminationIntent: null,
      tracker,
      turnCount: 0,
      worker: null,
      workflow,
    };
    this.#claimed.add(issue.id);
    this.#cancelRetry(issue.id);
    this.#running.set(issue.id, entry);
    this.#logger.info("dispatch outcome=started", {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      attempt,
      fresh_attempt_generation: freshGeneration,
    });

    const runOptions: AgentRunOptions = {
      attempt,
      freshAttemptGeneration: freshGeneration,
      issue,
      onEvent: (event) =>
        this.#enqueue(() => this.#applyAgentEvent(issue.id, event)),
      signal: abortController.signal,
      tracker,
      workflow,
    };
    const worker = Promise.resolve().then(() =>
      this.#agentRunner.run(runOptions),
    );
    entry.worker = worker;
    void worker.then(
      (result) =>
        this.#enqueue(() => this.#finishWorker(entry, { result, error: null })),
      (error: unknown) =>
        this.#enqueue(() => this.#finishWorker(entry, { result: null, error })),
    );
  }

  #applyAgentEvent(issueId: string, event: AgentEvent): void {
    const entry = this.#running.get(issueId);
    if (entry === undefined) return;
    entry.lastEvent = event.event;
    entry.lastEventAtMs = this.#clock.nowMs();
    entry.lastMessage = eventMessage(event);

    if (typeof event.codex_app_server_pid === "number") {
      entry.pid = event.codex_app_server_pid;
    }
    if (event.event === "session_started") {
      const sessionId = event["session_id"];
      const turnId = event["turn_id"];
      if (typeof sessionId === "string") entry.sessionId = sessionId;
      if (typeof turnId === "string" && !entry.seenTurnIds.has(turnId)) {
        entry.seenTurnIds.add(turnId);
        entry.turnCount += 1;
      }
      this.#logger.info("agent_session outcome=started", {
        issue_id: entry.issue.id,
        issue_identifier: entry.issue.identifier,
        session_id: entry.sessionId,
      });
    }

    const tokens = absoluteTokenTotals(event);
    if (tokens !== null) {
      const delta = tokenDelta(entry.lastTokens, tokens);
      this.#totals.inputTokens += delta.inputTokens;
      this.#totals.outputTokens += delta.outputTokens;
      this.#totals.totalTokens += delta.totalTokens;
      entry.lastTokens = monotonicTokenTotals(entry.lastTokens, tokens);
    }
    if (event.event === "rate_limits" && event["rate_limits"] !== undefined) {
      this.#latestRateLimits = event["rate_limits"] ?? null;
    }
  }

  async #finishWorker(
    entry: RunningEntry,
    outcome: {
      readonly error: unknown | null;
      readonly result: AgentRunResult | null;
    },
  ): Promise<void> {
    if (this.#running.get(entry.issue.id) !== entry) return;
    this.#running.delete(entry.issue.id);
    this.#totals.secondsEnded +=
      Math.max(this.#clock.nowMs() - entry.startedAtMs, 0) / 1_000;
    if (
      outcome.result?.finalIssue !== null &&
      outcome.result?.finalIssue !== undefined
    ) {
      entry.issue = outcome.result.finalIssue;
    }

    switch (entry.terminationIntent) {
      case "terminal":
        await this.#cleanupWorkspace(entry.issue, entry.workflow, "terminal");
        this.#release(entry.issue.id);
        break;
      case "released":
      case "stopping":
        this.#release(entry.issue.id);
        break;
      case "stalled": {
        const attempt = nextFailureAttempt(entry.attempt);
        this.#scheduleRetry(
          entry.issue,
          attempt,
          entry.terminationError ?? "agent stalled",
          "failure",
          entry.freshAttemptGeneration,
          entry.workflow,
        );
        break;
      }
      case null:
        if (outcome.error === null) {
          this.#scheduleRetry(
            entry.issue,
            1,
            null,
            "continuation",
            entry.freshAttemptGeneration,
            entry.workflow,
          );
        } else if (isFreshAttemptRefusal(outcome.error)) {
          const attempt = nextFailureAttempt(entry.attempt);
          const refusalReason = errorMessage(outcome.error);
          try {
            await this.#refuseFreshAttempt(
              entry.issue,
              entry.tracker,
              entry.workflow,
              refusalReason,
            );
            this.#release(entry.issue.id);
          } catch (handoffError) {
            this.#logger.error(
              "fresh_attempt_handoff outcome=failed reason=tracker_mutation",
              {
                issue_id: entry.issue.id,
                issue_identifier: entry.issue.identifier,
                error: errorMessage(handoffError),
              },
            );
            this.#scheduleRetry(
              entry.issue,
              attempt,
              refusalReason,
              "fresh_handoff",
              entry.freshAttemptGeneration,
              entry.workflow,
            );
          }
        } else {
          const attempt = nextFailureAttempt(entry.attempt);
          this.#scheduleRetry(
            entry.issue,
            attempt,
            errorMessage(outcome.error),
            "failure",
            entry.freshAttemptGeneration,
            entry.workflow,
          );
        }
        break;
    }

    this.#logger.info(
      `worker outcome=${outcome.error === null ? "completed" : "failed"}`,
      {
        issue_id: entry.issue.id,
        issue_identifier: entry.issue.identifier,
        session_id: entry.sessionId,
        termination_intent: entry.terminationIntent,
        error: outcome.error === null ? null : errorMessage(outcome.error),
      },
    );
  }

  #scheduleRetry(
    issue: Issue,
    attempt: number,
    retryError: string | null,
    kind: RetryKind,
    freshGeneration: string | null,
    workspaceWorkflow: WorkflowSnapshot,
  ): void {
    this.#cancelRetry(issue.id);
    const delayMs =
      kind === "continuation"
        ? CONTINUATION_DELAY_MS
        : failureRetryDelayMs(
            attempt,
            this.#workflowStore.current.config.agent.maxRetryBackoffMs,
          );
    const dueAtMs = this.#clock.nowMs() + delayMs;
    const timer = this.#clock.setTimeout(() => {
      void this.#enqueue(() => this.#handleRetry(issue.id)).catch(
        (error: unknown) => {
          this.#logger.error("retry outcome=failed reason=internal", {
            issue_id: issue.id,
            issue_identifier: issue.identifier,
            error: errorMessage(error),
          });
        },
      );
    }, delayMs);
    this.#claimed.add(issue.id);
    this.#retries.set(issue.id, {
      attempt,
      dueAtMs,
      error: retryError,
      freshAttemptGeneration: freshGeneration,
      issue,
      kind,
      timer,
      workspaceWorkflow,
    });
    this.#logger.info("retry outcome=scheduled", {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      attempt,
      delay_ms: delayMs,
      retry_kind: kind,
      fresh_attempt_generation: freshGeneration,
      error: retryError,
    });
  }

  async #handleRetry(issueId: string): Promise<void> {
    const retry = this.#retries.get(issueId);
    if (retry === undefined || this.#stopping) return;
    this.#retries.delete(issueId);
    const workflow = this.#workflowStore.current;
    let tracker: TrackerAdapter;
    try {
      tracker = this.#trackerFactory(workflow);
    } catch (error) {
      this.#scheduleRetry(
        retry.issue,
        retry.attempt,
        retry.kind === "fresh_handoff" ? retry.error : errorMessage(error),
        retry.kind === "fresh_handoff" ? "fresh_handoff" : "failure",
        retry.freshAttemptGeneration,
        retry.workspaceWorkflow,
      );
      return;
    }

    let refreshed: readonly Issue[];
    try {
      refreshed = await tracker.fetchIssuesByIds([issueId]);
    } catch (error) {
      this.#scheduleRetry(
        retry.issue,
        retry.attempt,
        retry.kind === "fresh_handoff" ? retry.error : errorMessage(error),
        retry.kind === "fresh_handoff" ? "fresh_handoff" : "failure",
        retry.freshAttemptGeneration,
        retry.workspaceWorkflow,
      );
      return;
    }

    const issue = refreshed.find((candidate) => candidate.id === issueId);
    if (issue === undefined) {
      this.#release(issueId);
      return;
    }
    if (stateIncluded(issue.state, workflow.config.tracker.terminalStates)) {
      await this.#cleanupWorkspace(
        issue,
        retry.workspaceWorkflow,
        "retry_terminal",
      );
      this.#release(issueId);
      return;
    }
    if (!issueEligibleByConfig(issue, workflow.config)) {
      this.#release(issueId);
      return;
    }
    const remainsFresh = issueInFreshAttemptState(issue, workflow);
    const generation = remainsFresh
      ? generationForIssue(issue, workflow)
      : retry.freshAttemptGeneration;
    if (remainsFresh && generation !== retry.freshAttemptGeneration) {
      this.#release(issueId);
      if (
        this.#hasGlobalSlot(workflow) &&
        this.#hasStateSlot(issue, workflow)
      ) {
        this.#dispatch(issue, null, generation, tracker, workflow);
      }
      return;
    }
    if (retry.kind === "fresh_handoff") {
      if (!remainsFresh) {
        this.#release(issueId);
        return;
      }
      try {
        await this.#refuseFreshAttempt(
          issue,
          tracker,
          workflow,
          retry.error ?? "Fresh-attempt provisioning was refused",
        );
        this.#release(issueId);
      } catch (error) {
        this.#logger.error(
          "fresh_attempt_handoff outcome=failed reason=tracker_mutation",
          {
            issue_id: issue.id,
            issue_identifier: issue.identifier,
            error: errorMessage(error),
          },
        );
        this.#scheduleRetry(
          issue,
          retry.attempt + 1,
          retry.error,
          "fresh_handoff",
          generation,
          retry.workspaceWorkflow,
        );
      }
      return;
    }
    if (
      !this.#hasGlobalSlot(workflow) ||
      !this.#hasStateSlot(issue, workflow)
    ) {
      this.#scheduleRetry(
        issue,
        retry.attempt,
        "no available orchestrator slots",
        "failure",
        generation,
        retry.workspaceWorkflow,
      );
      return;
    }
    this.#dispatch(issue, retry.attempt, generation, tracker, workflow);
  }

  async #refuseFreshAttempt(
    issue: Issue,
    tracker: TrackerAdapter,
    workflow: WorkflowSnapshot,
    reason: string,
  ): Promise<void> {
    const failureState = workflow.config.tracker.freshAttemptFailureState;
    if (failureState === null) {
      throw new Error("Fresh-attempt failure state is not configured");
    }
    const control = tracker.freshAttemptControl?.(issue);
    if (control === undefined) {
      throw new Error("Tracker adapter has no fresh-attempt refusal control");
    }
    await control.refuse(reason, failureState);
    this.#logger.info("fresh_attempt_handoff outcome=completed", {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      target_state: failureState,
    });
  }

  #shouldDispatch(issue: Issue, workflow: WorkflowSnapshot): boolean {
    return (
      issueEligibleByConfig(issue, workflow.config) &&
      !this.#running.has(issue.id) &&
      !this.#claimed.has(issue.id)
    );
  }

  #hasGlobalSlot(workflow: WorkflowSnapshot): boolean {
    return this.#running.size < workflow.config.agent.maxConcurrentAgents;
  }

  #hasStateSlot(issue: Issue, workflow: WorkflowSnapshot): boolean {
    const state = normalizedTrackerValue(issue.state);
    const limit =
      workflow.config.agent.maxConcurrentAgentsByState.get(state) ??
      workflow.config.agent.maxConcurrentAgents;
    let runningInState = 0;
    for (const entry of this.#running.values()) {
      if (normalizedTrackerValue(entry.issue.state) === state) {
        runningInState += 1;
      }
    }
    return runningInState < limit;
  }

  #terminate(
    entry: RunningEntry,
    intent: TerminationIntent,
    reason: string,
  ): void {
    if (entry.terminationIntent !== null) return;
    entry.terminationIntent = intent;
    entry.terminationError = reason;
    this.#logger.info("worker action=cancel_requested", {
      issue_id: entry.issue.id,
      issue_identifier: entry.issue.identifier,
      session_id: entry.sessionId,
      reason,
      termination_intent: intent,
    });
    entry.abortController.abort();
  }

  async #cleanupWorkspace(
    issue: Issue,
    workflow: WorkflowSnapshot,
    reason: string,
  ): Promise<void> {
    try {
      await this.#agentRunner.cleanupWorkspace(issue, workflow);
      this.#logger.info("workspace_cleanup outcome=completed", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        reason,
      });
    } catch (error) {
      this.#logger.warn("workspace_cleanup outcome=failed", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        reason,
        error: errorMessage(error),
      });
    }
  }

  #release(issueId: string): void {
    this.#cancelRetry(issueId);
    this.#claimed.delete(issueId);
  }

  #cancelRetry(issueId: string): void {
    const retry = this.#retries.get(issueId);
    if (retry === undefined) return;
    this.#clock.clearTimeout(retry.timer);
    this.#retries.delete(issueId);
  }

  #schedulePoll(): void {
    if (!this.#started || this.#stopping) return;
    this.#clearPollTimer();
    const delayMs = this.#workflowStore.current.config.polling.intervalMs;
    this.#pollTimer = this.#clock.setTimeout(() => {
      this.#pollTimer = null;
      void this.tick().catch((error: unknown) => {
        this.#logger.error("poll outcome=failed reason=internal", {
          error: errorMessage(error),
        });
      });
    }, delayMs);
  }

  #clearPollTimer(): void {
    if (this.#pollTimer === null) return;
    this.#clock.clearTimeout(this.#pollTimer);
    this.#pollTimer = null;
  }

  #enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.#authority.then(operation);
    this.#authority = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
