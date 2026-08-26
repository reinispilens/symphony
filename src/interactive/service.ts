import type { ResolvedDeployment } from "../deployment/model.js";
import { SymphonyError } from "../errors.js";
import type { SymphonyStateStore } from "../state/store.js";
import { StateStoreError } from "../state/store.js";
import type { WorkSessionSnapshot } from "../state/model.js";
import {
  inspectHumanCheckout,
  type CheckoutObservation,
} from "./checkout-inspector.js";
import type { ParsedWorkPlan } from "./plan-document.js";
import { projectWorkStatus, type WorkStatusProjection } from "./status.js";

const MAX_INTENT_BYTES = 16 * 1024;
const MAX_PLAN_BYTES = 1024 * 1024;
const MAX_STEERING_BYTES = 64 * 1024;
const WORK_SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface InteractiveWorkServiceOptions {
  readonly actorId: string;
  readonly clock?: () => Date;
  readonly deployment: ResolvedDeployment;
  readonly inspectCheckout?: typeof inspectHumanCheckout;
  readonly stateStore: SymphonyStateStore;
}

export function assertInteractiveStartAuthority(
  deployment: ResolvedDeployment,
): void {
  if (
    deployment.binding.schemaVersion !== 3 ||
    deployment.governance === null ||
    deployment.acceptedConfiguration.governanceManifest === null ||
    deployment.acceptedConfiguration.trackerPolicy === null
  ) {
    throw new SymphonyError(
      "deployment_binding_refused",
      "Interactive WorkSessions require a version-3 binding with accepted governance",
    );
  }
}

