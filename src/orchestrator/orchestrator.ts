import { randomUUID } from "node:crypto";

import type { AgentRunOptions, AgentRunResult } from "../agent/runner.js";
import { AgentError } from "../agent/errors.js";
import type { AgentEvent } from "../agent/events.js";
import type { DeliveryExecutionPort } from "../delivery/execution.js";
import type { TrackerDeliveryAuthority } from "../delivery/provider.js";
import type { Issue } from "../domain/issue.js";
import { errorMessage, SymphonyError } from "../errors.js";
import {
  DELIVERY_OPERATIONS,
  type DeliveryOperation,
  type TrackerPolicySnapshot,
} from "../governance/model.js";
import {
  deriveTrackerPolicyRuntime,
  trackerLane,
} from "../governance/tracker-policy.js";
import { nullLogger, type Logger } from "../observability/logger.js";
import type { RepositoryCleanupAuthority } from "../repository/driver.js";
import type { JsonValue } from "../shared/json.js";
import type {
  AttemptStatus,
  ExpiredRuntimeLeaseCandidate,
  RepositoryContentSnapshot,
  StartedAttempt,
  WorkSessionSnapshot,
  WorkspaceMode,
} from "../state/model.js";
import type { SymphonyStateStore } from "../state/store.js";
import { StateStoreError } from "../state/store.js";
import type { TrackerAdapter } from "../tracker/adapter.js";
import { freshAttemptGeneration } from "../workspace/fresh-attempt.js";
import type { Workspace } from "../workspace/manager.js";
import type { PromptAuthorityContext } from "../workflow/prompt.js";
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
const MINIMUM_RUNTIME_LEASE_MS = 120_000;

type TerminationIntent = "released" | "stalled" | "stopping" | "terminal";
type RetryKind = "continuation" | "failure" | "fresh_handoff";

export interface AgentExecutionPort {
  cleanupWorkspace(
    issue: Issue,
    workflow: WorkflowSnapshot,
    authority?: RepositoryCleanupAuthority,
  ): Promise<void>;
  quiesceRuntime(
    workflow: WorkflowSnapshot,
    authority?: RepositoryCleanupAuthority,
  ): Promise<void>;
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
  readonly deliveryExecution?: DeliveryExecutionPort;
  readonly stateStore: SymphonyStateStore;
  readonly trackerFactory: TrackerAdapterFactory;
  readonly workflowStore: WorkflowSource;
  readonly clock?: OrchestratorClock;
  readonly instanceId?: string;
  readonly logger?: Logger;
}

interface RunningEntry {
  readonly abortController: AbortController;
  readonly attemptId: string;
  readonly attempt: number | null;
  readonly controllerGeneration: number;
  readonly freshAttemptGeneration: string | null;
  readonly promptAuthority: PromptAuthorityContext;
  readonly requiresFreshAttempt: boolean;
  readonly startedAtMs: number;
  readonly runtimeLeaseToken: string;
  readonly workSessionId: string;
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
  readonly controllerGeneration: number;
  readonly dueAtMs: number;
  readonly error: string | null;
  readonly freshAttemptGeneration: string | null;
  readonly issue: Issue;
  readonly kind: RetryKind;
  readonly timer: TimerHandle;
  readonly workSessionId: string;
  readonly workspaceWorkflow: WorkflowSnapshot;
}

interface MutableAggregateTotals {
  inputTokens: number;
  outputTokens: number;
  secondsEnded: number;
  totalTokens: number;
}

export interface RunningSnapshotRow {
  readonly attempt_id: string;
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
  readonly work_session_id: string;
  readonly governance: RuntimeGovernanceReferences;
}

export interface RetrySnapshotRow {
  readonly attempt: number;
  readonly due_at: string;
  readonly error: string | null;
  readonly issue_id: string;
  readonly issue_identifier: string;
  readonly issue_url: string | null;
  readonly kind: RetryKind;
  readonly work_session_id: string;
  readonly governance: RuntimeGovernanceReferences;
}

export interface RuntimeContentReference {
  readonly repository_identity: string;
  readonly path: string;
  readonly revision: string;
  readonly digest: string;
}

