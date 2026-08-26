import { describe, expect, it } from "vitest";

import { DeliveryCoordinator } from "../../src/delivery/coordinator.js";
import type {
  DeliveryObservation,
  DeliveryProvider,
  DeliveryProviderRequest,
  PullRequestObservation,
  TrackerDeliveryAuthority,
} from "../../src/delivery/provider.js";
import type {
  ProofCorrelation,
  RequiredCheckObservation,
} from "../../src/state/model.js";
import { SqliteSymphonyStateStore } from "../../src/state/sqlite-store.js";
import {
  acceptedGovernanceFixture,
  protectedProofAuthorityFixture,
} from "../support/factories.js";

const START = "2026-08-26T10:00:00.000Z";
const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "d".repeat(40);
const MERGE_SHA = "e".repeat(40);
const CHECK_NAME = "proof / Protected final";

function configuration(authority: "owner-gated" | "full-in-scope") {
  const governance = acceptedGovernanceFixture();
  return {
    productProfile: {
      repositoryIdentity: "acme/widgets",
      path: ".symphony/repository-profile.json",
      revision: "1".repeat(40),
      digest: "sha256:profile",
    },
    authoringContext: {
      repositoryIdentity: "acme/widgets",
      revision: "1".repeat(40),
      manifestDigest: "sha256:context",
      entries: [],
    },
    deploymentBinding: { id: "widgets-test", digest: "sha256:binding" },
    governanceManifest: governance.governanceManifest,
    trackerPolicy: governance.trackerPolicy,
    deliveryGrant: {
      authority,
      governingPolicy: governance.trackerPolicy.source,
      requiredChecks: [CHECK_NAME],
    },
    proofAuthority: protectedProofAuthorityFixture(CHECK_NAME),
  } as const;
}

function trackerAuthority(permitsMerge = false): TrackerDeliveryAuthority {
  return {
    origin: "tracker",
    issueId: "widgets-1",
    state: "Human Review",
    stateVersion: "state-7",
    permittedOperations: [
      "materialize",
      "push",
      "openPullRequest",
      "observeChecks",
      "observeMerge",
      "releaseRemoteBranch",
      "cleanupWorkspace",
      ...(permitsMerge ? (["mergePullRequest"] as const) : []),
    ],
    permitsDelivery: true,
    permitsMerge,
    permitsCleanup: true,
    observedAt: START,
  };
}

function reworkAuthority(): TrackerDeliveryAuthority {
  return {
    origin: "tracker",
    issueId: "widgets-1",
    state: "Rework",
    stateVersion: "state-rework-1",
    permittedOperations: [
      "observeMerge",
      "releaseRemoteBranch",
      "cleanupWorkspace",
    ],
    permitsDelivery: false,
    permitsMerge: false,
    permitsCleanup: true,
    observedAt: START,
  };
}

function passedCheck(headSha = HEAD_SHA): RequiredCheckObservation {
  return {
    name: CHECK_NAME,
    headSha,
    checkRunId: "check-1",
    workflowRunId: "workflow-1",
    status: "passed",
    observedAt: "2026-08-26T10:01:00.000Z",
  };
}

function passedProof(headSha = HEAD_SHA): ProofCorrelation {
  return {
    id: "proof-1",
    checkName: CHECK_NAME,
    checkRunId: "check-1",
    workflowRunId: "workflow-1",
    sourceSha: headSha,
    planDigest: `sha256:${"1".repeat(64)}`,
    adapterDigest: `sha256:${"2".repeat(64)}`,
    policyDigest: `sha256:${"3".repeat(64)}`,
    resultDigest: `sha256:${"4".repeat(64)}`,
    evidenceDigest: `sha256:${"5".repeat(64)}`,
    status: "passed",
    recordedAt: "2026-08-26T10:00:30.000Z",
    observedAt: "2026-08-26T10:01:00.000Z",
  };
}

class FakeDeliveryProvider implements DeliveryProvider {
  remoteHeadSha: string | null = null;
  pullRequest: PullRequestObservation | null = null;
  requiredChecks: readonly RequiredCheckObservation[] = [
    {
      ...passedCheck(),
      checkRunId: null,
      workflowRunId: null,
      status: "pending",
      observedAt: null,
    },
  ];
  proof: readonly ProofCorrelation[] = [];
  failAfterPushOnce = false;
  readonly calls: DeliveryProviderRequest[] = [];

