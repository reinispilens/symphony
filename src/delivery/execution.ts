import type { Issue } from "../domain/issue.js";
import { SymphonyError } from "../errors.js";
import { trackerLane } from "../governance/tracker-policy.js";
import type { RepositoryCleanupAuthority } from "../repository/driver.js";
import type {
  SourceMaterializationRecord,
  WorkSessionSnapshot,
} from "../state/model.js";
import type { SymphonyStateStore } from "../state/store.js";
import type { WorkflowSnapshot } from "../workflow/store.js";
import type {
  DeliveryCoordinator,
  DeliveryResumeOutcome,
  AbandonDeliveryOptions,
  ResumeDeliveryOptions,
  StartDeliveryOptions,
} from "./coordinator.js";
import type { MaterializationAuthority } from "./materializer.js";
import type { TrackerDeliveryAuthority } from "./provider.js";

export interface DeliveryWorkspacePort {
  cleanupWorkspace(
    issue: Issue,
    workflow: WorkflowSnapshot,
    authority: RepositoryCleanupAuthority,
  ): Promise<void>;
}

export interface DeliveryExecutionInput {
  readonly issue: Issue;
  readonly sessionId: string;
  readonly tracker: TrackerDeliveryAuthority;
  readonly workflow: WorkflowSnapshot;
}

export type DeliveryExecutionOutcome =
  | DeliveryResumeOutcome
  | { readonly status: "abandoned"; readonly session: WorkSessionSnapshot }
  | {
      readonly status: "not_applicable";
      readonly session: WorkSessionSnapshot;
    };

export interface DeliveryExecutionPort {
  reconcile(input: DeliveryExecutionInput): Promise<DeliveryExecutionOutcome>;
}

export class NoopDeliveryExecutionPort implements DeliveryExecutionPort {
  constructor(
    private readonly stateStore: Pick<SymphonyStateStore, "getSession">,
  ) {}

  async reconcile(
    input: DeliveryExecutionInput,
  ): Promise<DeliveryExecutionOutcome> {
    const session = this.stateStore.getSession(input.sessionId);
    if (session === null) {
      throw new SymphonyError(
        "delivery_refused",
        `WorkSession ${input.sessionId} does not exist`,
      );
    }
    return { status: "not_applicable", session };
  }
}

export interface TrustedDeliveryExecutionOptions {
  readonly coordinator: Pick<
    DeliveryCoordinator,
    | "start"
    | "resume"
    | "completeCleanup"
    | "abandon"
    | "completeAbandonmentCleanup"
  >;
  readonly materializer: {
    materialize(
      authority: MaterializationAuthority,
    ): Promise<SourceMaterializationRecord>;
  };
  readonly stateStore: Pick<SymphonyStateStore, "getSession">;
  readonly workspace: DeliveryWorkspacePort;
}

function latestDeliverableAttempt(session: WorkSessionSnapshot) {
  return [...session.attempts]
    .sort((left, right) => right.ordinal - left.ordinal)
    .find(
      (attempt) =>
        (attempt.status === "completed" || attempt.status === "released") &&
        attempt.runtimeLease.status !== "active" &&
        attempt.workspaceLease?.mode === "managed" &&
        attempt.workspaceLease.phase === "ready",
    );
}

/**
 * Application service joining trusted local materialization, remote delivery,
 * and guarded local cleanup. It owns no tracker or product implementation.
 */
export class TrustedDeliveryExecution implements DeliveryExecutionPort {
  readonly #coordinator: {
    start(options: StartDeliveryOptions): Promise<DeliveryResumeOutcome>;
    resume(options: ResumeDeliveryOptions): Promise<DeliveryResumeOutcome>;
    completeCleanup(
      options: ResumeDeliveryOptions & {
        readonly cleanupStatus: "completed" | "retained";
      },
    ): WorkSessionSnapshot;
    abandon(options: AbandonDeliveryOptions): Promise<{
      readonly status: "cleanup_required";
      readonly session: WorkSessionSnapshot;
    }>;
    completeAbandonmentCleanup(
      options: AbandonDeliveryOptions,
    ): WorkSessionSnapshot;
  };
  readonly #materializer: TrustedDeliveryExecutionOptions["materializer"];
  readonly #stateStore: Pick<SymphonyStateStore, "getSession">;
  readonly #workspace: DeliveryWorkspacePort;

  constructor(options: TrustedDeliveryExecutionOptions) {
    this.#coordinator = options.coordinator;
    this.#materializer = options.materializer;
    this.#stateStore = options.stateStore;
    this.#workspace = options.workspace;
  }

  async reconcile(
    input: DeliveryExecutionInput,
  ): Promise<DeliveryExecutionOutcome> {
    let session = this.#stateStore.getSession(input.sessionId);
    if (session === null) {
      throw new SymphonyError(
        "delivery_refused",
        `WorkSession ${input.sessionId} does not exist`,
      );
    }
    if (session.configuration?.deliveryGrant == null) {
      return { status: "not_applicable", session };
    }

    const policy = session.configuration.trackerPolicy;
    const lane =
      policy === null || input.tracker.state === null
        ? null
        : trackerLane(policy, input.tracker.state);
    if (
      lane?.freshAttempt === true &&
      session.delivery !== null &&
      session.delivery.phase !== "completed"
    ) {
      if (
        session.delivery.phase === "refused" &&
        session.delivery.cleanupStatus === "completed"
      ) {
        return { status: "abandoned", session };
      }
      const abandoned = await this.#coordinator.abandon({
        sessionId: session.id,
        controllerGeneration: session.controller.generation,
        tracker: input.tracker,
      });
      await this.#workspace.cleanupWorkspace(input.issue, input.workflow, {
        workSessionId: session.id,
        controllerGeneration: session.controller.generation,
      });
      session = this.#coordinator.completeAbandonmentCleanup({
        sessionId: session.id,
        controllerGeneration: session.controller.generation,
        tracker: input.tracker,
      });
      return { status: "abandoned", session };
    }

    let outcome: DeliveryResumeOutcome;
    if (session.delivery === null) {
      if (!input.tracker.permittedOperations.includes("materialize")) {
        return { status: "not_applicable", session };
      }
      const attempt = latestDeliverableAttempt(session);
      const lease = attempt?.workspaceLease;
      if (attempt === undefined || lease?.mode !== "managed") {
        return { status: "not_applicable", session };
      }
      const materialization = await this.#materializer.materialize({
        sessionId: session.id,
        attemptId: attempt.id,
        workspaceLeaseToken: lease.leaseToken,
        controllerGeneration: session.controller.generation,
      });
      outcome = await this.#coordinator.start({
        sessionId: session.id,
        materializationId: materialization.id,
        controllerGeneration: session.controller.generation,
        tracker: input.tracker,
      });
    } else {
      outcome = await this.#coordinator.resume({
        sessionId: session.id,
        controllerGeneration: session.controller.generation,
        tracker: input.tracker,
      });
    }

    if (outcome.status !== "cleanup_required") return outcome;
    if (!input.tracker.permittedOperations.includes("cleanupWorkspace")) {
      return {
        status: "awaiting_cleanup_authority",
        session: outcome.session,
      };
    }
    await this.#workspace.cleanupWorkspace(input.issue, input.workflow, {
      workSessionId: session.id,
      controllerGeneration: session.controller.generation,
    });
    session = this.#coordinator.completeCleanup({
      sessionId: session.id,
      controllerGeneration: session.controller.generation,
      tracker: input.tracker,
      cleanupStatus: "completed",
    });
    return { status: "completed", session };
  }
}