export interface RuntimeGovernanceReferences {
  readonly doctrine: RuntimeContentReference | null;
  readonly manifest: RuntimeContentReference | null;
  readonly tracker_policy: RuntimeContentReference | null;
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

function repositoryIdentity(workflow: WorkflowSnapshot): string {
  if (workflow.config.repository !== null) {
    return workflow.config.repository.identity;
  }
  const owner = workflow.config.tracker.provider["owner"];
  const repo = workflow.config.tracker.provider["repo"];
  if (
    typeof owner === "string" &&
    owner.trim() !== "" &&
    typeof repo === "string" &&
    repo.trim() !== ""
  ) {
    return `${owner}/${repo}`;
  }
  // Compatibility profiles may predate an explicit repository identity. The
  // workflow path is stable within that deployment and is never read from the
  // candidate workspace.
  return `workflow:${workflow.path}`;
}

function trackerControllerId(workflow: WorkflowSnapshot): string {
  return `tracker:${workflow.config.tracker.kind}:${repositoryIdentity(workflow)}`;
}

function runtimeLeaseExpiresAt(
  nowMs: number,
  workflow: WorkflowSnapshot,
): string {
  const duration = Math.max(
    MINIMUM_RUNTIME_LEASE_MS,
    workflow.config.polling.intervalMs * 4,
  );
  return iso(nowMs + duration);
}

function workspaceMode(
  workflow: WorkflowSnapshot,
): Exclude<WorkspaceMode, "managed"> {
  return workflow.config.workspace.provider === "harness"
    ? "legacy-hook"
    : "legacy-directory";
}

function expectedDispatchRefusal(error: unknown): error is StateStoreError {
  return (
    error instanceof StateStoreError &&
    (error.code === "active_runtime_lease" || error.code === "retry_not_due")
  );
}

function workflowTrackerPolicy(
  workflow: WorkflowSnapshot,
): TrackerPolicySnapshot | null {
  return (
    workflow.config.deployment?.acceptedConfiguration.trackerPolicy ?? null
  );
}

function sessionTrackerPolicy(
  session: WorkSessionSnapshot | null,
  workflow: WorkflowSnapshot,
): TrackerPolicySnapshot | null {
  return (
    session?.configuration?.trackerPolicy ?? workflowTrackerPolicy(workflow)
  );
}

function candidateAgentStatusTargets(
  policy: TrackerPolicySnapshot | null,
): readonly string[] | undefined {
  return policy === null
    ? undefined
    : policy.lanes
        .filter((lane) => lane.writers.includes("agent") && !lane.terminal)
        .map((lane) => lane.name);
}

function issueInFreshAttemptState(
  issue: Issue,
  workflow: WorkflowSnapshot,
  policy: TrackerPolicySnapshot | null = workflowTrackerPolicy(workflow),
): boolean {
  return policy === null
    ? stateIncluded(issue.state, workflow.config.tracker.freshAttemptStates)
    : trackerLane(policy, issue.state)?.freshAttempt === true;
}

function issueInTerminalState(
  issue: Issue,
  workflow: WorkflowSnapshot,
  policy: TrackerPolicySnapshot | null = workflowTrackerPolicy(workflow),
): boolean {
  return policy === null
    ? stateIncluded(issue.state, workflow.config.tracker.terminalStates)
    : trackerLane(policy, issue.state)?.terminal === true;
}

function generationForIssue(
  issue: Issue,
  workflow: WorkflowSnapshot,
  policy: TrackerPolicySnapshot | null = workflowTrackerPolicy(workflow),
): string | null {
  return issueInFreshAttemptState(issue, workflow, policy)
    ? freshAttemptGeneration(issue)
    : null;
}

function runtimeContentReference(
  reference: RepositoryContentSnapshot | null,
): RuntimeContentReference | null {
  return reference === null
    ? null
    : {
        repository_identity: reference.repositoryIdentity,
        path: reference.path,
        revision: reference.revision,
        digest: reference.digest,
      };
}

function runtimeGovernanceReferences(
  authority: PromptAuthorityContext,
): RuntimeGovernanceReferences {
  return {
    doctrine: runtimeContentReference(authority.doctrine),
    manifest: runtimeContentReference(authority.governanceManifest),
    tracker_policy: runtimeContentReference(authority.trackerPolicy),
  };
}

function sessionPromptAuthority(
  session: WorkSessionSnapshot,
): PromptAuthorityContext {
  return {
    workSessionId: session.id,
    doctrine: session.doctrine,
    governanceManifest: session.configuration?.governanceManifest ?? null,
    trackerPolicy: session.configuration?.trackerPolicy?.source ?? null,
  };
}

function selectedByPolicy(
  issue: Issue,
  policy: TrackerPolicySnapshot,
): boolean {
  const projection = deriveTrackerPolicyRuntime(policy);
  const labels = new Set(issue.labels.map(normalizedTrackerValue));
  return (
    projection.requiredLabels.every((label) =>
      labels.has(normalizedTrackerValue(label)),
    ) &&
    projection.excludedLabels.every(
      (label) => !labels.has(normalizedTrackerValue(label)),
    )
  );
}

function policyAllowsAuthoring(
  issue: Issue,
  policy: TrackerPolicySnapshot,
): boolean {
  const lane = trackerLane(policy, issue.state);
  return (
    lane?.active === true &&
    lane.authoring &&
    issue.dispatchable &&
    selectedByPolicy(issue, policy)
  );
}

function policyReconciliationStates(
  policy: TrackerPolicySnapshot,
): readonly string[] {
  return policy.lanes
    .filter(
      (lane) =>
        lane.active ||
        lane.terminal ||
        Object.values(lane.delivery).some((permitted) => permitted),
    )
    .map((lane) => lane.name);
}

function trackerDeliveryAuthority(
  session: WorkSessionSnapshot,
  issue: Issue,
  observedAt: string,
): TrackerDeliveryAuthority | null {
  const policy = session.configuration?.trackerPolicy;
  const grant = session.configuration?.deliveryGrant;
  const lane =
    policy === null || policy === undefined
      ? null
      : trackerLane(policy, issue.state);
  if (
    session.origin.kind !== "tracker" ||
    session.origin.issueId !== issue.id ||
    policy === null ||
    policy === undefined ||
    grant === null ||
    grant === undefined ||
    lane === null ||
    !selectedByPolicy(issue, policy)
  ) {
    return null;
  }
  const profile = new Set(policy.deliveryProfiles[grant.authority]);
  const permitted = new Set<DeliveryOperation>();
  for (const [operation, lanePermits] of Object.entries(lane.delivery) as Array<
    [Exclude<DeliveryOperation, "observeMerge">, boolean]
  >) {
    const requiresOpenIssue = [
      "materialize",
      "push",
      "openPullRequest",
      "mergePullRequest",
    ].includes(operation);
    if (
      lanePermits &&
      profile.has(operation) &&
      (issue.dispatchable || !requiresOpenIssue)
    ) {
      permitted.add(operation);
    }
  }
  if (
    profile.has("observeMerge") &&
    (lane.delivery.observeChecks ||
      lane.delivery.mergePullRequest ||
      lane.delivery.releaseRemoteBranch ||
      lane.delivery.cleanupWorkspace)
  ) {
    permitted.add("observeMerge");
  }
  const permittedOperations = DELIVERY_OPERATIONS.filter((operation) =>
    permitted.has(operation),
  );
  return {
    origin: "tracker",
    issueId: issue.id,
    state: issue.state,
    stateVersion: issue.state_version,
    permittedOperations,
    permitsDelivery: [
      "materialize",
      "push",
      "openPullRequest",
      "observeChecks",
    ].every((operation) => permitted.has(operation as DeliveryOperation)),
    permitsMerge: permitted.has("mergePullRequest"),
    permitsCleanup:
      permitted.has("releaseRemoteBranch") && permitted.has("cleanupWorkspace"),
    observedAt,
  };
}

/**
 * The single mutable authority for claims, workers, retries, and aggregates.
 * Long-running workers report back through a serialized mutation queue.
 */
export class Orchestrator {
  readonly #agentRunner: AgentExecutionPort;
  readonly #claimed = new Set<string>();
  readonly #clock: OrchestratorClock;
  readonly #deliveryExecution: DeliveryExecutionPort | null;
  readonly #instanceId: string;
  readonly #logger: Logger;
  readonly #observedTerminalIssueIds = new Set<string>();
  readonly #retries = new Map<string, RetryEntry>();
  readonly #running = new Map<string, RunningEntry>();
  readonly #stateStore: SymphonyStateStore;
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
    this.#deliveryExecution = options.deliveryExecution ?? null;
    this.#instanceId = options.instanceId ?? randomUUID();
    this.#logger = options.logger ?? nullLogger;
    this.#stateStore = options.stateStore;
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
      attempt_id: entry.attemptId,
      issue_id: entry.issue.id,
      issue_identifier: entry.issue.identifier,
      issue_url: entry.issue.url,
      state: entry.issue.state,
      session_id: entry.sessionId,
      pid: entry.pid,
      turn_count: entry.turnCount,
      work_session_id: entry.workSessionId,
      governance: runtimeGovernanceReferences(entry.promptAuthority),
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
    const localRetries = [...this.#retries.values()]
      .sort((left, right) => left.dueAtMs - right.dueAtMs)
      .map((entry) => {
        const session = this.#stateStore.getSession(entry.workSessionId);
        const authority =
          session === null
            ? {
                workSessionId: entry.workSessionId,
                doctrine: null,
                governanceManifest: null,
                trackerPolicy: null,
              }
            : sessionPromptAuthority(session);
        return {
          issue_id: entry.issue.id,
          issue_identifier: entry.issue.identifier,
          issue_url: entry.issue.url,
          attempt: entry.attempt,
          due_at: iso(entry.dueAtMs),
          error: entry.error,
          kind: entry.kind,
          work_session_id: entry.workSessionId,
          governance: runtimeGovernanceReferences(authority),
        };
      });
    const localRetrySessionIds = new Set(
      [...this.#retries.values()].map((entry) => entry.workSessionId),
    );
    const durableRetries: RetrySnapshotRow[] = [];
    for (const session of this.#stateStore.listActiveSessions()) {
      if (
        session.retry === null ||
        session.origin.kind !== "tracker" ||
        localRetrySessionIds.has(session.id)
      ) {
        continue;
      }
      durableRetries.push({
        issue_id: session.origin.issueId,
        issue_identifier: session.origin.issueIdentifier,
        issue_url: session.origin.issueUrl,
        attempt: session.retry.attempt,
        due_at: session.retry.dueAt,
        error: session.retry.error,
        kind: session.retry.kind,
        work_session_id: session.id,
        governance: runtimeGovernanceReferences(
          sessionPromptAuthority(session),
        ),
      });
    }
    const retrying = [...localRetries, ...durableRetries].sort((left, right) =>
      left.due_at.localeCompare(right.due_at),
    );
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
    if (
      !(await this.#reconcileExpiredRuntimeLeases(this.#workflowStore.current))
    )
      return;
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
      observedIssues = await tracker.fetchIssuesByStates(
        this.#reconciliationStates(workflow),
      );
    } catch (error) {
      this.#logger.error("dispatch outcome=skipped reason=tracker_fetch", {
        error: errorMessage(error),
      });
      return;
    }

