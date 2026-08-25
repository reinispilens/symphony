import type { JsonObject } from "../shared/json.js";

export const WORK_SESSION_SCHEMA_VERSION = 2;

export type WorkSessionStatus = "active" | "cancelled" | "completed";
export type ControllerKind = "human" | "tracker";

export interface TrackerOrigin {
  readonly kind: "tracker";
  readonly trackerKind: string;
  readonly repositoryIdentity: string;
  readonly issueId: string;
  readonly issueIdentifier: string;
  readonly issueUrl: string | null;
}

export interface InteractiveOrigin {
  readonly kind: "interactive";
  readonly repositoryIdentity: string;
  readonly initiatingActor: string;
}

export type WorkSessionOrigin = TrackerOrigin | InteractiveOrigin;

export interface DoctrineSnapshot {
  readonly repositoryIdentity: string;
  readonly path: string;
  readonly revision: string;
  readonly digest: string;
}

/** A portable reference to one accepted file at one immutable repository revision. */
export interface RepositoryContentSnapshot {
  readonly repositoryIdentity: string;
  readonly path: string;
  readonly revision: string;
  readonly digest: string;
}

export interface AuthoringContextEntry {
  readonly path: string;
  readonly digest: string;
}

/** The exact trusted product context resolved before the first Attempt starts. */
export interface AuthoringContextSnapshot {
  readonly repositoryIdentity: string;
  readonly revision: string;
  readonly manifestDigest: string;
  readonly entries: readonly AuthoringContextEntry[];
}

/** Host authority is identified, never copied into the product-owned profile. */
export interface DeploymentBindingSnapshot {
  readonly id: string;
  readonly digest: string;
}

export interface AcceptedConfigurationSnapshot {
  readonly productProfile: RepositoryContentSnapshot;
  readonly authoringContext: AuthoringContextSnapshot;
  readonly deploymentBinding: DeploymentBindingSnapshot;
}

export interface ControllerAssignment {
  readonly kind: ControllerKind;
  readonly controllerId: string;
  readonly generation: number;
  readonly assignedAt: string;
}

export interface DecisionEntry {
  readonly id: string;
  readonly kind: "decision" | "exception" | "steering";
  readonly text: string;
  readonly acceptedBy: string;
  readonly principleId: string | null;
  /** Present on exceptions so the exact governing doctrine is self-contained. */
  readonly doctrine: DoctrineSnapshot | null;
  readonly recordedAt: string;
}

export interface WorkPlan {
  readonly version: number;
  readonly summary: string;
  readonly acceptanceCriteria: readonly string[];
  readonly recordedBy: string;
  readonly recordedAt: string;
}

export type RuntimeLeaseStatus = "active" | "expired" | "released";

export interface RuntimeLease {
  readonly token: string;
  readonly holderId: string;
  readonly controllerGeneration: number;
  readonly status: RuntimeLeaseStatus;
  readonly acquiredAt: string;
  readonly renewedAt: string;
  readonly expiresAt: string;
  readonly releasedAt: string | null;
}

export type WorkspaceMode = "legacy-directory" | "legacy-hook" | "managed";

interface WorkspaceLeaseBase {
  readonly path: string;
  readonly workspaceKey: string;
  readonly recordedAt: string;
}

export interface LegacyWorkspaceLease extends WorkspaceLeaseBase {
  readonly mode: "legacy-directory" | "legacy-hook";
  readonly removalPolicy: "guarded";
}

export type ManagedWorkspacePhase =
  | "allocating"
  | "provisioned"
  | "ready"
  | "superseded"
  | "removal_pending"
  | "removed"
  | "retained";

export interface ManagedWorkspaceLease extends WorkspaceLeaseBase {
  readonly mode: "managed";
  readonly removalPolicy: "guarded";
  readonly leaseToken: string;
  readonly controllerGeneration: number;
  readonly driver: "git-worktree";
  readonly driverVersion: 1;
  readonly phase: ManagedWorkspacePhase;
  readonly repositoryIdentity: string;
  readonly profileDigest: string;
  readonly sourceRoot: string;
  readonly workspaceRoot: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly branch: string;
  readonly freshAttemptGeneration: string | null;
  readonly lastError: string | null;
  readonly removedAt: string | null;
}

