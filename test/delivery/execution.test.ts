import { describe, expect, it, vi } from "vitest";

import { TrustedDeliveryExecution } from "../../src/delivery/execution.js";
import type { TrackerDeliveryAuthority } from "../../src/delivery/provider.js";
import type { RepositoryCleanupAuthority } from "../../src/repository/driver.js";
import type {
  AcceptedConfigurationSnapshot,
  DeliveryState,
  SourceMaterializationRecord,
  WorkSessionSnapshot,
} from "../../src/state/model.js";
import { SqliteSymphonyStateStore } from "../../src/state/sqlite-store.js";
import type { WorkflowSnapshot } from "../../src/workflow/store.js";
import {
  acceptedGovernanceFixture,
  issue,
  protectedProofAuthorityFixture,
} from "../support/factories.js";

const START = "2026-08-26T10:00:00.000Z";
const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "d".repeat(40);

function configuration(): AcceptedConfigurationSnapshot {
  const governance = acceptedGovernanceFixture();
  return {
    productProfile: {
      repositoryIdentity: "acme/widgets",
      path: ".symphony/repository-profile.json",
      revision: "1".repeat(40),
      digest: `sha256:${"1".repeat(64)}`,
    },
    authoringContext: {
      repositoryIdentity: "acme/widgets",
      revision: "1".repeat(40),
      manifestDigest: `sha256:${"2".repeat(64)}`,
      entries: [],
    },
    deploymentBinding: {
      id: "widgets-test",
      digest: `sha256:${"3".repeat(64)}`,
    },
    governanceManifest: governance.governanceManifest,
    trackerPolicy: governance.trackerPolicy,
    deliveryGrant: {
      authority: "owner-gated",
      governingPolicy: governance.trackerPolicy.source,
      requiredChecks: ["proof / Protected final"],
    },
    proofAuthority: protectedProofAuthorityFixture(),
  };
}

function trackerAuthority(
  state: "Human Review" | "Rework",
): TrackerDeliveryAuthority {
  return {
    origin: "tracker",
    issueId: "widgets-1",
    state,
    stateVersion: "state-version-1",
    permittedOperations:
      state === "Rework"
        ? ["releaseRemoteBranch", "cleanupWorkspace", "observeMerge"]
        : [
            "materialize",
            "push",
            "openPullRequest",
            "observeChecks",
            "releaseRemoteBranch",
            "cleanupWorkspace",
            "observeMerge",
          ],
    permitsDelivery: state === "Human Review",
    permitsMerge: false,
    permitsCleanup: true,
    observedAt: START,
  };
}

function readySession() {
  const store = SqliteSymphonyStateStore.openInMemory();
  const governance = acceptedGovernanceFixture();
  const session = store.getOrCreateTrackerSession({
    trackerKind: "test",
    repositoryIdentity: "acme/widgets",
    issueId: "widgets-1",
    issueIdentifier: "WID-1",
    issueUrl: "https://github.com/acme/widgets/issues/1",
    intent: "Deliver one immutable change",
    controllerId: "tracker:test:acme/widgets",
    doctrine: governance.doctrine,
    configuration: configuration(),
    now: START,
  });
  const started = store.startAttempt({
    sessionId: session.id,
    controllerGeneration: session.controller.generation,
    holderId: "daemon-test",
    trackerAttempt: null,
    freshAttemptGeneration: null,
    now: START,
    leaseExpiresAt: "2026-08-26T10:05:00.000Z",
  });
  const workspace = store.beginManagedWorkspace({
    sessionId: session.id,
    attemptId: started.attemptId,
    runtimeLeaseToken: started.runtimeLeaseToken,
    controllerGeneration: started.controllerGeneration,
    path: "/workspaces/widgets",
    workspaceKey: "WID-1",
    repositoryIdentity: "acme/widgets",
    profileDigest: configuration().productProfile.digest,
    sourceRoot: "/repositories/widgets",
    workspaceRoot: "/workspaces",
    baseRef: "refs/heads/main",
    baseSha: BASE_SHA,
    branch: "symphony/widgets",
    freshAttemptGeneration: null,
    now: "2026-08-26T10:00:01.000Z",
  });
  store.transitionManagedWorkspace({
    sessionId: session.id,
    attemptId: started.attemptId,
    workspaceLeaseToken: workspace.workspaceLeaseToken,
    controllerGeneration: started.controllerGeneration,
    runtimeLeaseToken: started.runtimeLeaseToken,
    expectedPhases: ["allocating"],
    phase: "provisioned",
    error: null,
    now: "2026-08-26T10:00:02.000Z",
  });
  store.transitionManagedWorkspace({
    sessionId: session.id,
    attemptId: started.attemptId,
    workspaceLeaseToken: workspace.workspaceLeaseToken,
    controllerGeneration: started.controllerGeneration,
    runtimeLeaseToken: started.runtimeLeaseToken,
    expectedPhases: ["provisioned"],
    phase: "ready",
    error: null,
    now: "2026-08-26T10:00:03.000Z",
  });
  store.finishAttempt({
    sessionId: session.id,
    attemptId: started.attemptId,
    runtimeLeaseToken: started.runtimeLeaseToken,
    controllerGeneration: started.controllerGeneration,
    status: "completed",
    error: null,
    now: "2026-08-26T10:00:04.000Z",
  });
  return {
    session: store.getSession(session.id)!,
    started,
    store,
    workspace,
  };
}