    await this.#reconcileDeliveries(observedIssues, tracker, workflow);
    await this.#reconcileTerminalWorkspaces(observedIssues, workflow);
    if (!dispatchAllowed) return;

    for (const issue of [...observedIssues].sort(compareIssuesForDispatch)) {
      if (!this.#shouldDispatch(issue, workflow)) continue;
      if (await this.#resumePersistedFreshHandoff(issue, tracker, workflow)) {
        continue;
      }
      if (!this.#hasGlobalSlot(workflow)) break;
      if (!this.#hasStateSlot(issue, workflow)) continue;
      this.#dispatch(
        issue,
        null,
        generationForIssue(
          issue,
          workflow,
          sessionTrackerPolicy(
            this.#stateStore.getTrackerSession(
              workflow.config.tracker.kind,
              repositoryIdentity(workflow),
              issue.id,
            ),
            workflow,
          ),
        ),
        tracker,
        workflow,
      );
    }
  }

  #reconciliationStates(workflow: WorkflowSnapshot): readonly string[] {
    const states = new Map<string, string>();
    const add = (name: string) =>
      states.set(normalizedTrackerValue(name), name.trim());
    for (const state of [
      ...workflow.config.tracker.activeStates,
      ...workflow.config.tracker.terminalStates,
    ]) {
      add(state);
    }
    const currentPolicy = workflowTrackerPolicy(workflow);
    if (currentPolicy !== null) {
      for (const state of policyReconciliationStates(currentPolicy)) add(state);
    }
    for (const session of this.#stateStore.listActiveSessions()) {
      if (
        session.origin.kind !== "tracker" ||
        session.repositoryIdentity !== repositoryIdentity(workflow) ||
        session.configuration?.trackerPolicy == null
      ) {
        continue;
      }
      for (const state of policyReconciliationStates(
        session.configuration.trackerPolicy,
      )) {
        add(state);
      }
    }
    return [...states.values()];
  }