export type WorkspaceLease = LegacyWorkspaceLease | ManagedWorkspaceLease;

export type HumanCheckoutInspection =
  | {
      /** Used only when migrating a stopped v1 attached lease. */
      readonly status: "unknown";
    }
  | {
      readonly status: "observed";
      readonly headSha: string | null;
      readonly trackedChanges: boolean;
      readonly untrackedChanges: boolean;
      readonly ignoredChanges: boolean;
      readonly observedAt: string;
    };

/**
 * A reference to a human-owned checkout. It is deliberately not a WorkspaceLease,
 * so RepositoryDriver cleanup and materialization cannot accept it.
 */
export interface HumanWorkspaceAttachment {
  readonly kind: "human-attachment";
  readonly id: string;
  readonly ownership: "human";
  readonly path: string;
  readonly repositoryIdentity: string;
  readonly inspection: HumanCheckoutInspection;
  readonly removalPolicy: "never";
  readonly attachedBy: string;
  readonly attachedAt: string;
}

export type PreparationStatus =
  "failed" | "interrupted" | "running" | "setup_refused" | "succeeded";

export interface PreparationDependencyPolicySnapshot {
  readonly id: string;
  readonly digest: string;
  readonly mode: "offline";
  readonly registry: string;
  readonly seedStoreRoot: string;
  readonly pnpmVersion: string;
}

export interface PreparationRecord {
  readonly driver: "pnpm";
  /** Version 1 records predate fail-closed dependency policy snapshots. */
  readonly driverVersion: 1 | 2;
  readonly status: PreparationStatus;
  readonly command: readonly string[];
  readonly manifestDigest: string | null;
  readonly lockfileDigest: string | null;
  readonly inputDigest: string | null;
  readonly dependencyPolicy: PreparationDependencyPolicySnapshot | null;
  readonly cachePath: string;
  readonly lifecycleScripts: false;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly error: string | null;
}

export type AttemptStatus =
  | "cancelled"
  | "completed"
  | "failed"
  | "interrupted"
  | "released"
  | "running"
  | "stalled";

export interface AttemptRecord {
  readonly id: string;
  readonly ordinal: number;
  readonly trackerAttempt: number | null;
  readonly freshAttemptGeneration: string | null;
  readonly status: AttemptStatus;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly error: string | null;
  readonly runtimeLease: RuntimeLease;
  readonly workspaceLease: WorkspaceLease | null;
  readonly preparation: PreparationRecord | null;
  readonly runtimeCorrelation: {
    readonly processId: number | null;
    readonly sessionId: string | null;
  };
}

export interface RetryIntent {
  readonly kind: "continuation" | "failure" | "fresh_handoff";
  readonly attempt: number;
  readonly dueAt: string;
  readonly error: string | null;
  readonly freshAttemptGeneration: string | null;
  readonly recordedAt: string;
}

export interface ProofCorrelation {
  readonly id: string;
  readonly checkName: string | null;
  readonly checkRunId: string | null;
  readonly workflowRunId: string | null;
  readonly sourceSha: string;
  readonly planDigest: string;
  readonly adapterDigest: string | null;
  readonly policyDigest: string | null;
  readonly resultDigest: string | null;
  readonly evidenceDigest: string | null;
  readonly status:
    "pending" | "passed" | "failed" | "setup_refused" | "non_verdict";
  readonly recordedAt: string;
  readonly observedAt: string | null;
}

export type MaterializationPhase =
  | "intent_recorded"
  | "snapshot_recorded"
  | "tree_written"
  | "commit_written"
  | "branch_updated"
  | "refused";

export interface SourceMaterializationRecord {
  readonly id: string;
  readonly attemptId: string;
  readonly workspaceLeaseToken: string;
  readonly controllerGeneration: number;
  readonly phase: MaterializationPhase;
  readonly parentSha: string;
  readonly branch: string;
  readonly expectedOldSha: string;
  readonly inclusionPolicyDigest: string;
  readonly inputManifestDigest: string | null;
  readonly treeSha: string | null;
  readonly commitSha: string | null;
  readonly lastError: string | null;
  readonly startedAt: string;
  readonly updatedAt: string;
}

