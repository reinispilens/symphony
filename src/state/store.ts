import type { JsonObject } from "../shared/json.js";
import type {
  AppendDecisionInput,
  AttachHumanWorkspaceInput,
  BeginManagedWorkspaceInput,
  BegunManagedWorkspace,
  EffectIntent,
  ExpiredRuntimeLeaseCandidate,
  ExpireRuntimeLeaseInput,
  FinishAttemptInput,
  FinishPreparationInput,
  RecordWorkspaceInput,
  ReplacePlanInput,
  RenewRuntimeLeaseInput,
  RuntimeCorrelationInput,
  ScheduleRetryInput,
  StartAttemptInput,
  StartedAttempt,
  StartInteractiveSessionInput,
  StartPreparationInput,
  StartTrackerSessionInput,
  TransitionManagedWorkspaceInput,
  WorkSessionSnapshot,
} from "./model.js";

export type StateStoreErrorCode =
  | "active_runtime_lease"
  | "controller_conflict"
  | "effect_conflict"
  | "input_conflict"
  | "repository_mismatch"
  | "retry_not_due"
  | "state_corrupt"
  | "state_not_found"
  | "stale_fence"
  | "stale_revision"
  | "workspace_conflict";

export class StateStoreError extends Error {
  readonly code: StateStoreErrorCode;

  constructor(
    code: StateStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StateStoreError";
    this.code = code;
  }
}

export interface SymphonyStateStore {
  getOrCreateTrackerSession(
    input: StartTrackerSessionInput,
  ): WorkSessionSnapshot;
  createInteractiveSession(
    input: StartInteractiveSessionInput,
  ): WorkSessionSnapshot;
  getSession(sessionId: string): WorkSessionSnapshot | null;
  getTrackerSession(
    trackerKind: string,
    repositoryIdentity: string,
    issueId: string,
  ): WorkSessionSnapshot | null;
  listActiveSessions(): readonly WorkSessionSnapshot[];
  replacePlan(input: ReplacePlanInput): WorkSessionSnapshot;
  appendDecision(input: AppendDecisionInput): WorkSessionSnapshot;
  attachHumanWorkspace(input: AttachHumanWorkspaceInput): WorkSessionSnapshot;
  listExpiredRuntimeLeases(
    now: string,
  ): readonly ExpiredRuntimeLeaseCandidate[];
  expireRuntimeLease(input: ExpireRuntimeLeaseInput): WorkSessionSnapshot;
  startAttempt(input: StartAttemptInput): StartedAttempt;
  renewRuntimeLease(input: RenewRuntimeLeaseInput): WorkSessionSnapshot;
  recordWorkspace(input: RecordWorkspaceInput): WorkSessionSnapshot;
  beginManagedWorkspace(
    input: BeginManagedWorkspaceInput,
  ): BegunManagedWorkspace;
  transitionManagedWorkspace(
    input: TransitionManagedWorkspaceInput,
  ): WorkSessionSnapshot;
  recordRuntimeCorrelation(input: RuntimeCorrelationInput): WorkSessionSnapshot;
  startPreparation(input: StartPreparationInput): WorkSessionSnapshot;
  finishPreparation(input: FinishPreparationInput): WorkSessionSnapshot;
  finishAttempt(input: FinishAttemptInput): WorkSessionSnapshot;
  scheduleRetry(input: ScheduleRetryInput): WorkSessionSnapshot;
  clearRetry(
    sessionId: string,
    controllerGeneration: number,
    now: string,
  ): WorkSessionSnapshot;
  markSessionTerminal(
    sessionId: string,
    controllerGeneration: number,
    status: "cancelled" | "completed",
    now: string,
  ): WorkSessionSnapshot;
  enqueueEffect(input: {
    readonly sessionId: string;
    readonly controllerGeneration: number;
    readonly kind: string;
    readonly idempotencyKey: string;
    readonly payload: JsonObject;
    readonly now: string;
  }): EffectIntent;
  finishEffect(input: {
    readonly effectId: string;
    readonly controllerGeneration: number;
    readonly status: "applied" | "failed";
    readonly result: JsonObject;
    readonly now: string;
  }): EffectIntent;
  listPendingEffects(): readonly EffectIntent[];
  backup(destinationPath: string): Promise<void>;
  close(): void;
}
