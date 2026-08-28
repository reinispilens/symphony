import { errorMessage, SymphonyError } from "../errors.js";
import type { DeliveryOperation } from "../governance/model.js";
import type {
  DeliveryPhase,
  DeliveryState,
  EffectIntent,
  ManagedWorkspaceLease,
  WorkSessionSnapshot,
} from "../state/model.js";
import type { SymphonyStateStore } from "../state/store.js";
import type {
  DeliveryObservation,
  DeliveryProvider,
  DeliveryProviderRequest,
  TrackerDeliveryAuthority,
} from "./provider.js";

export type DeliveryResumeOutcome =
  | {
      readonly status: "awaiting_checks";
      readonly session: WorkSessionSnapshot;
    }
  | { readonly status: "awaiting_owner"; readonly session: WorkSessionSnapshot }
  | {
      readonly status: "awaiting_cleanup_authority";
      readonly session: WorkSessionSnapshot;
    }
  | {
      readonly status: "cleanup_required";
      readonly session: WorkSessionSnapshot;
    }
  | { readonly status: "completed"; readonly session: WorkSessionSnapshot }
  | {
      readonly status: "product_failed";
      readonly session: WorkSessionSnapshot;
    };

export interface DeliveryCoordinatorOptions {
  readonly provider: DeliveryProvider;
  readonly stateStore: SymphonyStateStore;
  readonly now?: () => Date;
}

export interface StartDeliveryOptions {
  readonly sessionId: string;
  readonly materializationId: string;
  readonly controllerGeneration: number;
  readonly tracker: TrackerDeliveryAuthority;
  readonly expectedRemoteHeadSha?: string | null;
}

export interface ResumeDeliveryOptions {
  readonly sessionId: string;
  readonly controllerGeneration: number;
  readonly tracker: TrackerDeliveryAuthority;
}

export type AbandonDeliveryOptions = ResumeDeliveryOptions;

function deliveryRefused(message: string): SymphonyError {
  return new SymphonyError("delivery_refused", message);
}

function requiredSession(
  stateStore: SymphonyStateStore,
  sessionId: string,
  controllerGeneration: number,
): WorkSessionSnapshot {
  const session = stateStore.getSession(sessionId);
  if (session === null) {
    throw deliveryRefused(`WorkSession ${sessionId} does not exist`);
  }
  if (
    session.status !== "active" ||
    session.controller.generation !== controllerGeneration
  ) {
    throw deliveryRefused(
      `WorkSession ${sessionId} is not controlled by generation ${controllerGeneration}`,
    );
  }
  return session;
}

function deliveryLease(session: WorkSessionSnapshot): ManagedWorkspaceLease {
  const materialization = session.materializations.find(
    (candidate) => candidate.id === session.delivery?.materializationId,
  );
  const attempt = session.attempts.find(
    (candidate) => candidate.id === materialization?.attemptId,
  );
  const lease = attempt?.workspaceLease;
  if (
    materialization?.phase !== "branch_updated" ||
    materialization.commitSha === null ||
    lease?.mode !== "managed" ||
    lease.leaseToken !== materialization.workspaceLeaseToken
  ) {
    throw deliveryRefused(
      "Delivery is not bound to one immutable managed workspace",
    );
  }
  return lease;
}

function validateTrackerAuthority(
  session: WorkSessionSnapshot,
  tracker: TrackerDeliveryAuthority,
): void {
  if (!Number.isFinite(Date.parse(tracker.observedAt))) {
    throw deliveryRefused(
      "Tracker delivery authority has an invalid observation time",
    );
  }
  if (session.origin.kind === "tracker") {
    if (
      tracker.origin !== "tracker" ||
      tracker.issueId !== session.origin.issueId ||
      tracker.state === null ||
      tracker.stateVersion === null
    ) {
      throw deliveryRefused(
        "Current tracker delivery authority does not match the WorkSession origin",
      );
    }
  } else if (tracker.origin !== "interactive" || tracker.issueId !== null) {
    throw deliveryRefused(
      "Interactive delivery authority must remain boardless and issue-free",
    );
  }
  if (
    new Set(tracker.permittedOperations).size !==
    tracker.permittedOperations.length
  ) {
    throw deliveryRefused(
      "Tracker delivery authority contains duplicate permitted operations",
    );
  }
}