  async #reconcileDeliveries(
    issues: readonly Issue[],
    tracker: TrackerAdapter,
    workflow: WorkflowSnapshot,
  ): Promise<void> {
    if (this.#deliveryExecution === null) return;
    for (const issue of issues) {
      if (this.#running.has(issue.id)) continue;
      let session: WorkSessionSnapshot | null;
      try {
        session = this.#stateStore.getTrackerSession(
          workflow.config.tracker.kind,
          repositoryIdentity(workflow),
          issue.id,
        );
      } catch (error) {
        this.#logger.error("delivery outcome=deferred reason=state_read", {
          issue_id: issue.id,
          error: errorMessage(error),
        });
        continue;
      }
      if (
        session === null ||
        session.status !== "active" ||
        session.configuration?.deliveryGrant == null
      ) {
        continue;
      }
      const authority = trackerDeliveryAuthority(
        session,
        issue,
        iso(this.#clock.nowMs()),
      );
      if (
        authority === null ||
        (authority.permittedOperations.length === 0 &&
          session.delivery === null)
      ) {
        continue;
      }
      try {
        const outcome = await this.#deliveryExecution.reconcile({
          issue,
          sessionId: session.id,
          tracker: authority,
          workflow,
        });
        this.#logger.info(`delivery outcome=${outcome.status}`, {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          work_session_id: session.id,
        });
        if (outcome.status === "completed") {
          await this.#completeTrackerDelivery(outcome.session, issue, tracker);
        }
      } catch (error) {
        this.#logger.error("delivery outcome=deferred reason=reconciliation", {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          work_session_id: session.id,
          error: errorMessage(error),
        });
      }
    }
  }

  async #completeTrackerDelivery(
    session: WorkSessionSnapshot,
    issue: Issue,
    tracker: TrackerAdapter,
  ): Promise<void> {
    const policy = session.configuration?.trackerPolicy;
    const done =
      policy === null || policy === undefined
        ? null
        : trackerLane(policy, "Done");
    if (done === null || !done.terminal || !done.writers.includes("agent")) {
      throw new SymphonyError(
        "tracker_policy_invalid",
        "Accepted tracker policy has no agent-writable terminal Done lane",
      );
    }
    const control = tracker.stateControl?.(issue);
    if (control === undefined) {
      throw new SymphonyError(
        "delivery_refused",
        "Tracker adapter has no typed status-transition control",
      );
    }
    const head = session.delivery?.immutableHeadSha;
    if (head === null || head === undefined) {
      throw new SymphonyError(
        "delivery_refused",
        "Completed delivery has no immutable head",
      );
    }
    const effect = this.#stateStore.enqueueEffect({
      sessionId: session.id,
      controllerGeneration: session.controller.generation,
      kind: "tracker.delivery_completed",
      idempotencyKey: `tracker:delivery-completed:${head}`,
      payload: {
        issue_id: issue.id,
        immutable_head_sha: head,
        target_state: done.name,
      },
      now: iso(this.#clock.nowMs()),
    });
    if (effect.status === "failed") {
      throw new StateStoreError(
        "effect_conflict",
        `Delivery-completion effect ${effect.id} is terminally failed`,
      );
    }
    let confirmed = issue;
    const alreadyDone =
      normalizedTrackerValue(issue.state) === normalizedTrackerValue(done.name);
    if (effect.status === "applied") {
      if (!alreadyDone) {
        throw new SymphonyError(
          "delivery_refused",
          `Applied delivery-completion effect ${effect.id} is no longer reflected by tracker truth`,
        );
      }
    } else {
      confirmed = alreadyDone
        ? issue
        : await control.transition(done.name, issue.state_version);
      this.#stateStore.finishEffect({
        effectId: effect.id,
        controllerGeneration: session.controller.generation,
        status: "applied",
        result: { state: confirmed.state },
        now: iso(this.#clock.nowMs()),
      });
    }
    this.#release(issue.id, session.id, session.controller.generation);
    this.#markSessionTerminal(
      session.id,
      session.controller.generation,
      confirmed,
    );
  }

  async #resumePersistedFreshHandoff(
    issue: Issue,
    tracker: TrackerAdapter,
    workflow: WorkflowSnapshot,
  ): Promise<boolean> {
    let workSession;
    try {
      workSession = this.#stateStore.getTrackerSession(
        workflow.config.tracker.kind,
        repositoryIdentity(workflow),
        issue.id,
      );
    } catch (error) {
      this.#logger.error("dispatch outcome=skipped reason=state_read", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        error: errorMessage(error),
      });
      return true;
    }
    const retry = workSession?.retry;
    if (workSession === null || retry?.kind !== "fresh_handoff") return false;
    if (Date.parse(retry.dueAt) > this.#clock.nowMs()) return true;

    try {
      await this.#refuseFreshAttempt(
        workSession.id,
        workSession.controller.generation,
        issue,
        tracker,
        workflow,
        retry.error ?? "Fresh-attempt provisioning was refused",
        retry.freshAttemptGeneration,
      );
      this.#release(
        issue.id,
        workSession.id,
        workSession.controller.generation,
      );
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
        workSession.id,
        workSession.controller.generation,
        retry.attempt + 1,
        retry.error,
        "fresh_handoff",
        retry.freshAttemptGeneration,
        workflow,
      );
    }
    return true;
  }

  async #startupCleanup(): Promise<void> {
    const workflow = this.#workflowStore.current;
    this.#observedTerminalIssueIds.clear();
    try {
      await this.#reconcileExpiredRuntimeLeases(workflow);
      const tracker = this.#trackerFactory(workflow);
      const terminalIssues = await tracker.fetchIssuesByStates(
        workflowTrackerPolicy(workflow) === null
          ? workflow.config.tracker.terminalStates
          : this.#reconciliationStates(workflow),
      );
      await this.#reconcileDeliveries(terminalIssues, tracker, workflow);
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

  async #reconcileExpiredRuntimeLeases(
    workflow: WorkflowSnapshot,
  ): Promise<boolean> {
    const now = iso(this.#clock.nowMs());
    let candidates: readonly ExpiredRuntimeLeaseCandidate[];
    try {
      candidates = this.#stateStore.listExpiredRuntimeLeases(now);
    } catch (error) {
      this.#logger.error(
        "dispatch outcome=skipped reason=lease_reconciliation",
        { error: errorMessage(error) },
      );
      return false;
    }
    for (const candidate of candidates) {
      try {
        await this.#agentRunner.quiesceRuntime(workflow, {
          workSessionId: candidate.sessionId,
          controllerGeneration: candidate.controllerGeneration,
        });
        this.#stateStore.expireRuntimeLease({ ...candidate, now });
        this.#logger.info("runtime_lease outcome=expired", {
          work_session_id: candidate.sessionId,
          attempt_id: candidate.attemptId,
        });
      } catch (error) {
        this.#logger.error(
          "runtime_lease outcome=retained reason=quiescence_unproven",
          {
            work_session_id: candidate.sessionId,
            attempt_id: candidate.attemptId,
            error: errorMessage(error),
          },
        );
      }
    }
    return true;
  }

  async #reconcileTerminalWorkspaces(
    issues: readonly Issue[],
    workflow: WorkflowSnapshot,
    reason = "poll_terminal",
  ): Promise<void> {
    const terminalIssueIds = new Set<string>();
    for (const issue of issues) {
      const workSession = this.#stateStore.getTrackerSession(
        workflow.config.tracker.kind,
        repositoryIdentity(workflow),
        issue.id,
      );
      const policy = sessionTrackerPolicy(workSession, workflow);
      if (!issueInTerminalState(issue, workflow, policy)) continue;
      terminalIssueIds.add(issue.id);
      if (
        this.#observedTerminalIssueIds.has(issue.id) ||
        this.#claimed.has(issue.id)
      ) {
        continue;
      }
      if (
        workSession?.attempts.some(
          (attempt) => attempt.runtimeLease.status === "active",
        ) === true
      ) {
        this.#logger.info(
          "workspace_cleanup outcome=skipped reason=active_runtime_lease",
          {
            issue_id: issue.id,
            issue_identifier: issue.identifier,
            work_session_id: workSession.id,
          },
        );
        continue;
      }
      if (
        workSession?.delivery !== null &&
        workSession?.delivery !== undefined &&
        workSession.delivery.phase !== "completed"
      ) {
        this.#logger.info(
          "workspace_cleanup outcome=skipped reason=delivery_pending",
          {
            issue_id: issue.id,
            issue_identifier: issue.identifier,
            work_session_id: workSession.id,
            delivery_phase: workSession.delivery.phase,
          },
        );
        continue;
      }
      const cleaned = await this.#cleanupWorkspace(
        issue,
        workflow,
        reason,
        workSession === null
          ? undefined
          : {
              workSessionId: workSession.id,
              controllerGeneration: workSession.controller.generation,
            },
      );
      if (!cleaned) {
        terminalIssueIds.delete(issue.id);
        continue;
      }
      if (workSession !== null) {
        this.#markSessionTerminal(
          workSession.id,
          workSession.controller.generation,
          issue,
        );
      }
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

    for (const entry of this.#running.values()) {
      if (entry.terminationIntent !== null) continue;
      try {
        this.#stateStore.renewRuntimeLease({
          sessionId: entry.workSessionId,
          attemptId: entry.attemptId,
          runtimeLeaseToken: entry.runtimeLeaseToken,
          controllerGeneration: entry.controllerGeneration,
          now: iso(now),
          leaseExpiresAt: runtimeLeaseExpiresAt(now, entry.workflow),
        });
      } catch (error) {
        this.#logger.error("runtime_lease outcome=lost", {
          issue_id: entry.issue.id,
          work_session_id: entry.workSessionId,
          attempt_id: entry.attemptId,
          error: errorMessage(error),
        });
        this.#terminate(entry, "released", "runtime lease lost");
      }
    }

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
          const policy = sessionTrackerPolicy(
            this.#stateStore.getSession(entry.workSessionId),
            workflow,
          );
          if (issue === undefined) {
            this.#terminate(entry, "released", "issue no longer visible");
          } else if (issueInTerminalState(issue, workflow, policy)) {
            entry.issue = issue;
            this.#terminate(entry, "terminal", `terminal state ${issue.state}`);
          } else if (
            policy === null
              ? stateIncluded(
                  issue.state,
                  workflow.config.tracker.activeStates,
                ) &&
                issueRoutable(
                  issue,
                  workflow.config.tracker.requiredLabels,
                  workflow.config.tracker.excludedLabels,
                )
              : policyAllowsAuthoring(issue, policy)
          ) {
            const remainsFresh = issueInFreshAttemptState(
              issue,
              workflow,
              policy,
            );
            const generation = generationForIssue(issue, workflow, policy);
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
    const startedAtMs = this.#clock.nowMs();
    let started: StartedAttempt;
    let effectiveAttempt = attempt;
    let effectiveFreshGeneration = freshGeneration;
    let requiresFreshAttempt = false;
    try {
      const workSession = this.#stateStore.getOrCreateTrackerSession({
        trackerKind: workflow.config.tracker.kind,
        repositoryIdentity: repositoryIdentity(workflow),
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        issueUrl: issue.url,
        intent: issue.title,
        controllerId: trackerControllerId(workflow),
        doctrine: workflow.config.deployment?.doctrine ?? null,
        configuration:
          workflow.config.deployment?.acceptedConfiguration ?? null,
        now: iso(startedAtMs),
      });
      if (effectiveAttempt === null && workSession.retry !== null) {
        effectiveAttempt = workSession.retry.attempt;
        effectiveFreshGeneration =
          workSession.retry.freshAttemptGeneration ?? freshGeneration;
      }
      requiresFreshAttempt = issueInFreshAttemptState(
        issue,
        workflow,
        workSession.configuration?.trackerPolicy ?? null,
      );
      started = this.#stateStore.startAttempt({
        sessionId: workSession.id,
        controllerGeneration: workSession.controller.generation,
        holderId: this.#instanceId,
        trackerAttempt: effectiveAttempt,
        freshAttemptGeneration: effectiveFreshGeneration,
        now: iso(startedAtMs),
        leaseExpiresAt: runtimeLeaseExpiresAt(startedAtMs, workflow),
      });
    } catch (error) {
      const log = expectedDispatchRefusal(error)
        ? this.#logger.debug.bind(this.#logger)
        : this.#logger.error.bind(this.#logger);
      log("dispatch outcome=skipped reason=state_admission", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        error: errorMessage(error),
        state_error:
          error instanceof StateStoreError ? error.code : "unexpected",
      });
      return;
    }

    const abortController = new AbortController();
    const promptAuthority = sessionPromptAuthority(started.session);
    const entry: RunningEntry = {
      abortController,
      attemptId: started.attemptId,
      attempt: effectiveAttempt,
      controllerGeneration: started.controllerGeneration,
      freshAttemptGeneration: effectiveFreshGeneration,
      issue,
      lastEvent: null,
      lastEventAtMs: null,
      lastMessage: null,
      lastTokens: zeroTokenTotals(),
      pid: null,
      promptAuthority,
      requiresFreshAttempt,
      seenTurnIds: new Set(),
      sessionId: null,
      runtimeLeaseToken: started.runtimeLeaseToken,
      startedAtMs,
      terminationError: null,
      terminationIntent: null,
      tracker,
      turnCount: 0,
      workSessionId: started.session.id,
      worker: null,
      workflow,
    };
    this.#claimed.add(issue.id);
    this.#cancelRetry(issue.id);
    this.#running.set(issue.id, entry);
    this.#logger.info("dispatch outcome=started", {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      work_session_id: entry.workSessionId,
      attempt_id: entry.attemptId,
      attempt: effectiveAttempt,
      fresh_attempt_generation: effectiveFreshGeneration,
    });

    const agentStatusTargets = candidateAgentStatusTargets(
      started.session.configuration?.trackerPolicy ?? null,
    );
    const runOptions: AgentRunOptions = {
      attempt: effectiveAttempt,
      ...(agentStatusTargets === undefined ? {} : { agentStatusTargets }),
      freshAttemptGeneration: effectiveFreshGeneration,
      issue,
      onEvent: (event) =>
        this.#enqueue(() => this.#applyAgentEvent(issue.id, event)),
      onWorkspace: (workspace) =>
        this.#enqueue(() => this.#recordWorkspace(entry, workspace)),
      repositoryAuthority: {
        workSessionId: entry.workSessionId,
        attemptId: entry.attemptId,
        runtimeLeaseToken: entry.runtimeLeaseToken,
        controllerGeneration: entry.controllerGeneration,
      },
      promptAuthority,
      requiresFreshAttempt: entry.requiresFreshAttempt,
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

  #recordWorkspace(entry: RunningEntry, workspace: Workspace): void {
    if (entry.workflow.config.workspace.provider === "git-worktree") {
      const session = this.#stateStore.getSession(entry.workSessionId);
      const attempt = session?.attempts.find(
        (candidate) => candidate.id === entry.attemptId,
      );
      const lease = attempt?.workspaceLease;
      if (
        lease?.mode !== "managed" ||
        lease.phase !== "ready" ||
        lease.path !== workspace.path ||
        lease.workspaceKey !== workspace.workspaceKey
      ) {
        throw new StateStoreError(
          "stale_fence",
          `Attempt ${entry.attemptId} did not return its ready managed workspace`,
        );
      }
      return;
    }
    this.#stateStore.recordWorkspace({
      sessionId: entry.workSessionId,
      attemptId: entry.attemptId,
      runtimeLeaseToken: entry.runtimeLeaseToken,
      controllerGeneration: entry.controllerGeneration,
      mode: workspaceMode(entry.workflow),
      path: workspace.path,
      workspaceKey: workspace.workspaceKey,
      now: iso(this.#clock.nowMs()),
    });
  }

  #applyAgentEvent(issueId: string, event: AgentEvent): void {
    const entry = this.#running.get(issueId);
    if (entry === undefined) return;
    const now = this.#clock.nowMs();
    try {
      this.#stateStore.renewRuntimeLease({
        sessionId: entry.workSessionId,
        attemptId: entry.attemptId,
        runtimeLeaseToken: entry.runtimeLeaseToken,
        controllerGeneration: entry.controllerGeneration,
        now: iso(now),
        leaseExpiresAt: runtimeLeaseExpiresAt(now, entry.workflow),
      });
      if (
        typeof event.codex_app_server_pid === "number" ||
        (event.event === "session_started" &&
          typeof event["session_id"] === "string")
      ) {
        this.#stateStore.recordRuntimeCorrelation({
          sessionId: entry.workSessionId,
          attemptId: entry.attemptId,
          runtimeLeaseToken: entry.runtimeLeaseToken,
          controllerGeneration: entry.controllerGeneration,
          ...(typeof event.codex_app_server_pid === "number"
            ? { processId: event.codex_app_server_pid }
            : {}),
          ...(typeof event["session_id"] === "string"
            ? { sessionIdValue: event["session_id"] }
            : {}),
          now: iso(now),
        });
      }
    } catch (error) {
      this.#logger.error("runtime_lease outcome=lost", {
        issue_id: entry.issue.id,
        work_session_id: entry.workSessionId,
        attempt_id: entry.attemptId,
        error: errorMessage(error),
      });
      this.#terminate(entry, "released", "runtime lease lost");
      return;
    }
    entry.lastEvent = event.event;
    entry.lastEventAtMs = now;
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

    if (!this.#finishDurableAttempt(entry, outcome.error)) {
      this.#release(entry.issue.id);
      return;
    }

    switch (entry.terminationIntent) {
      case "terminal":
        if (
          await this.#cleanupWorkspace(
            entry.issue,
            entry.workflow,
            "terminal",
            {
              workSessionId: entry.workSessionId,
              controllerGeneration: entry.controllerGeneration,
            },
          )
        ) {
          this.#markSessionTerminal(
            entry.workSessionId,
            entry.controllerGeneration,
            entry.issue,
          );
        } else {
          this.#observedTerminalIssueIds.delete(entry.issue.id);
        }
        this.#release(
          entry.issue.id,
          entry.workSessionId,
          entry.controllerGeneration,
        );
        break;
      case "released":
      case "stopping":
        this.#release(
          entry.issue.id,
          entry.workSessionId,
          entry.controllerGeneration,
        );
        break;
      case "stalled": {
        const attempt = nextFailureAttempt(entry.attempt);
        this.#scheduleRetry(
          entry.issue,
          entry.workSessionId,
          entry.controllerGeneration,
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
          await this.#continueAuthoringOrDeliver(entry);
        } else if (isFreshAttemptRefusal(outcome.error)) {
          const attempt = nextFailureAttempt(entry.attempt);
          const refusalReason = errorMessage(outcome.error);
          try {
            await this.#refuseFreshAttempt(
              entry.workSessionId,
              entry.controllerGeneration,
              entry.issue,
              entry.tracker,
              entry.workflow,
              refusalReason,
              entry.freshAttemptGeneration,
            );
            this.#release(
              entry.issue.id,
              entry.workSessionId,
              entry.controllerGeneration,
            );
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
              entry.workSessionId,
              entry.controllerGeneration,
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
            entry.workSessionId,
            entry.controllerGeneration,
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

  async #continueAuthoringOrDeliver(entry: RunningEntry): Promise<void> {
    const initialSession = this.#stateStore.getSession(entry.workSessionId);
    if (sessionTrackerPolicy(initialSession, entry.workflow) === null) {
      this.#scheduleRetry(
        entry.issue,
        entry.workSessionId,
        entry.controllerGeneration,
        1,
        null,
        "continuation",
        entry.freshAttemptGeneration,
        entry.workflow,
      );
      return;
    }
    let refreshed: readonly Issue[];
    try {
      refreshed = await entry.tracker.fetchIssuesByIds([entry.issue.id]);
    } catch (error) {
      this.#logger.warn(
        "worker_completion outcome=deferred reason=tracker_refresh",
        {
          issue_id: entry.issue.id,
          error: errorMessage(error),
        },
      );
      this.#scheduleRetry(
        entry.issue,
        entry.workSessionId,
        entry.controllerGeneration,
        1,
        null,
        "continuation",
        entry.freshAttemptGeneration,
        entry.workflow,
      );
      return;
    }
    const issue = refreshed.find(
      (candidate) => candidate.id === entry.issue.id,
    );
    if (issue === undefined) {
      this.#release(
        entry.issue.id,
        entry.workSessionId,
        entry.controllerGeneration,
      );
      return;
    }
    entry.issue = issue;
    const session = this.#stateStore.getSession(entry.workSessionId);
    const policy = sessionTrackerPolicy(session, entry.workflow);
    if (policy === null || policyAllowsAuthoring(issue, policy)) {
      this.#scheduleRetry(
        issue,
        entry.workSessionId,
        entry.controllerGeneration,
        1,
        null,
        "continuation",
        entry.freshAttemptGeneration,
        entry.workflow,
      );
      return;
    }
    this.#release(issue.id, entry.workSessionId, entry.controllerGeneration);
    await this.#reconcileDeliveries([issue], entry.tracker, entry.workflow);
  }

  #finishDurableAttempt(entry: RunningEntry, error: unknown | null): boolean {
    if (
      error instanceof SymphonyError &&
      error.code === "runtime_quiescence_refused"
    ) {
      this.#logger.error(
        "attempt outcome=retained reason=quiescence_unproven",
        {
          issue_id: entry.issue.id,
          work_session_id: entry.workSessionId,
          attempt_id: entry.attemptId,
          error: error.message,
        },
      );
      return false;
    }
    let status: Exclude<AttemptStatus, "running">;
    switch (entry.terminationIntent) {
      case "stalled":
        status = "stalled";
        break;
      case "stopping":
        status = "cancelled";
        break;
      case "released":
      case "terminal":
        status = "released";
        break;
      case null:
        status = error === null ? "completed" : "failed";
        break;
    }
    try {
      this.#stateStore.finishAttempt({
        sessionId: entry.workSessionId,
        attemptId: entry.attemptId,
        runtimeLeaseToken: entry.runtimeLeaseToken,
        controllerGeneration: entry.controllerGeneration,
        status,
        error: error === null ? entry.terminationError : errorMessage(error),
        now: iso(this.#clock.nowMs()),
      });
      return true;
    } catch (stateError) {
      this.#logger.error("attempt outcome=retained reason=state_write", {
        issue_id: entry.issue.id,
        work_session_id: entry.workSessionId,
        attempt_id: entry.attemptId,
        error: errorMessage(stateError),
      });
      return false;
    }
  }

  #scheduleRetry(
    issue: Issue,
    workSessionId: string,
    controllerGeneration: number,
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
    const nowMs = this.#clock.nowMs();
    const dueAtMs = nowMs + delayMs;
    this.#stateStore.scheduleRetry({
      sessionId: workSessionId,
      controllerGeneration,
      retry: {
        kind,
        attempt,
        dueAt: iso(dueAtMs),
        error: retryError,
        freshAttemptGeneration: freshGeneration,
        recordedAt: iso(nowMs),
      },
    });
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
      controllerGeneration,
      dueAtMs,
      error: retryError,
      freshAttemptGeneration: freshGeneration,
      issue,
      kind,
      timer,
      workSessionId,
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
        retry.workSessionId,
        retry.controllerGeneration,
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
        retry.workSessionId,
        retry.controllerGeneration,
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
      this.#release(issueId, retry.workSessionId, retry.controllerGeneration);
      return;
    }
    const retrySession = this.#stateStore.getSession(retry.workSessionId);
    const retryPolicy = sessionTrackerPolicy(retrySession, workflow);
    if (issueInTerminalState(issue, workflow, retryPolicy)) {
      if (
        await this.#cleanupWorkspace(
          issue,
          retry.workspaceWorkflow,
          "retry_terminal",
          {
            workSessionId: retry.workSessionId,
            controllerGeneration: retry.controllerGeneration,
          },
        )
      ) {
        this.#markSessionTerminal(
          retry.workSessionId,
          retry.controllerGeneration,
          issue,
        );
      }
      this.#release(issueId, retry.workSessionId, retry.controllerGeneration);
      return;
    }
    if (
      retryPolicy === null
        ? !issueEligibleByConfig(issue, workflow.config)
        : !policyAllowsAuthoring(issue, retryPolicy)
    ) {
      this.#release(issueId, retry.workSessionId, retry.controllerGeneration);
      await this.#reconcileDeliveries([issue], tracker, workflow);
      return;
    }
    const remainsFresh = issueInFreshAttemptState(issue, workflow, retryPolicy);
    const generation = remainsFresh
      ? generationForIssue(issue, workflow, retryPolicy)
      : retry.freshAttemptGeneration;
    if (remainsFresh && generation !== retry.freshAttemptGeneration) {
      this.#release(issueId, retry.workSessionId, retry.controllerGeneration);
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
        this.#release(issueId, retry.workSessionId, retry.controllerGeneration);
        return;
      }
      try {
        await this.#refuseFreshAttempt(
          retry.workSessionId,
          retry.controllerGeneration,
          issue,
          tracker,
          workflow,
          retry.error ?? "Fresh-attempt provisioning was refused",
          generation,
        );
        this.#release(issueId, retry.workSessionId, retry.controllerGeneration);
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
          retry.workSessionId,
          retry.controllerGeneration,
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
        retry.workSessionId,
        retry.controllerGeneration,
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
    workSessionId: string,
    controllerGeneration: number,
    issue: Issue,
    tracker: TrackerAdapter,
    workflow: WorkflowSnapshot,
    reason: string,
    generation: string | null,
  ): Promise<void> {
    const policy = sessionTrackerPolicy(
      this.#stateStore.getSession(workSessionId),
      workflow,
    );
    const failureState =
      policy?.retry.freshAttemptFailureLane ??
      workflow.config.tracker.freshAttemptFailureState;
    if (failureState === null) {
      throw new Error("Fresh-attempt failure state is not configured");
    }
    const control = tracker.freshAttemptControl?.(issue);
    if (control === undefined) {
      throw new Error("Tracker adapter has no fresh-attempt refusal control");
    }
    const effect = this.#stateStore.enqueueEffect({
      sessionId: workSessionId,
      controllerGeneration,
      kind: "tracker.fresh_attempt_refusal",
      idempotencyKey: [
        "fresh-attempt-refusal",
        issue.id,
        generation ?? "no-generation",
      ].join(":"),
      payload: {
        issue_id: issue.id,
        reason,
        failure_state: failureState.trim(),
      },
      now: iso(this.#clock.nowMs()),
    });
    if (effect.status === "failed") {
      throw new StateStoreError(
        "effect_conflict",
        `Fresh-attempt refusal effect ${effect.id} is terminally failed`,
      );
    }
    if (effect.status === "applied") return;

    await control.refuse(reason, failureState);
    this.#stateStore.finishEffect({
      effectId: effect.id,
      controllerGeneration,
      status: "applied",
      result: { failure_state: failureState.trim() },
      now: iso(this.#clock.nowMs()),
    });
    this.#logger.info("fresh_attempt_handoff outcome=completed", {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      effect_id: effect.id,
      target_state: failureState,
    });
  }

  #shouldDispatch(issue: Issue, workflow: WorkflowSnapshot): boolean {
    const session = this.#stateStore.getTrackerSession(
      workflow.config.tracker.kind,
      repositoryIdentity(workflow),
      issue.id,
    );
    const policy = sessionTrackerPolicy(session, workflow);
    return (
      (policy === null
        ? issueEligibleByConfig(issue, workflow.config)
        : policyAllowsAuthoring(issue, policy)) &&
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
    authority?: RepositoryCleanupAuthority,
  ): Promise<boolean> {
    try {
      await this.#agentRunner.cleanupWorkspace(issue, workflow, authority);
      this.#logger.info("workspace_cleanup outcome=completed", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        reason,
      });
      return true;
    } catch (error) {
      this.#logger.warn("workspace_cleanup outcome=failed", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        reason,
        error: errorMessage(error),
      });
      return false;
    }
  }

  #markSessionTerminal(
    workSessionId: string,
    controllerGeneration: number,
    issue: Issue,
  ): void {
    try {
      this.#stateStore.markSessionTerminal(
        workSessionId,
        controllerGeneration,
        normalizedTrackerValue(issue.state) === "cancelled"
          ? "cancelled"
          : "completed",
        iso(this.#clock.nowMs()),
      );
    } catch (error) {
      this.#logger.error(
        "work_session outcome=retained reason=terminal_write",
        {
          issue_id: issue.id,
          work_session_id: workSessionId,
          error: errorMessage(error),
        },
      );
    }
  }

  #release(
    issueId: string,
    workSessionId?: string,
    controllerGeneration?: number,
  ): void {
    const retryEntry = this.#retries.get(issueId);
    const retrySessionId = retryEntry?.workSessionId;
    const retryControllerGeneration = retryEntry?.controllerGeneration;
    this.#cancelRetry(issueId);
    this.#claimed.delete(issueId);
    const sessionId = workSessionId ?? retrySessionId;
    const generation = controllerGeneration ?? retryControllerGeneration;
    if (sessionId === undefined || generation === undefined) return;
    try {
      this.#stateStore.clearRetry(
        sessionId,
        generation,
        iso(this.#clock.nowMs()),
      );
    } catch (error) {
      this.#logger.error("retry outcome=retained reason=state_write", {
        issue_id: issueId,
        work_session_id: sessionId,
        error: errorMessage(error),
      });
    }
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
