import { describe, expect, it } from "vitest";

import type { WorkSessionDocument } from "../../src/state/model.js";
import { parseWorkSessionDocument } from "../../src/state/validation.js";
import { acceptedGovernanceFixture } from "../support/factories.js";

const CREATED = "2026-08-25T10:00:00.000Z";
const GOVERNANCE = acceptedGovernanceFixture();
const DOCTRINE = GOVERNANCE.doctrine;

function completeDocument(): WorkSessionDocument {
  return {
    schemaVersion: 2,
    id: "session-1",
    origin: {
      kind: "interactive",
      repositoryIdentity: "acme/widgets",
      initiatingActor: "owner",
    },
    repositoryIdentity: "acme/widgets",
    intent: "Deliver one immutable change",
    status: "completed",
    doctrine: DOCTRINE,
    configuration: {
      productProfile: {
        repositoryIdentity: "acme/widgets",
        path: ".symphony/repository-profile.json",
        revision: "a".repeat(40),
        digest: "sha256:profile",
      },
      authoringContext: {
        repositoryIdentity: "acme/widgets",
        revision: "a".repeat(40),
        manifestDigest: "sha256:context",
        entries: [{ path: "AGENTS.md", digest: "sha256:agents" }],
      },
      deploymentBinding: {
        id: "widgets-production",
        digest: "sha256:binding",
      },
      governanceManifest: GOVERNANCE.governanceManifest,
      trackerPolicy: GOVERNANCE.trackerPolicy,
      deliveryGrant: null,
    },
    controller: {
      kind: "human",
      controllerId: "human:owner",
      generation: 1,
      assignedAt: CREATED,
    },
    decisions: [
      {
        id: "decision-1",
        kind: "exception",
        text: "Accept the recorded exception",
        acceptedBy: "human:owner",
        principleId: "GP-15",
        doctrine: DOCTRINE,
        recordedAt: "2026-08-25T10:00:01.000Z",
      },
    ],
    plan: {
      version: 1,
      summary: "Materialize and prove the accepted source",
      acceptanceCriteria: ["Required CI checks pass on the immutable head"],
      recordedBy: "human:owner",
      recordedAt: "2026-08-25T10:00:02.000Z",
    },
    humanAttachment: null,
    attempts: [
      {
        id: "attempt-1",
        ordinal: 1,
        trackerAttempt: null,
        freshAttemptGeneration: null,
        status: "completed",
        startedAt: "2026-08-25T10:01:00.000Z",
        finishedAt: "2026-08-25T10:03:00.000Z",
        error: null,
        runtimeLease: {
          token: "runtime-lease-1",
          holderId: "daemon-1",
          controllerGeneration: 1,
          status: "released",
          acquiredAt: "2026-08-25T10:01:00.000Z",
          renewedAt: "2026-08-25T10:01:00.000Z",
          expiresAt: "2026-08-25T10:02:00.000Z",
          releasedAt: "2026-08-25T10:03:00.000Z",
        },
        workspaceLease: {
          mode: "managed",
          removalPolicy: "guarded",
          path: "/workspaces/widgets-1",
          workspaceKey: "WID-1",
          recordedAt: "2026-08-25T10:01:00.000Z",
          leaseToken: "workspace-lease-1",
          controllerGeneration: 1,
          driver: "git-worktree",
          driverVersion: 1,
          phase: "removed",
          repositoryIdentity: "acme/widgets",
          profileDigest: "sha256:profile",
          sourceRoot: "/repositories/widgets",
          workspaceRoot: "/workspaces",
          baseRef: "refs/remotes/origin/main",
          baseSha: "a".repeat(40),
          branch: "symphony/WID-1",
          freshAttemptGeneration: null,
          lastError: null,
          removedAt: "2026-08-25T10:10:00.000Z",
        },
        preparation: null,
        runtimeCorrelation: { processId: 123, sessionId: "thread-1" },
      },
    ],
    retry: null,
    materializations: [
      {
        id: "materialization-1",
        attemptId: "attempt-1",
        workspaceLeaseToken: "workspace-lease-1",
        controllerGeneration: 1,
        phase: "branch_updated",
        parentSha: "a".repeat(40),
        branch: "symphony/WID-1",
        expectedOldSha: "a".repeat(40),
        inclusionPolicyDigest: "sha256:inclusion-policy",
        inputManifestDigest: "sha256:input-manifest",
        inputManifest: [
          {
            path: "src/index.ts",
            kind: "regular",
            mode: "100644",
            size: 12,
            contentDigest: "sha256:source",
            blobSha: "d".repeat(40),
            origin: "tracked",
          },
        ],
        treeSha: "b".repeat(40),
        commitSha: "c".repeat(40),
        lastError: null,
        startedAt: "2026-08-25T10:04:00.000Z",
        updatedAt: "2026-08-25T10:05:00.000Z",
      },
    ],
    deliveryHistory: [],
    delivery: {
      phase: "completed",
      materializationId: "materialization-1",
      branch: "symphony/WID-1",
      pullRequest: "https://example.test/acme/widgets/pull/1",
      immutableHeadSha: "c".repeat(40),
      expectedRemoteHeadSha: null,
      remoteHeadSha: "c".repeat(40),
      requiredChecks: [
        {
          name: "test",
          headSha: "c".repeat(40),
          checkRunId: "1001",
          workflowRunId: "2001",
          status: "passed",
          observedAt: "2026-08-25T10:07:00.000Z",
        },
      ],
      mergeSha: "d".repeat(40),
      cleanupStatus: "completed",
      releaseIntentId: "effect-release-1",
      lastError: null,
      startedAt: "2026-08-25T10:05:00.000Z",
      updatedAt: "2026-08-25T10:10:00.000Z",
    },
    createdAt: CREATED,
    updatedAt: "2026-08-25T10:10:00.000Z",
  };
}

describe("WorkSession document v2", () => {
  it("round-trips the complete configuration, materialization, and delivery contract", () => {
    const document = completeDocument();
    expect(parseWorkSessionDocument(JSON.stringify(document))).toEqual(
      document,
    );
  });

  it("refuses a delivery check from a different immutable head", () => {
    const document = JSON.parse(
      JSON.stringify(completeDocument()),
    ) as WorkSessionDocument;
    const delivery = document.delivery;
    if (delivery === null) throw new Error("fixture delivery is missing");
    (delivery.requiredChecks[0] as { headSha: string }).headSha = "e".repeat(
      40,
    );
    expect(() =>
      parseWorkSessionDocument(JSON.stringify(document)),
    ).toThrowError(expect.objectContaining({ code: "state_corrupt" }));
  });

  it("refuses to deserialize a human attachment as an Attempt workspace lease", () => {
    const document = JSON.parse(
      JSON.stringify(completeDocument()),
    ) as WorkSessionDocument;
    (document.attempts[0] as { workspaceLease: unknown }).workspaceLease = {
      mode: "attached",
      path: "/workspaces/human",
      workspaceKey: "human",
      removalPolicy: "never",
      recordedAt: CREATED,
    };
    (
      document as unknown as {
        materializations: unknown[];
        delivery: unknown;
      }
    ).materializations = [];
    (document as unknown as { delivery: unknown }).delivery = null;
    expect(() =>
      parseWorkSessionDocument(JSON.stringify(document)),
    ).toThrowError(expect.objectContaining({ code: "state_corrupt" }));
  });
});