function requireOperation(
  tracker: TrackerDeliveryAuthority,
  operation: DeliveryOperation,
  message: string,
): void {
  if (!tracker.permittedOperations.includes(operation)) {
    throw deliveryRefused(message);
  }
}

function requiredDelivery(session: WorkSessionSnapshot): DeliveryState {
  if (session.delivery === null) {
    throw deliveryRefused(`WorkSession ${session.id} has no delivery state`);
  }
  return session.delivery;
}

function requestBase(
  session: WorkSessionSnapshot,
  tracker: TrackerDeliveryAuthority,
  idempotencyKey: string,
): Omit<DeliveryProviderRequest, "operation"> {
  const delivery = requiredDelivery(session);
  const lease = deliveryLease(session);
  const grant = session.configuration?.deliveryGrant;
  if (
    grant === null ||
    grant === undefined ||
    delivery.branch === null ||
    delivery.immutableHeadSha === null
  ) {
    throw deliveryRefused(
      "Delivery has no pinned product-owner grant or immutable head",
    );
  }
  return {
    protocolVersion: 1,
    idempotencyKey,
    sessionId: session.id,
    controllerGeneration: session.controller.generation,
    repositoryIdentity: session.repositoryIdentity,
    grant,
    tracker,
    branch: delivery.branch,
    baseRef: lease.baseRef,
    immutableHeadSha: delivery.immutableHeadSha,
  };
}

function exactPullRequest(
  session: WorkSessionSnapshot,
  observation: DeliveryObservation,
  allowClosed = false,
): NonNullable<DeliveryObservation["pullRequest"]> | null {
  const delivery = requiredDelivery(session);
  const lease = deliveryLease(session);
  const pullRequest = observation.pullRequest;
  if (pullRequest === null) return null;
  if (
    pullRequest.headRef !== delivery.branch ||
    pullRequest.headSha !== delivery.immutableHeadSha ||
    pullRequest.baseRef !== lease.baseRef
  ) {
    throw deliveryRefused(
      "Observed pull request is not bound to the exact branch, base, and immutable head",
    );
  }
  if (pullRequest.state === "closed" && !allowClosed) {
    throw deliveryRefused("The exact pull request was closed without merge");
  }
  if (pullRequest.state === "merged" && pullRequest.mergeSha === null) {
    throw deliveryRefused(
      "Merged pull request observation has no merge commit",
    );
  }
  return pullRequest;
}

function exactRemoteHead(
  session: WorkSessionSnapshot,
  observation: DeliveryObservation,
  allowAbsent: boolean,
): void {
  const head = requiredDelivery(session).immutableHeadSha;
  if (
    observation.remoteHeadSha !== head &&
    !(allowAbsent && observation.remoteHeadSha === null)
  ) {
    throw deliveryRefused(
      `Remote branch is ${observation.remoteHeadSha ?? "absent"}, not the expected immutable head ${head}`,
    );
  }
}

function effectPayload(session: WorkSessionSnapshot): {
  readonly repository: string;
  readonly branch: string;
  readonly head: string;
} {
  const delivery = requiredDelivery(session);
  return {
    repository: session.repositoryIdentity,
    branch: delivery.branch!,
    head: delivery.immutableHeadSha!,
  };
}

/** Durable delivery saga. Calling resume never sleeps; pending checks remain persisted. */
export class DeliveryCoordinator {
  readonly #now: () => Date;
  readonly #provider: DeliveryProvider;
  readonly #stateStore: SymphonyStateStore;

  constructor(options: DeliveryCoordinatorOptions) {
    this.#provider = options.provider;
    this.#stateStore = options.stateStore;
    this.#now = options.now ?? (() => new Date());
  }