function sameIdentity(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function boundedSingleLine(
  value: string,
  label: string,
  maximumBytes: number,
): string {
  const normalized = value.trim();
  if (
    normalized === "" ||
    /[\0\r\n]/u.test(normalized) ||
    Buffer.byteLength(normalized, "utf8") > maximumBytes
  ) {
    throw new SymphonyError(
      "interactive_input_invalid",
      `${label} must be one non-blank line of at most ${maximumBytes} UTF-8 bytes`,
    );
  }
  return normalized;
}

export class InteractiveWorkService {
  readonly #actorId: string;
  readonly #clock: () => Date;
  readonly #deployment: ResolvedDeployment;
  readonly #inspectCheckout: typeof inspectHumanCheckout;
  readonly #stateStore: SymphonyStateStore;

  constructor(options: InteractiveWorkServiceOptions) {
    this.#actorId = boundedSingleLine(
      options.actorId,
      "Interactive actor ID",
      1024,
    );
    this.#clock = options.clock ?? (() => new Date());
    this.#deployment = options.deployment;
    this.#inspectCheckout = options.inspectCheckout ?? inspectHumanCheckout;
    this.#stateStore = options.stateStore;
  }

  startInteractive(intent: string): WorkSessionSnapshot {
    const normalizedIntent = boundedSingleLine(
      intent,
      "WorkSession intent",
      MAX_INTENT_BYTES,
    );
    assertInteractiveStartAuthority(this.#deployment);
    const governance = this.#deployment.governance!;
    return this.#stateStore.createInteractiveSession({
      repositoryIdentity: this.#deployment.profile.repositoryIdentity,
      initiatingActor: this.#actorId,
      intent: normalizedIntent,
      controllerId: this.#actorId,
      doctrine: governance.doctrineReference,
      configuration: this.#deployment.acceptedConfiguration,
      now: this.#now(),
    });
  }

  async attachWorkspace(input: {
    readonly expectedRevision: number;
    readonly path: string;
    readonly sessionId: string;
  }): Promise<WorkSessionSnapshot> {
    const session = this.#requireHumanController(
      input.sessionId,
      input.expectedRevision,
    );
    const observedAt = this.#now();
    const observation: CheckoutObservation = await this.#inspectCheckout({
      deployment: this.#deployment,
      path: input.path,
      observedAt,
    });
    if (
      !sameIdentity(observation.repositoryIdentity, session.repositoryIdentity)
    ) {
      throw new StateStoreError(
        "repository_mismatch",
        `Checkout repository ${observation.repositoryIdentity} does not match WorkSession ${session.repositoryIdentity}`,
      );
    }
    return this.#stateStore.attachHumanWorkspace({
      sessionId: session.id,
      expectedRevision: input.expectedRevision,
      controllerId: this.#actorId,
      path: observation.path,
      repositoryIdentity: session.repositoryIdentity,
      inspection: observation.inspection,
      now: observedAt,
    });
  }

  replacePlan(input: {
    readonly expectedRevision: number;
    readonly plan: ParsedWorkPlan;
    readonly sessionId: string;
  }): WorkSessionSnapshot {
    const session = this.#requireHumanController(
      input.sessionId,
      input.expectedRevision,
    );
    if (
      input.plan.summary.trim() === "" ||
      input.plan.summary.includes("\0") ||
      input.plan.acceptanceCriteria.length === 0 ||
      input.plan.acceptanceCriteria.some(
        (criterion) => criterion.trim() === "" || /[\0\r\n]/u.test(criterion),
      ) ||
      Buffer.byteLength(
        JSON.stringify({
          summary: input.plan.summary,
          acceptanceCriteria: input.plan.acceptanceCriteria,
        }),
        "utf8",
      ) > MAX_PLAN_BYTES
    ) {
      throw new SymphonyError(
        "interactive_input_invalid",
        `WorkSession plan must contain a non-blank summary and one or more single-line criteria within ${MAX_PLAN_BYTES} UTF-8 bytes`,
      );
    }
    return this.#stateStore.replacePlan({
      sessionId: session.id,
      expectedRevision: input.expectedRevision,
      controllerGeneration: session.controller.generation,
      summary: input.plan.summary,
      acceptanceCriteria: input.plan.acceptanceCriteria,
      recordedBy: this.#actorId,
      now: this.#now(),
    });
  }

  appendSteering(input: {
    readonly expectedRevision: number;
    readonly message: string;
    readonly sessionId: string;
  }): WorkSessionSnapshot {
    const session = this.#requireHumanController(
      input.sessionId,
      input.expectedRevision,
    );
    const message = boundedSingleLine(
      input.message,
      "Steering message",
      MAX_STEERING_BYTES,
    );
    const exception = message.match(/^EXCEPTION (GP-\d{2}): (.+)$/u);
    if (message.startsWith("EXCEPTION") && exception === null) {
      throw new SymphonyError(
        "interactive_input_invalid",
        "Doctrine exceptions must use 'EXCEPTION GP-xx: <reason>' exactly",
      );
    }
    return this.#stateStore.appendDecision({
      sessionId: session.id,
      expectedRevision: input.expectedRevision,
      controllerGeneration: session.controller.generation,
      kind: exception === null ? "steering" : "exception",
      text: exception === null ? message : exception[2]!.trim(),
      acceptedBy: this.#actorId,
      principleId: exception?.[1] ?? null,
      now: this.#now(),
    });
  }

  getStatus(sessionId: string): WorkStatusProjection {
    return projectWorkStatus(this.#requireBoundSession(sessionId));
  }

  #now(): string {
    return this.#clock().toISOString();
  }

  #requireBoundSession(sessionId: string): WorkSessionSnapshot {
    if (!WORK_SESSION_ID.test(sessionId)) {
      throw new SymphonyError(
        "interactive_input_invalid",
        "WorkSession ID must be a canonical UUID",
      );
    }
    const session = this.#stateStore.getSession(sessionId);
    if (session === null) {
      throw new StateStoreError(
        "state_not_found",
        `WorkSession ${sessionId} was not found in this binding's state store`,
      );
    }
    const accepted = session.configuration;
    if (
      !sameIdentity(
        session.repositoryIdentity,
        this.#deployment.profile.repositoryIdentity,
      ) ||
      accepted === null ||
      accepted.deploymentBinding.id !== this.#deployment.binding.id ||
      accepted.deploymentBinding.digest !== this.#deployment.bindingDigest ||
      !sameJson(accepted, this.#deployment.acceptedConfiguration) ||
      !sameJson(
        session.doctrine,
        this.#deployment.governance?.doctrineReference ?? null,
      )
    ) {
      throw new SymphonyError(
        "interactive_control_refused",
        `WorkSession ${session.id} is not governed by the supplied deployment binding`,
      );
    }
    return session;
  }

  #requireHumanController(
    sessionId: string,
    expectedRevision: number,
  ): WorkSessionSnapshot {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new SymphonyError(
        "interactive_input_invalid",
        "Expected WorkSession revision must be an integer >= 1",
      );
    }
    const session = this.#requireBoundSession(sessionId);
    if (session.revision !== expectedRevision) {
      throw new StateStoreError(
        "stale_revision",
        `Cannot mutate WorkSession ${session.id} at revision ${expectedRevision}; current revision is ${session.revision}`,
      );
    }
    if (
      session.status !== "active" ||
      session.controller.kind !== "human" ||
      session.controller.controllerId !== this.#actorId
    ) {
      throw new StateStoreError(
        "controller_conflict",
        `Actor ${this.#actorId} is not the active human controller of WorkSession ${session.id}`,
      );
    }
    return session;
  }
}