  async execute(
    request: DeliveryProviderRequest,
  ): Promise<DeliveryObservation> {
    this.calls.push(request);
    switch (request.operation) {
      case "observe":
        break;
      case "push":
        if (this.remoteHeadSha !== request.expectedRemoteHeadSha) {
          throw new Error("unexpected remote-ref state");
        }
        this.remoteHeadSha = request.immutableHeadSha;
        if (this.failAfterPushOnce) {
          this.failAfterPushOnce = false;
          throw new Error("connection lost after push");
        }
        break;
      case "open_pull_request":
        this.pullRequest ??= {
          id: "42",
          url: "https://github.com/acme/widgets/pull/42",
          state: "open",
          baseRef: request.baseRef,
          headRef: request.branch,
          headSha: request.immutableHeadSha,
          mergeSha: null,
        };
        break;
      case "merge_pull_request":
        if (
          this.pullRequest === null ||
          this.pullRequest.id !== request.pullRequestId
        ) {
          throw new Error("pull request does not exist");
        }
        this.pullRequest = {
          ...this.pullRequest,
          state: "merged",
          mergeSha: MERGE_SHA,
        };
        break;
      case "close_pull_request":
        if (
          this.pullRequest === null ||
          this.pullRequest.id !== request.pullRequestId
        ) {
          throw new Error("pull request does not exist");
        }
        this.pullRequest = {
          ...this.pullRequest,
          state: "closed",
          mergeSha: null,
        };
        break;
      case "delete_remote_branch":
        if (this.remoteHeadSha !== request.expectedRemoteHeadSha) {
          throw new Error("remote branch moved");
        }
        this.remoteHeadSha = null;
        break;
    }
    return this.observation();
  }

  observation(): DeliveryObservation {
    return {
      remoteHeadSha: this.remoteHeadSha,
      pullRequest: this.pullRequest,
      requiredChecks: this.requiredChecks,
      proof: this.proof,
    };
  }

  count(operation: DeliveryProviderRequest["operation"]): number {
    return this.calls.filter((request) => request.operation === operation)
      .length;
  }
}