function materialization(
  session: WorkSessionSnapshot,
): SourceMaterializationRecord {
  const attempt = session.attempts[0]!;
  const lease = attempt.workspaceLease;
  if (lease?.mode !== "managed") throw new Error("missing managed lease");
  return {
    id: "materialization-1",
    attemptId: attempt.id,
    workspaceLeaseToken: lease.leaseToken,
    controllerGeneration: session.controller.generation,
    phase: "branch_updated",
    parentSha: BASE_SHA,
    branch: lease.branch,
    expectedOldSha: BASE_SHA,
    inclusionPolicyDigest: `sha256:${"4".repeat(64)}`,
    inputManifestDigest: `sha256:${"5".repeat(64)}`,
    inputManifest: [],
    treeSha: "c".repeat(40),
    commitSha: HEAD_SHA,
    lastError: null,
    startedAt: START,
    updatedAt: START,
  };
}

function pendingDelivery(): DeliveryState {
  return {
    phase: "review_pending",
    materializationId: "materialization-1",
    branch: "symphony/widgets",
    pullRequest: "42",
    immutableHeadSha: HEAD_SHA,
    expectedRemoteHeadSha: null,
    remoteHeadSha: HEAD_SHA,
    requiredChecks: [],
    mergeSha: null,
    cleanupStatus: "not_started",
    releaseIntentId: null,
    lastError: null,
    startedAt: START,
    updatedAt: START,
  };
}

const workflow = { path: "/operator/WORKFLOW.md" } as WorkflowSnapshot;

describe("TrustedDeliveryExecution", () => {
  it("composes materialization, delivery, and guarded cleanup in that order", async () => {
    const setup = readySession();
    const sequence: string[] = [];
    const source = materialization(setup.session);
    const materialize = vi.fn(async () => {
      sequence.push("materialize");
      return source;
    });
    const start = vi.fn(async () => {
      sequence.push("delivery");
      return { status: "cleanup_required", session: setup.session } as const;
    });
    const completeCleanup = vi.fn(() => {
      sequence.push("cleanup-recorded");
      return setup.session;
    });
    const cleanupWorkspace = vi.fn(
      async (
        _issue: ReturnType<typeof issue>,
        _workflow: WorkflowSnapshot,
        _authority: RepositoryCleanupAuthority,
      ) => {
        sequence.push("workspace-cleanup");
      },
    );
    const execution = new TrustedDeliveryExecution({
      stateStore: setup.store,
      materializer: { materialize },
      workspace: { cleanupWorkspace },
      coordinator: {
        start,
        resume: vi.fn(async () => {
          throw new Error("resume should not run");
        }),
        completeCleanup,
        abandon: vi.fn(async () => {
          throw new Error("abandon should not run");
        }),
        completeAbandonmentCleanup: vi.fn(() => {
          throw new Error("abandonment cleanup should not run");
        }),
      },
    });

    await expect(
      execution.reconcile({
        issue: issue({ id: "widgets-1", identifier: "WID-1" }),
        sessionId: setup.session.id,
        tracker: trackerAuthority("Human Review"),
        workflow,
      }),
    ).resolves.toMatchObject({ status: "completed" });

    expect(sequence).toEqual([
      "materialize",
      "delivery",
      "workspace-cleanup",
      "cleanup-recorded",
    ]);
    expect(materialize).toHaveBeenCalledWith({
      sessionId: setup.session.id,
      attemptId: setup.started.attemptId,
      workspaceLeaseToken: setup.workspace.workspaceLeaseToken,
      controllerGeneration: setup.session.controller.generation,
    });
    expect(cleanupWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ id: "widgets-1" }),
      workflow,
      {
        workSessionId: setup.session.id,
        controllerGeneration: setup.session.controller.generation,
      },
    );
    setup.store.close();
  });

  it("finishes prior-delivery abandonment before allowing Rework to continue", async () => {
    const setup = readySession();
    const active = { ...setup.session, delivery: pendingDelivery() };
    const sequence: string[] = [];
    const abandoned = {
      ...active,
      delivery: {
        ...active.delivery!,
        phase: "refused" as const,
        cleanupStatus: "pending" as const,
      },
    };
    const completed = {
      ...abandoned,
      delivery: {
        ...abandoned.delivery!,
        cleanupStatus: "completed" as const,
      },
    };
    const abandon = vi.fn(async () => {
      sequence.push("remote-abandonment");
      return { status: "cleanup_required", session: abandoned } as const;
    });
    const completeAbandonmentCleanup = vi.fn(() => {
      sequence.push("cleanup-recorded");
      return completed;
    });
    const cleanupWorkspace = vi.fn(async () => {
      sequence.push("workspace-cleanup");
    });
    const execution = new TrustedDeliveryExecution({
      stateStore: { getSession: () => active },
      materializer: {
        materialize: vi.fn(async () => {
          throw new Error("Rework must not materialize before abandonment");
        }),
      },
      workspace: { cleanupWorkspace },
      coordinator: {
        start: vi.fn(async () => {
          throw new Error("delivery start should not run");
        }),
        resume: vi.fn(async () => {
          throw new Error("delivery resume should not run");
        }),
        completeCleanup: vi.fn(() => {
          throw new Error("ordinary cleanup should not run");
        }),
        abandon,
        completeAbandonmentCleanup,
      },
    });

    await expect(
      execution.reconcile({
        issue: issue({
          id: "widgets-1",
          identifier: "WID-1",
          state: "Rework",
        }),
        sessionId: setup.session.id,
        tracker: trackerAuthority("Rework"),
        workflow,
      }),
    ).resolves.toMatchObject({
      status: "abandoned",
      session: { delivery: { cleanupStatus: "completed" } },
    });

    expect(sequence).toEqual([
      "remote-abandonment",
      "workspace-cleanup",
      "cleanup-recorded",
    ]);
    setup.store.close();
  });
});
