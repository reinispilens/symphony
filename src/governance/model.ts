import type { RepositoryContentSnapshot } from "../state/model.js";

export const ACCEPTED_GOVERNANCE_SCHEMA_VERSION = 1;
export const TRACKER_POLICY_SCHEMA_VERSION = 1;

export const LANE_DELIVERY_OPERATIONS = [
  "materialize",
  "push",
  "openPullRequest",
  "observeChecks",
  "mergePullRequest",
  "releaseRemoteBranch",
  "cleanupWorkspace",
] as const;

export const DELIVERY_OPERATIONS = [
  ...LANE_DELIVERY_OPERATIONS,
  "observeMerge",
] as const;

export type LaneDeliveryOperation = (typeof LANE_DELIVERY_OPERATIONS)[number];
export type DeliveryOperation = (typeof DELIVERY_OPERATIONS)[number];
export type TrackerActorKind = "agent" | "human";

export interface AcceptedGovernanceManifestDocument {
  readonly schemaVersion: typeof ACCEPTED_GOVERNANCE_SCHEMA_VERSION;
  readonly repositoryIdentity: string;
  readonly acceptedRevision: string;
  readonly artifacts: {
    readonly doctrine: {
      readonly path: string;
      readonly digest: string;
    };
    readonly trackerPolicy: {
      readonly path: string;
      readonly digest: string;
    };
  };
}

export interface TrackerDriverLabel {
  readonly key: string;
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface TrackerLanePolicy {
  readonly name: string;
  readonly writers: readonly TrackerActorKind[];
  readonly active: boolean;
  readonly terminal: boolean;
  readonly authoring: boolean;
  readonly freshAttempt: boolean;
  readonly delivery: Readonly<Record<LaneDeliveryOperation, boolean>>;
}

export interface TrackerPolicyDocument {
  readonly schemaVersion: typeof TRACKER_POLICY_SCHEMA_VERSION;
  readonly policyId: string;
  readonly drivers: {
    readonly exactlyOneRequired: true;
    readonly changeOnlyInLane: string;
    readonly labels: readonly TrackerDriverLabel[];
  };
  readonly lanes: readonly TrackerLanePolicy[];
  readonly deliveryProfiles: Readonly<
    Record<"owner-gated" | "full-in-scope", readonly DeliveryOperation[]>
  >;
  readonly retry: {
    readonly continuation: "same-work-session-and-workspace";
    readonly failure: "same-work-session-with-bounded-backoff";
    readonly rework: "fresh-attempt-discarding-prior-workspace-and-workpad";
    readonly freshAttemptFailureLane: string;
  };
}

/** The complete accepted policy value plus the immutable Git blob that supplied it. */
export interface TrackerPolicySnapshot extends TrackerPolicyDocument {
  readonly source: RepositoryContentSnapshot;
}

export interface TrackerPolicyRuntimeProjection {
  readonly requiredLabels: readonly string[];
  readonly excludedLabels: readonly string[];
  readonly activeStates: readonly string[];
  readonly terminalStates: readonly string[];
  readonly freshAttemptStates: readonly string[];
  readonly freshAttemptFailureState: string;
}

export interface ResolvedGovernance {
  readonly manifest: AcceptedGovernanceManifestDocument;
  readonly manifestReference: RepositoryContentSnapshot;
  readonly doctrineReference: RepositoryContentSnapshot;
  readonly trackerPolicy: TrackerPolicySnapshot;
}