function fixture(authority: "owner-gated" | "full-in-scope") {
  const governance = acceptedGovernanceFixture();
  const store = SqliteSymphonyStateStore.openInMemory();
  const session = store.getOrCreateTrackerSession({
    trackerKind: "test",
    repositoryIdentity: "acme/widgets",
    issueId: "widgets-1",
    issueIdentifier: "WID-1",
    issueUrl: "https://github.com/acme/widgets/issues/1",
    intent: "Deliver one immutable change",
    controllerId: "tracker:test:acme/widgets",
    doctrine: governance.doctrine,
    configuration: configuration(authority),
    now: START,
  });
  const started = store.startAttempt({
    sessionId: session.id,
    controllerGeneration: 1,
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
    profileDigest: configuration(authority).productProfile.digest,
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
  const materialization = store.beginMaterialization({
    sessionId: session.id,
    attemptId: started.attemptId,
    workspaceLeaseToken: workspace.workspaceLeaseToken,
    controllerGeneration: started.controllerGeneration,
    parentSha: BASE_SHA,
    branch: "symphony/widgets",
    expectedOldSha: BASE_SHA,
    inclusionPolicyDigest: "sha256:materialization-v1",
    now: "2026-08-26T10:00:05.000Z",
  });
  store.transitionMaterialization({
    sessionId: session.id,
    materializationId: materialization.materializationId,
    controllerGeneration: started.controllerGeneration,
    expectedPhases: ["intent_recorded"],
    phase: "snapshot_recorded",
    inputManifestDigest: "sha256:manifest",
    inputManifest: [],
    now: "2026-08-26T10:00:06.000Z",
  });
  store.transitionMaterialization({
    sessionId: session.id,
    materializationId: materialization.materializationId,
    controllerGeneration: started.controllerGeneration,
    expectedPhases: ["snapshot_recorded"],
    phase: "tree_written",
    treeSha: "c".repeat(40),
    now: "2026-08-26T10:00:07.000Z",
  });
  store.transitionMaterialization({
    sessionId: session.id,
    materializationId: materialization.materializationId,
    controllerGeneration: started.controllerGeneration,
    expectedPhases: ["tree_written"],
    phase: "commit_written",
    commitSha: HEAD_SHA,
    now: "2026-08-26T10:00:08.000Z",
  });
  store.transitionMaterialization({
    sessionId: session.id,
    materializationId: materialization.materializationId,
    controllerGeneration: started.controllerGeneration,
    expectedPhases: ["commit_written"],
    phase: "branch_updated",
    now: "2026-08-26T10:00:09.000Z",
  });
  const provider = new FakeDeliveryProvider();
  let tick = 9;
  const coordinator = () =>
    new DeliveryCoordinator({
      provider,
      stateStore: store,
      now: () =>
        new Date(`2026-08-26T10:00:${String(++tick).padStart(2, "0")}.000Z`),
    });
  return {
    coordinator,
    materializationId: materialization.materializationId,
    provider,
    sessionId: session.id,
    started,
    store,
  };
}

describe("DeliveryCoordinator", () => {
  it("closes the exact unmerged pull request and remote branch before Rework", async () => {
    const setup = fixture("owner-gated");
    try {
      await expect(
        setup.coordinator().start({
          sessionId: setup.sessionId,
          materializationId: setup.materializationId,
          controllerGeneration: setup.started.controllerGeneration,
          tracker: trackerAuthority(),
        }),
      ).resolves.toMatchObject({ status: "awaiting_checks" });

      const abandoned = await setup.coordinator().abandon({
        sessionId: setup.sessionId,
        controllerGeneration: setup.started.controllerGeneration,
        tracker: reworkAuthority(),
      });
      expect(abandoned.session.delivery).toMatchObject({
        phase: "refused",
        cleanupStatus: "pending",
        remoteHeadSha: null,
      });
      expect(setup.provider.count("close_pull_request")).toBe(1);
      expect(setup.provider.count("delete_remote_branch")).toBe(1);
      expect(setup.provider.pullRequest?.state).toBe("closed");

      const completed = setup.coordinator().completeAbandonmentCleanup({
        sessionId: setup.sessionId,
        controllerGeneration: setup.started.controllerGeneration,
        tracker: reworkAuthority(),
      });
      expect(completed.delivery).toMatchObject({
        phase: "refused",
        cleanupStatus: "completed",
      });
    } finally {
      setup.store.close();
    }
  });

  it("finishes a pending close intent when restart observes the exact PR already closed", async () => {
    const setup = fixture("owner-gated");
    try {
      await setup.coordinator().start({
        sessionId: setup.sessionId,
        materializationId: setup.materializationId,
        controllerGeneration: setup.started.controllerGeneration,
        tracker: trackerAuthority(),
      });
      const close = setup.store.enqueueEffect({
        sessionId: setup.sessionId,
        controllerGeneration: setup.started.controllerGeneration,
        kind: "delivery.close_pull_request",
        idempotencyKey: `delivery:abandon:${HEAD_SHA}:close-pull-request`,
        payload: {
          repository: "acme/widgets",
          branch: "symphony/widgets",
          head: HEAD_SHA,
        },
        now: "2026-08-26T10:00:30.000Z",
      });
      setup.provider.pullRequest = {
        ...setup.provider.pullRequest!,
        state: "closed",
        mergeSha: null,
      };

      await setup.coordinator().abandon({
        sessionId: setup.sessionId,
        controllerGeneration: setup.started.controllerGeneration,
        tracker: reworkAuthority(),
      });

      expect(setup.provider.count("close_pull_request")).toBe(0);
      expect(
        setup.store
          .listPendingEffects()
          .some((effect) => effect.id === close.id),
      ).toBe(false);
    } finally {
      setup.store.close();
    }
  });

  it("never repeats an applied Rework branch release if the branch reappears", async () => {
    const setup = fixture("owner-gated");
    try {
      await setup.coordinator().start({
        sessionId: setup.sessionId,
        materializationId: setup.materializationId,
        controllerGeneration: setup.started.controllerGeneration,
        tracker: trackerAuthority(),
      });
      setup.provider.pullRequest = {
        ...setup.provider.pullRequest!,
        state: "closed",
        mergeSha: null,
      };
      const effect = setup.store.enqueueEffect({
        sessionId: setup.sessionId,
        controllerGeneration: setup.started.controllerGeneration,
        kind: "delivery.delete_remote_branch",
        idempotencyKey: `delivery:abandon:${HEAD_SHA}:delete-remote-branch`,
        payload: {
          repository: "acme/widgets",
          branch: "symphony/widgets",
          head: HEAD_SHA,
        },
        now: "2026-08-26T10:00:30.000Z",
      });
      setup.store.finishEffect({
        effectId: effect.id,
        controllerGeneration: setup.started.controllerGeneration,
        status: "applied",
        result: { remote_branch: "absent" },
        now: "2026-08-26T10:00:31.000Z",
      });

      await expect(
        setup.coordinator().abandon({
          sessionId: setup.sessionId,
          controllerGeneration: setup.started.controllerGeneration,
          tracker: reworkAuthority(),
        }),
      ).rejects.toMatchObject({
        code: "delivery_refused",
        message: expect.stringContaining("no longer reflected"),
      });
      expect(setup.provider.count("delete_remote_branch")).toBe(0);
    } finally {
      setup.store.close();
    }
  });

  it("waits for the owner after exact-head proof and adopts an external merge", async () => {
    const setup = fixture("owner-gated");
    try {
      const first = await setup.coordinator().start({
        sessionId: setup.sessionId,
        materializationId: setup.materializationId,
        controllerGeneration: setup.started.controllerGeneration,
        tracker: trackerAuthority(),
      });
      expect(first.status).toBe("awaiting_checks");
      expect(setup.provider.count("push")).toBe(1);
      expect(setup.provider.count("open_pull_request")).toBe(1);

      setup.provider.requiredChecks = [passedCheck()];
      setup.provider.proof = [passedProof()];
      const review = await setup.coordinator().resume({
        sessionId: setup.sessionId,
        controllerGeneration: setup.started.controllerGeneration,
        tracker: trackerAuthority(),
      });
      expect(review).toMatchObject({
        status: "awaiting_owner",
        session: { delivery: { phase: "review_pending" } },
      });
      expect(setup.provider.count("merge_pull_request")).toBe(0);

      setup.provider.pullRequest = {
        ...setup.provider.pullRequest!,
        state: "merged",
        mergeSha: MERGE_SHA,
      };
      const cleanup = await setup.coordinator().resume({
        sessionId: setup.sessionId,
        controllerGeneration: setup.started.controllerGeneration,
        tracker: trackerAuthority(),
      });
      expect(cleanup).toMatchObject({
        status: "cleanup_required",
        session: { delivery: { mergeSha: MERGE_SHA } },
      });
      expect(setup.provider.count("delete_remote_branch")).toBe(1);
      expect(setup.provider.remoteHeadSha).toBeNull();
      const completed = setup.coordinator().completeCleanup({
        sessionId: setup.sessionId,
        controllerGeneration: setup.started.controllerGeneration,
        tracker: trackerAuthority(),
        cleanupStatus: "completed",
      });
      expect(completed.delivery).toMatchObject({
        phase: "completed",
        cleanupStatus: "completed",
      });
      expect(completed.proof).toEqual([passedProof()]);
    } finally {
      setup.store.close();
    }
  });

  it("merges only with both a full-in-scope grant and current tracker authority", async () => {
    const setup = fixture("full-in-scope");
    try {
      setup.provider.requiredChecks = [passedCheck()];
      setup.provider.proof = [passedProof()];
      const outcome = await setup.coordinator().start({
        sessionId: setup.sessionId,
        materializationId: setup.materializationId,
        controllerGeneration: setup.started.controllerGeneration,
        tracker: trackerAuthority(true),
      });
      expect(outcome).toMatchObject({
        status: "cleanup_required",
        session: {
          delivery: { phase: "cleanup_pending", mergeSha: MERGE_SHA },
        },
      });
      expect(setup.provider.count("merge_pull_request")).toBe(1);
    } finally {
      setup.store.close();
    }
  });

  it("adopts an exact externally merged PR even when its remote branch was auto-removed", async () => {
    const setup = fixture("owner-gated");
    try {
      const pending = await setup.coordinator().start({
        sessionId: setup.sessionId,
        materializationId: setup.materializationId,
        controllerGeneration: setup.started.controllerGeneration,
        tracker: trackerAuthority(),
      });
      expect(pending.status).toBe("awaiting_checks");
      setup.provider.requiredChecks = [passedCheck()];
      setup.provider.proof = [passedProof()];
      setup.provider.pullRequest = {
        ...setup.provider.pullRequest!,
        state: "merged",
        mergeSha: MERGE_SHA,
      };
      setup.provider.remoteHeadSha = null;

      const outcome = await setup.coordinator().resume({
        sessionId: setup.sessionId,
        controllerGeneration: setup.started.controllerGeneration,
        tracker: trackerAuthority(),
      });
      expect(outcome).toMatchObject({
        status: "cleanup_required",
        session: { delivery: { mergeSha: MERGE_SHA } },
      });
      expect(outcome.session.proof).toEqual([passedProof()]);
      expect(setup.provider.count("delete_remote_branch")).toBe(0);
    } finally {
      setup.store.close();
    }
  });

  it("reconciles a crash after push and resumes without duplicate remote mutations", async () => {
    const setup = fixture("owner-gated");
    try {
      setup.provider.failAfterPushOnce = true;
      const pending = await setup.coordinator().start({
        sessionId: setup.sessionId,
        materializationId: setup.materializationId,
        controllerGeneration: setup.started.controllerGeneration,
        tracker: trackerAuthority(),
      });
      expect(pending.status).toBe("awaiting_checks");
      expect(setup.provider.count("push")).toBe(1);
      expect(setup.provider.count("open_pull_request")).toBe(1);

      setup.provider.requiredChecks = [passedCheck()];
      setup.provider.proof = [passedProof()];
      await expect(
        setup.coordinator().resume({
          sessionId: setup.sessionId,
          controllerGeneration: setup.started.controllerGeneration,
          tracker: trackerAuthority(),
        }),
      ).resolves.toMatchObject({ status: "awaiting_owner" });
      expect(setup.provider.count("push")).toBe(1);
      expect(setup.provider.count("open_pull_request")).toBe(1);
    } finally {
      setup.store.close();
    }
  });

  it("refuses a required check from any head other than the immutable source", async () => {
    const setup = fixture("owner-gated");
    try {
      setup.provider.requiredChecks = [passedCheck("f".repeat(40))];
      await expect(
        setup.coordinator().start({
          sessionId: setup.sessionId,
          materializationId: setup.materializationId,
          controllerGeneration: setup.started.controllerGeneration,
          tracker: trackerAuthority(),
        }),
      ).rejects.toMatchObject({
        code: "delivery_refused",
        message: expect.stringContaining("not ddddd"),
      });
      expect(setup.store.getSession(setup.sessionId)?.proof).toEqual([]);
    } finally {
      setup.store.close();
    }
  });

  it("refuses a green check without an exact passed protected-proof correlation", async () => {
    const setup = fixture("owner-gated");
    try {
      setup.provider.requiredChecks = [passedCheck()];
      setup.provider.proof = [];
      await expect(
        setup.coordinator().start({
          sessionId: setup.sessionId,
          materializationId: setup.materializationId,
          controllerGeneration: setup.started.controllerGeneration,
          tracker: trackerAuthority(),
        }),
      ).rejects.toMatchObject({
        code: "delivery_refused",
        message: expect.stringContaining("protected-proof correlation"),
      });
    } finally {
      setup.store.close();
    }
  });

  it("refuses proof correlation without concrete check and workflow run identities", async () => {
    const setup = fixture("owner-gated");
    try {
      setup.provider.requiredChecks = [
        { ...passedCheck(), checkRunId: null, workflowRunId: null },
      ];
      setup.provider.proof = [
        { ...passedProof(), checkRunId: null, workflowRunId: null },
      ];
      await expect(
        setup.coordinator().start({
          sessionId: setup.sessionId,
          materializationId: setup.materializationId,
          controllerGeneration: setup.started.controllerGeneration,
          tracker: trackerAuthority(),
        }),
      ).rejects.toMatchObject({ code: "delivery_refused" });
    } finally {
      setup.store.close();
    }
  });

  it("never repeats an applied push whose external state disappeared", async () => {
    const setup = fixture("owner-gated");
    try {
      setup.store.beginDelivery({
        sessionId: setup.sessionId,
        materializationId: setup.materializationId,
        controllerGeneration: setup.started.controllerGeneration,
        expectedRemoteHeadSha: null,
        now: "2026-08-26T10:00:10.000Z",
      });
      setup.store.transitionDelivery({
        sessionId: setup.sessionId,
        controllerGeneration: setup.started.controllerGeneration,
        expectedPhases: ["intent_recorded"],
        phase: "push_pending",
        now: "2026-08-26T10:00:11.000Z",
      });
      const effect = setup.store.enqueueEffect({
        sessionId: setup.sessionId,
        controllerGeneration: setup.started.controllerGeneration,
        kind: "delivery.push",
        idempotencyKey: `delivery:push:${HEAD_SHA}`,
        payload: {
          repository: "acme/widgets",
          branch: "symphony/widgets",
          head: HEAD_SHA,
        },
        now: "2026-08-26T10:00:12.000Z",
      });
      setup.store.finishEffect({
        effectId: effect.id,
        controllerGeneration: setup.started.controllerGeneration,
        status: "applied",
        result: { remote_head_sha: HEAD_SHA },
        now: "2026-08-26T10:00:13.000Z",
      });

      await expect(
        setup.coordinator().resume({
          sessionId: setup.sessionId,
          controllerGeneration: setup.started.controllerGeneration,
          tracker: trackerAuthority(),
        }),
      ).rejects.toMatchObject({
        code: "delivery_refused",
        message: expect.stringContaining(
          "no longer has its exact remote branch",
        ),
      });
      expect(setup.provider.count("push")).toBe(0);
    } finally {
      setup.store.close();
    }
  });
});
