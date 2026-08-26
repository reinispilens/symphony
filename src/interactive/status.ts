import { createHash } from "node:crypto";

import type {
  AttemptRecord,
  WorkPlan,
  WorkSessionSnapshot,
} from "../state/model.js";

export const WORK_STATUS_SCHEMA_VERSION = 1;

export type EvidencePosture = "advisory" | "protected" | "unproven";

function planDigest(plan: WorkPlan | null): string | null {
  if (plan === null) return null;
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 1,
        summary: plan.summary,
        acceptanceCriteria: plan.acceptanceCriteria,
      }),
    )
    .digest("hex")}`;
}

function activeAttempt(session: WorkSessionSnapshot): AttemptRecord | null {
  return (
    session.attempts.find(
      (attempt) =>
        attempt.runtimeLease.status === "active" &&
        attempt.status === "running",
    ) ?? null
  );
}

export function projectWorkStatus(session: WorkSessionSnapshot) {
  const attempt = activeAttempt(session);
  const digest = planDigest(session.plan);
  const attachment = session.humanAttachment;
  const observedAttachment =
    attachment?.inspection.status === "observed" ? attachment.inspection : null;
  const dirty =
    observedAttachment !== null &&
    (observedAttachment.trackedChanges ||
      observedAttachment.untrackedChanges ||
      observedAttachment.ignoredChanges);
  const matchingProof =
    dirty ||
    digest === null ||
    observedAttachment === null ||
    observedAttachment.headSha === null
      ? undefined
      : session.proof.find(
          (proof) =>
            proof.status === "passed" &&
            proof.sourceSha === observedAttachment.headSha &&
            proof.planDigest === digest,
        );
  const evidence: {
    readonly matchingProofId: string | null;
    readonly planDigest: string | null;
    readonly posture: EvidencePosture;
    readonly reason: string;
  } = dirty
    ? {
        posture: "advisory",
        reason:
          "The recorded attached checkout observation is dirty and has no reconstructable immutable source identity.",
        planDigest: digest,
        matchingProofId: null,
      }
    : matchingProof === undefined
      ? {
          posture: "unproven",
          reason:
            attachment === null
              ? "No human checkout is attached."
              : digest === null
                ? "No durable work plan is recorded."
                : observedAttachment === null ||
                    observedAttachment.headSha === null
                  ? "The attached checkout has no recorded immutable HEAD."
                  : "No passed protected proof matches both the recorded HEAD and current plan digest.",
          planDigest: digest,
          matchingProofId: null,
        }
      : {
          posture: "protected",
          reason:
            "A passed protected proof matches the recorded checkout HEAD and current plan digest.",
          planDigest: digest,
          matchingProofId: matchingProof.id,
        };

  return {
    schemaVersion: WORK_STATUS_SCHEMA_VERSION,
    session: {
      id: session.id,
      revision: session.revision,
      status: session.status,
      origin: session.origin,
      repositoryIdentity: session.repositoryIdentity,
      intent: session.intent,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    },
    controller: session.controller,
    doctrine: session.doctrine,
    configuration:
      session.configuration === null
        ? null
        : {
            deploymentBinding: session.configuration.deploymentBinding,
            productProfile: session.configuration.productProfile,
            authoringContext: {
              repositoryIdentity:
                session.configuration.authoringContext.repositoryIdentity,
              revision: session.configuration.authoringContext.revision,
              manifestDigest:
                session.configuration.authoringContext.manifestDigest,
              entryCount: session.configuration.authoringContext.entries.length,
            },
            governanceManifest: session.configuration.governanceManifest,
            trackerPolicy:
              session.configuration.trackerPolicy === null
                ? null
                : {
                    policyId: session.configuration.trackerPolicy.policyId,
                    source: session.configuration.trackerPolicy.source,
                  },
            deliveryGrant: session.configuration.deliveryGrant,
            proofAuthority: session.configuration.proofAuthority,
          },
    plan: session.plan,
    humanAttachment: session.humanAttachment,
    decisions: {
      count: session.decisions.length,
      truncated: session.decisions.length > 20,
      recent: session.decisions.slice(-20),
    },
    runtime: {
      attemptCount: session.attempts.length,
      activeAttempt:
        attempt === null
          ? null
          : {
              id: attempt.id,
              ordinal: attempt.ordinal,
              status: attempt.status,
              startedAt: attempt.startedAt,
              runtimeLease: {
                controllerGeneration: attempt.runtimeLease.controllerGeneration,
                status: attempt.runtimeLease.status,
                acquiredAt: attempt.runtimeLease.acquiredAt,
                renewedAt: attempt.runtimeLease.renewedAt,
                expiresAt: attempt.runtimeLease.expiresAt,
                releasedAt: attempt.runtimeLease.releasedAt,
              },
              workspace:
                attempt.workspaceLease === null
                  ? null
                  : {
                      mode: attempt.workspaceLease.mode,
                      path: attempt.workspaceLease.path,
                    },
            },
      retry:
        session.retry === null
          ? null
          : {
              kind: session.retry.kind,
              attempt: session.retry.attempt,
              dueAt: session.retry.dueAt,
              recordedAt: session.retry.recordedAt,
              freshAttemptGeneration: session.retry.freshAttemptGeneration,
              hasError: session.retry.error !== null,
            },
    },
    proof: {
      count: session.proof.length,
      truncated: session.proof.length > 20,
      recent: session.proof.slice(-20),
    },
    delivery:
      session.delivery === null
        ? null
        : {
            phase: session.delivery.phase,
            materializationId: session.delivery.materializationId,
            branch: session.delivery.branch,
            pullRequest: session.delivery.pullRequest,
            immutableHeadSha: session.delivery.immutableHeadSha,
            remoteHeadSha: session.delivery.remoteHeadSha,
            requiredChecks: session.delivery.requiredChecks,
            mergeSha: session.delivery.mergeSha,
            cleanupStatus: session.delivery.cleanupStatus,
            releaseIntentId: session.delivery.releaseIntentId,
            startedAt: session.delivery.startedAt,
            updatedAt: session.delivery.updatedAt,
          },
    evidence,
  } as const;
}

export type WorkStatusProjection = ReturnType<typeof projectWorkStatus>;