  async start(options: StartDeliveryOptions): Promise<DeliveryResumeOutcome> {
    let session = requiredSession(
      this.#stateStore,
      options.sessionId,
      options.controllerGeneration,
    );
    validateTrackerAuthority(session, options.tracker);
    session = this.#stateStore.beginDelivery({
      sessionId: session.id,
      materializationId: options.materializationId,
      controllerGeneration: options.controllerGeneration,
      expectedRemoteHeadSha: options.expectedRemoteHeadSha ?? null,
      now: this.#timestamp(),
    });
    return this.resume({
      sessionId: session.id,
      controllerGeneration: options.controllerGeneration,
      tracker: options.tracker,
    });
  }

  async resume(options: ResumeDeliveryOptions): Promise<DeliveryResumeOutcome> {
    let session = requiredSession(
      this.#stateStore,
      options.sessionId,
      options.controllerGeneration,
    );
    validateTrackerAuthority(session, options.tracker);
    for (let transitions = 0; transitions < 16; transitions += 1) {
      const delivery = requiredDelivery(session);
      switch (delivery.phase) {
        case "intent_recorded":
          requireOperation(
            options.tracker,
            "push",
            "Current tracker authority does not permit remote delivery",
          );
          session = this.#transition(session, ["intent_recorded"], {
            phase: "push_pending",
          });
          break;
        case "push_pending": {
          requireOperation(
            options.tracker,
            "push",
            "Current tracker authority no longer permits the pending push",
          );
          const key = `delivery:push:${delivery.immutableHeadSha}`;
          const effect = this.#effect(session, "delivery.push", key);
          const before = await this.#observe(
            session,
            options.tracker,
            `${key}:observe`,
          );
          exactRemoteHead(session, before, true);
          let observation = before;
          if (before.remoteHeadSha === null) {
            if (effect.status === "applied") {
              throw deliveryRefused(
                `Applied push effect ${effect.id} no longer has its exact remote branch`,
              );
            }
            const lease = deliveryLease(session);
            observation = await this.#executeMutation(
              session,
              options.tracker,
              effect,
              {
                ...requestBase(session, options.tracker, key),
                operation: "push",
                sourceRoot: lease.sourceRoot,
                expectedRemoteHeadSha: delivery.expectedRemoteHeadSha,
              },
            );
          }
          exactRemoteHead(session, observation, false);
          this.#finishEffect(effect, {
            remote_head_sha: delivery.immutableHeadSha!,
          });
          session = this.#transition(session, ["push_pending"], {
            phase: "pushed",
            remoteHeadSha: delivery.immutableHeadSha,
          });
          break;
        }
        case "pushed":
          session = this.#transition(session, ["pushed"], {
            phase: "pull_request_pending",
          });
          break;
        case "pull_request_pending": {
          requireOperation(
            options.tracker,
            "openPullRequest",
            "Current tracker authority no longer permits pull-request creation",
          );
          const key = `delivery:pull-request:${delivery.immutableHeadSha}`;
          const effect = this.#effect(
            session,
            "delivery.open_pull_request",
            key,
          );
          let observation = await this.#observe(
            session,
            options.tracker,
            `${key}:observe`,
          );
          exactRemoteHead(session, observation, false);
          let pullRequest = exactPullRequest(session, observation);
          if (pullRequest === null) {
            if (effect.status === "applied") {
              throw deliveryRefused(
                `Applied pull-request effect ${effect.id} no longer has its exact pull request`,
              );
            }
            observation = await this.#executeMutation(
              session,
              options.tracker,
              effect,
              {
                ...requestBase(session, options.tracker, key),
                operation: "open_pull_request",
                title: session.intent.slice(0, 200),
                body: this.#pullRequestBody(session),
              },
            );
            exactRemoteHead(session, observation, false);
            pullRequest = exactPullRequest(session, observation);
          }
          if (pullRequest === null) {
            throw deliveryRefused(
              "Delivery provider did not expose the exact pull request after creation",
            );
          }
          this.#finishEffect(effect, {
            pull_request_id: pullRequest.id,
            pull_request_url: pullRequest.url,
          });
          session = this.#transition(session, ["pull_request_pending"], {
            phase: "pull_request_open",
            pullRequest: pullRequest.url,
          });
          break;
        }
        case "pull_request_open":
          session = this.#transition(session, ["pull_request_open"], {
            phase: "checks_pending",
          });
          break;
        case "checks_pending": {
          requireOperation(
            options.tracker,
            "observeChecks",
            "Current tracker authority does not permit required-check observation",
          );
          const observation = await this.#observe(
            session,
            options.tracker,
            `delivery:checks:${delivery.immutableHeadSha}`,
          );
          const pullRequest = exactPullRequest(session, observation);
          if (pullRequest === null) {
            throw deliveryRefused(
              "The exact pull request disappeared while checks were pending",
            );
          }
          exactRemoteHead(session, observation, pullRequest.state === "merged");
          const checks = this.#requiredChecks(session, observation);
          if (pullRequest.state === "merged") {
            if (checks.some((check) => check.status !== "passed")) {
              throw deliveryRefused(
                "The exact pull request merged without every accepted required check passing",
              );
            }
            session = this.#transition(session, ["checks_pending"], {
              phase: "merged",
              requiredChecks: checks,
              mergeSha: pullRequest.mergeSha,
            });
            break;
          }
          session = this.#transition(session, ["checks_pending"], {
            phase: "checks_pending",
            requiredChecks: checks,
          });
          if (checks.some((check) => check.status === "pending")) {
            return { status: "awaiting_checks", session };
          }
          if (checks.some((check) => check.status !== "passed")) {
            return { status: "product_failed", session };
          }
          session = this.#transition(session, ["checks_pending"], {
            phase: "review_pending",
            requiredChecks: checks,
          });
          break;
        }
        case "review_pending": {
          requireOperation(
            options.tracker,
            "observeMerge",
            "Current tracker authority does not permit merge observation",
          );
          const observation = await this.#observe(
            session,
            options.tracker,
            `delivery:review:${delivery.immutableHeadSha}`,
          );
          const pullRequest = exactPullRequest(session, observation);
          if (pullRequest?.state === "merged") {
            session = this.#transition(session, ["review_pending"], {
              phase: "merged",
              mergeSha: pullRequest.mergeSha,
            });
            break;
          }
          const grant = session.configuration!.deliveryGrant!;
          if (grant.authority === "owner-gated") {
            return { status: "awaiting_owner", session };
          }
          if (!options.tracker.permitsMerge) {
            return { status: "awaiting_owner", session };
          }
          session = this.#transition(session, ["review_pending"], {
            phase: "merge_pending",
          });
          break;
        }
        case "merge_pending": {
          if (
            session.configuration?.deliveryGrant?.authority !==
              "full-in-scope" ||
            !options.tracker.permitsMerge
          ) {
            throw deliveryRefused(
              "Pending merge no longer has both full-in-scope and current tracker authority",
            );
          }
          requireOperation(
            options.tracker,
            "mergePullRequest",
            "Current tracker authority no longer permits merge",
          );
          const key = `delivery:merge:${delivery.immutableHeadSha}`;
          const effect = this.#effect(session, "delivery.merge", key);
          let observation = await this.#observe(
            session,
            options.tracker,
            `${key}:observe`,
          );
          let pullRequest = exactPullRequest(session, observation);
          if (pullRequest === null) {
            throw deliveryRefused(
              "The exact pull request disappeared before merge",
            );
          }
          if (pullRequest.state !== "merged") {
            exactRemoteHead(session, observation, false);
            if (effect.status === "applied") {
              throw deliveryRefused(
                `Applied merge effect ${effect.id} is not reflected by the exact pull request`,
              );
            }
            observation = await this.#executeMutation(
              session,
              options.tracker,
              effect,
              {
                ...requestBase(session, options.tracker, key),
                operation: "merge_pull_request",
                pullRequestId: pullRequest.id,
              },
            );
            pullRequest = exactPullRequest(session, observation);
          }
          if (
            pullRequest?.state !== "merged" ||
            pullRequest.mergeSha === null
          ) {
            throw deliveryRefused(
              "Delivery provider did not expose the exact merged pull request",
            );
          }
          this.#finishEffect(effect, { merge_sha: pullRequest.mergeSha });
          session = this.#transition(session, ["merge_pending"], {
            phase: "merged",
            mergeSha: pullRequest.mergeSha,
          });
          break;
        }
        case "merged":
          if (!options.tracker.permitsCleanup) {
            return { status: "awaiting_cleanup_authority", session };
          }
          requireOperation(
            options.tracker,
            "releaseRemoteBranch",
            "Current tracker authority does not permit remote-branch release",
          );
          {
            const effect = this.#effect(
              session,
              "delivery.delete_remote_branch",
              `delivery:delete-remote-branch:${delivery.immutableHeadSha}`,
            );
            session = this.#transition(session, ["merged"], {
              phase: "cleanup_pending",
              cleanupStatus: "pending",
              releaseIntentId: effect.id,
            });
          }
          break;
        case "cleanup_pending": {
          if (!options.tracker.permitsCleanup) {
            return { status: "awaiting_cleanup_authority", session };
          }
          requireOperation(
            options.tracker,
            "releaseRemoteBranch",
            "Current tracker authority does not permit remote-branch release",
          );
          const key = `delivery:delete-remote-branch:${delivery.immutableHeadSha}`;
          const effect = this.#effect(
            session,
            "delivery.delete_remote_branch",
            key,
          );
          if (delivery.releaseIntentId !== effect.id) {
            throw deliveryRefused(
              "Cleanup is not bound to its recorded remote-branch release intent",
            );
          }
          let observation = await this.#observe(
            session,
            options.tracker,
            `${key}:observe`,
          );
          const pullRequest = exactPullRequest(session, observation);
          if (pullRequest?.state !== "merged") {
            throw deliveryRefused(
              "Remote-branch cleanup requires the exact merged pull request",
            );
          }
          if (observation.remoteHeadSha !== null) {
            exactRemoteHead(session, observation, false);
            if (effect.status === "applied") {
              throw deliveryRefused(
                `Applied remote-branch release ${effect.id} is no longer reflected by provider truth`,
              );
            }
            observation = await this.#executeMutation(
              session,
              options.tracker,
              effect,
              {
                ...requestBase(session, options.tracker, key),
                operation: "delete_remote_branch",
                sourceRoot: deliveryLease(session).sourceRoot,
                expectedRemoteHeadSha: delivery.immutableHeadSha!,
              },
            );
          }
          if (observation.remoteHeadSha !== null) {
            throw deliveryRefused(
              "Delivery provider did not confirm exact remote-branch removal",
            );
          }
          this.#finishEffect(effect, { remote_branch: "absent" });
          return { status: "cleanup_required", session };
        }
        case "completed":
          return { status: "completed", session };
        case "refused":
          throw deliveryRefused(
            delivery.lastError ?? "Delivery was previously refused",
          );
      }
    }
    throw new SymphonyError(
      "delivery_provider_failed",
      "Delivery saga exceeded its bounded transition count",
    );
  }

  completeCleanup(
    options: ResumeDeliveryOptions & {
      readonly cleanupStatus: "completed" | "retained";
    },
  ): WorkSessionSnapshot {
    const session = requiredSession(
      this.#stateStore,
      options.sessionId,
      options.controllerGeneration,
    );
    validateTrackerAuthority(session, options.tracker);
    return this.#transition(session, ["cleanup_pending"], {
      phase: "completed",
      cleanupStatus: options.cleanupStatus,
    });
  }

  async abandon(options: AbandonDeliveryOptions): Promise<{
    readonly status: "cleanup_required";
    readonly session: WorkSessionSnapshot;
  }> {
    let session = requiredSession(
      this.#stateStore,
      options.sessionId,
      options.controllerGeneration,
    );
    validateTrackerAuthority(session, options.tracker);
    const delivery = requiredDelivery(session);
    if (delivery.phase === "completed") {
      throw deliveryRefused(
        "Completed delivery cannot be abandoned for Rework",
      );
    }
    requireOperation(
      options.tracker,
      "releaseRemoteBranch",
      "Current tracker authority does not permit delivery release for Rework",
    );
    requireOperation(
      options.tracker,
      "cleanupWorkspace",
      "Current tracker authority does not permit workspace cleanup for Rework",
    );

    const observeKey = `delivery:abandon:${delivery.immutableHeadSha}`;
    let observation = await this.#observe(session, options.tracker, observeKey);
    let pullRequest = exactPullRequest(session, observation, true);
    if (pullRequest?.state === "merged") {
      throw deliveryRefused(
        "An exact merged pull request must complete delivery; it cannot be abandoned",
      );
    }
    if (pullRequest !== null) {
      const closeEffect = this.#effect(
        session,
        "delivery.close_pull_request",
        `${observeKey}:close-pull-request`,
      );
      if (pullRequest.state === "open") {
        if (closeEffect.status === "applied") {
          throw deliveryRefused(
            `Applied pull-request closure ${closeEffect.id} is no longer reflected by provider truth`,
          );
        }
        observation = await this.#executeMutation(
          session,
          options.tracker,
          closeEffect,
          {
            ...requestBase(
              session,
              options.tracker,
              `${observeKey}:close-pull-request`,
            ),
            operation: "close_pull_request",
            pullRequestId: pullRequest.id,
          },
        );
        pullRequest = exactPullRequest(session, observation, true);
      }
      if (pullRequest?.state !== "closed") {
        throw deliveryRefused(
          "Delivery provider did not confirm exact pull-request closure",
        );
      }
      this.#finishEffect(closeEffect, { pull_request_state: "closed" });
    }

    const releaseEffect = this.#effect(
      session,
      "delivery.delete_remote_branch",
      `${observeKey}:delete-remote-branch`,
    );
    if (observation.remoteHeadSha !== null) {
      exactRemoteHead(session, observation, false);
      if (releaseEffect.status === "applied") {
        throw deliveryRefused(
          `Applied remote-branch release ${releaseEffect.id} is no longer reflected by provider truth`,
        );
      }
      observation = await this.#executeMutation(
        session,
        options.tracker,
        releaseEffect,
        {
          ...requestBase(
            session,
            options.tracker,
            `${observeKey}:delete-remote-branch`,
          ),
          operation: "delete_remote_branch",
          sourceRoot: deliveryLease(session).sourceRoot,
          expectedRemoteHeadSha: delivery.immutableHeadSha!,
        },
      );
    }
    if (observation.remoteHeadSha !== null) {
      throw deliveryRefused(
        "Delivery provider did not confirm exact remote-branch removal for Rework",
      );
    }
    this.#finishEffect(releaseEffect, { remote_branch: "absent" });
    session = this.#transition(session, [delivery.phase], {
      phase: "refused",
      remoteHeadSha: null,
      cleanupStatus: "pending",
      releaseIntentId: releaseEffect.id,
      error: "Delivery abandoned before a fresh Rework Attempt",
    });
    return { status: "cleanup_required", session };
  }

  completeAbandonmentCleanup(
    options: AbandonDeliveryOptions,
  ): WorkSessionSnapshot {
    const session = requiredSession(
      this.#stateStore,
      options.sessionId,
      options.controllerGeneration,
    );
    validateTrackerAuthority(session, options.tracker);
    const delivery = requiredDelivery(session);
    if (delivery.phase !== "refused" || delivery.lastError === null) {
      throw deliveryRefused(
        "Delivery has no abandoned Rework cleanup to complete",
      );
    }
    return this.#transition(session, ["refused"], {
      phase: "refused",
      cleanupStatus: "completed",
      error: delivery.lastError,
    });
  }

  #effect(
    session: WorkSessionSnapshot,
    kind: string,
    idempotencyKey: string,
  ): EffectIntent {
    return this.#stateStore.enqueueEffect({
      sessionId: session.id,
      controllerGeneration: session.controller.generation,
      kind,
      idempotencyKey,
      payload: effectPayload(session),
      now: this.#timestamp(),
    });
  }

  #finishEffect(effect: EffectIntent, result: Record<string, string>): void {
    if (effect.status === "applied") return;
    if (effect.status === "failed") {
      throw deliveryRefused(`Delivery effect ${effect.id} is already failed`);
    }
    this.#stateStore.finishEffect({
      effectId: effect.id,
      controllerGeneration: effect.controllerGeneration,
      status: "applied",
      result,
      now: this.#timestamp(),
    });
  }

  async #observe(
    session: WorkSessionSnapshot,
    tracker: TrackerDeliveryAuthority,
    idempotencyKey: string,
  ): Promise<DeliveryObservation> {
    return this.#provider.execute({
      ...requestBase(session, tracker, idempotencyKey),
      operation: "observe",
    });
  }

  async #executeMutation(
    session: WorkSessionSnapshot,
    tracker: TrackerDeliveryAuthority,
    effect: EffectIntent,
    request: DeliveryProviderRequest,
  ): Promise<DeliveryObservation> {
    if (effect.status === "failed") {
      throw deliveryRefused(`Delivery effect ${effect.id} is already failed`);
    }
    try {
      return await this.#provider.execute(request);
    } catch (error) {
      if (
        error instanceof SymphonyError &&
        error.code === "delivery_provider_refused"
      ) {
        throw error;
      }
      // A process error is ambiguous: observe provider truth before any retry.
      try {
        return await this.#observe(
          session,
          tracker,
          `${request.idempotencyKey}:reconcile`,
        );
      } catch {
        throw new SymphonyError(
          "delivery_provider_failed",
          `Delivery effect ${effect.id} has an ambiguous outcome: ${errorMessage(error)}`,
          { cause: error },
        );
      }
    }
  }

  #requiredChecks(
    session: WorkSessionSnapshot,
    observation: DeliveryObservation,
  ): DeliveryState["requiredChecks"] {
    const expected = session.configuration?.deliveryGrant?.requiredChecks;
    const head = requiredDelivery(session).immutableHeadSha;
    if (expected === undefined || head === null) {
      throw deliveryRefused("Delivery required-check authority is missing");
    }
    const checks = expected.map((name) => {
      const matches = observation.requiredChecks.filter(
        (candidate) => candidate.name === name,
      );
      if (matches.length !== 1) {
        throw deliveryRefused(
          `Expected exactly one source-bound observation for required check ${name}`,
        );
      }
      const check = matches[0]!;
      if (check.headSha !== head) {
        throw deliveryRefused(
          `Required check ${name} belongs to ${check.headSha}, not ${head}`,
        );
      }
      return check;
    });
    return checks;
  }

  #pullRequestBody(session: WorkSessionSnapshot): string {
    const origin =
      session.origin.kind === "tracker"
        ? `Tracker: ${session.origin.issueIdentifier}${
            session.origin.issueUrl === null
              ? ""
              : ` (${session.origin.issueUrl})`
          }`
        : `Interactive controller: ${session.origin.initiatingActor}`;
    return [
      "Authored and delivered by Symphony from a fenced WorkSession.",
      "",
      origin,
      `WorkSession: ${session.id}`,
      `Accepted profile: ${session.configuration!.productProfile.revision}`,
      `Delivery policy: ${session.configuration!.deliveryGrant!.governingPolicy.revision}`,
    ].join("\n");
  }

  #transition(
    session: WorkSessionSnapshot,
    expectedPhases: readonly DeliveryPhase[],
    update: Omit<
      Parameters<SymphonyStateStore["transitionDelivery"]>[0],
      "sessionId" | "controllerGeneration" | "expectedPhases" | "now"
    >,
  ): WorkSessionSnapshot {
    return this.#stateStore.transitionDelivery({
      sessionId: session.id,
      controllerGeneration: session.controller.generation,
      expectedPhases,
      ...update,
      now: this.#timestamp(),
    });
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }
}