export type DeliveryPhase =
  | "intent_recorded"
  | "push_pending"
  | "pushed"
  | "pull_request_pending"
  | "pull_request_open"
  | "checks_pending"
  | "review_pending"
  | "merge_pending"
  | "merged"
  | "cleanup_pending"
  | "completed"
  | "refused";

export type RequiredCheckStatus =
  "pending" | "passed" | "failed" | "setup_refused" | "non_verdict";

export interface RequiredCheckObservation {
  readonly name: string;
  readonly headSha: string;
  readonly checkRunId: string | null;
  readonly workflowRunId: string | null;
  readonly status: RequiredCheckStatus;
  readonly observedAt: string | null;
}

export interface DeliveryState {
  readonly phase: DeliveryPhase;
  readonly materializationId: string | null;
  readonly branch: string | null;
  readonly pullRequest: string | null;
  readonly immutableHeadSha: string | null;
  readonly expectedRemoteHeadSha: string | null;
  readonly remoteHeadSha: string | null;
  readonly requiredChecks: readonly RequiredCheckObservation[];
  readonly mergeSha: string | null;
  readonly cleanupStatus:
    "not_started" | "pending" | "completed" | "retained" | "refused";
  readonly releaseIntentId: string | null;
  readonly lastError: string | null;
  readonly startedAt: string;
  readonly updatedAt: string;
}

export interface WorkSessionDocument {
  readonly schemaVersion: typeof WORK_SESSION_SCHEMA_VERSION;
  readonly id: string;
  readonly origin: WorkSessionOrigin;
  readonly repositoryIdentity: string;
  readonly intent: string;
  readonly status: WorkSessionStatus;
  readonly doctrine: DoctrineSnapshot | null;
  /** Null is a named tracker-compatibility state until Phase 2 resolves bindings. */
  readonly configuration: AcceptedConfigurationSnapshot | null;
  readonly controller: ControllerAssignment;
  readonly decisions: readonly DecisionEntry[];
  readonly plan: WorkPlan | null;
  readonly humanAttachment: HumanWorkspaceAttachment | null;
  readonly attempts: readonly AttemptRecord[];
  readonly retry: RetryIntent | null;
  readonly materializations: readonly SourceMaterializationRecord[];
  readonly proof: readonly ProofCorrelation[];
  readonly delivery: DeliveryState | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkSessionSnapshot extends WorkSessionDocument {
  /** Optimistic-concurrency revision, incremented by every successful mutation. */
  readonly revision: number;
}

export interface StartTrackerSessionInput {
  readonly trackerKind: string;
  readonly repositoryIdentity: string;
  readonly issueId: string;
  readonly issueIdentifier: string;
  readonly issueUrl: string | null;
  readonly intent: string;
  readonly controllerId: string;
  readonly doctrine: DoctrineSnapshot | null;
  readonly configuration: AcceptedConfigurationSnapshot | null;
  readonly now: string;
}

export interface StartInteractiveSessionInput {
  readonly repositoryIdentity: string;
  readonly initiatingActor: string;
  readonly intent: string;
  readonly controllerId: string;
  readonly doctrine: DoctrineSnapshot;
  readonly configuration: AcceptedConfigurationSnapshot;
  readonly now: string;
}

export interface ReplacePlanInput {
  readonly sessionId: string;
  readonly expectedRevision: number;
  readonly controllerGeneration: number;
  readonly summary: string;
  readonly acceptanceCriteria: readonly string[];
  readonly recordedBy: string;
  readonly now: string;
}

export interface AppendDecisionInput {
  readonly sessionId: string;
  readonly expectedRevision: number;
  readonly controllerGeneration: number;
  readonly kind: DecisionEntry["kind"];
  readonly text: string;
  readonly acceptedBy: string;
  readonly principleId: string | null;
  readonly now: string;
}

export interface AttachHumanWorkspaceInput {
  readonly sessionId: string;
  readonly expectedRevision: number;
  readonly controllerId: string;
  readonly path: string;
  readonly repositoryIdentity: string;
  readonly inspection: Extract<HumanCheckoutInspection, { status: "observed" }>;
  readonly now: string;
}

export interface StartAttemptInput {
  readonly sessionId: string;
  readonly controllerGeneration: number;
  readonly holderId: string;
  readonly trackerAttempt: number | null;
  readonly freshAttemptGeneration: string | null;
  readonly now: string;
  readonly leaseExpiresAt: string;
}

export interface StartedAttempt {
  readonly session: WorkSessionSnapshot;
  readonly attemptId: string;
  readonly runtimeLeaseToken: string;
  readonly controllerGeneration: number;
}

/** A timed-out runtime whose external process boundary must be quiesced before expiry is recorded. */
export interface ExpiredRuntimeLeaseCandidate {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly runtimeLeaseToken: string;
  readonly controllerGeneration: number;
  readonly expiresAt: string;
}

export interface ExpireRuntimeLeaseInput {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly runtimeLeaseToken: string;
  readonly controllerGeneration: number;
  readonly now: string;
}

export interface RecordWorkspaceInput {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly runtimeLeaseToken: string;
  readonly controllerGeneration: number;
  readonly mode: "legacy-directory" | "legacy-hook";
  readonly path: string;
  readonly workspaceKey: string;
  readonly now: string;
}

export interface BeginManagedWorkspaceInput {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly runtimeLeaseToken: string;
  readonly controllerGeneration: number;
  readonly path: string;
  readonly workspaceKey: string;
  readonly repositoryIdentity: string;
  readonly profileDigest: string;
  readonly sourceRoot: string;
  readonly workspaceRoot: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly branch: string;
  readonly freshAttemptGeneration: string | null;
  readonly now: string;
}

export interface BegunManagedWorkspace {
  readonly session: WorkSessionSnapshot;
  readonly workspaceLeaseToken: string;
}

export interface TransitionManagedWorkspaceInput {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly workspaceLeaseToken: string;
  readonly controllerGeneration: number;
  /** Present for provisioning; null requires that no runtime lease is active. */
  readonly runtimeLeaseToken: string | null;
  /** Defaults to attemptId; set when a fresh attempt replaces an older lease. */
  readonly runtimeAttemptId?: string;
  readonly expectedPhases: readonly ManagedWorkspacePhase[];
  readonly phase: ManagedWorkspacePhase;
  readonly error: string | null;
  readonly now: string;
}

export interface RuntimeCorrelationInput {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly runtimeLeaseToken: string;
  readonly controllerGeneration: number;
  readonly processId?: number;
  readonly sessionIdValue?: string;
  readonly now: string;
}

export interface StartPreparationInput {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly runtimeLeaseToken: string;
  readonly controllerGeneration: number;
  readonly command: readonly string[];
  readonly manifestDigest: string | null;
  readonly lockfileDigest: string | null;
  readonly inputDigest: string | null;
  readonly dependencyPolicy: PreparationDependencyPolicySnapshot;
  readonly cachePath: string;
  readonly now: string;
}

export interface FinishPreparationInput {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly runtimeLeaseToken: string;
  readonly controllerGeneration: number;
  readonly status: Exclude<PreparationStatus, "running">;
  readonly error: string | null;
  readonly now: string;
}

export interface FinishAttemptInput {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly runtimeLeaseToken: string;
  readonly controllerGeneration: number;
  readonly status: Exclude<AttemptStatus, "running">;
  readonly error: string | null;
  readonly now: string;
}

export interface RenewRuntimeLeaseInput {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly runtimeLeaseToken: string;
  readonly controllerGeneration: number;
  readonly now: string;
  readonly leaseExpiresAt: string;
}

export interface ScheduleRetryInput {
  readonly sessionId: string;
  readonly controllerGeneration: number;
  readonly retry: RetryIntent;
}

export interface EffectIntent {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly controllerGeneration: number;
  readonly status: "pending" | "applied" | "failed";
  readonly payload: JsonObject;
  readonly result: JsonObject | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
