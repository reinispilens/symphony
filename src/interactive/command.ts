import { existsSync, lstatSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  resolveDeploymentBinding,
  type DeploymentResolutionOptions,
} from "../deployment/resolver.js";
import type { ResolvedDeployment } from "../deployment/model.js";
import { SymphonyError } from "../errors.js";
import {
  GITHUB_PROJECTS_TRACKER_KIND,
  githubProjectsConfigProfile,
} from "../tracker/github-projects/profile.js";
import type { TrackerConfigProfiles } from "../tracker/config-profile.js";
import {
  SqliteSymphonyStateStore,
  stateDatabasePathFromStateRoot,
} from "../state/sqlite-store.js";
import type { SymphonyStateStore } from "../state/store.js";
import { StateStoreError } from "../state/store.js";
import type { WorkSessionSnapshot } from "../state/model.js";
import { type CheckoutObservation } from "./checkout-inspector.js";
import { readWorkPlanFile } from "./plan-document.js";
import {
  assertInteractiveStartAuthority,
  InteractiveWorkService,
} from "./service.js";
import type { WorkStatusProjection } from "./status.js";

export type ManualWorkCommand =
  | {
      readonly action: "start";
      readonly bindingPath: string;
      readonly intent: string;
    }
  | {
      readonly action: "attach";
      readonly bindingPath: string;
      readonly expectedRevision: number;
      readonly path: string;
      readonly sessionId: string;
    }
  | {
      readonly action: "plan";
      readonly bindingPath: string;
      readonly expectedRevision: number;
      readonly filePath: string;
      readonly sessionId: string;
    }
  | {
      readonly action: "steer";
      readonly bindingPath: string;
      readonly expectedRevision: number;
      readonly message: string;
      readonly sessionId: string;
    }
  | {
      readonly action: "status";
      readonly bindingPath: string;
      readonly json: boolean;
      readonly sessionId: string;
    };

export interface ManualWorkCommandContext {
  readonly environment: NodeJS.ProcessEnv;
}

export type ManualWorkCommandRunner = (
  command: ManualWorkCommand,
  context: ManualWorkCommandContext,
) => Promise<string>;

type BindingResolver = (
  options: DeploymentResolutionOptions,
) => Promise<ResolvedDeployment>;

export interface ManualWorkCommandDependencies {
  readonly actorId?: string;
  readonly clock?: () => Date;
  readonly inspectCheckout?: (input: {
    readonly deployment: ResolvedDeployment;
    readonly observedAt: string;
    readonly path: string;
  }) => Promise<CheckoutObservation>;
  readonly openStateStore?: (databasePath: string) => SymphonyStateStore;
  readonly resolveBinding?: BindingResolver;
  readonly trackerProfiles?: TrackerConfigProfiles;
}

function localActorId(): string {
  const user = os.userInfo();
  const uid =
    typeof process.getuid === "function" ? process.getuid() : user.uid;
  return `local-user:${uid}:${user.username}`;
}

function assertBindingPath(bindingPath: string): void {
  if (!path.isAbsolute(bindingPath) || /[\0\r\n]/u.test(bindingPath)) {
    throw new SymphonyError(
      "interactive_control_refused",
      "Every manual WorkSession command requires an absolute --binding path",
    );
  }
}

function assertExistingStateDatabase(databasePath: string): void {
  if (!existsSync(databasePath)) {
    throw new StateStoreError(
      "state_not_found",
      `No Symphony state database exists at ${databasePath}`,
    );
  }
  const entry = lstatSync(databasePath);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new SymphonyError(
      "interactive_control_refused",
      `Symphony state database ${databasePath} must be a regular non-symlink file`,
    );
  }
}

function sessionResult(verb: string, session: WorkSessionSnapshot): string {
  return [
    `WorkSession ${session.id} ${verb}.`,
    `Repository: ${session.repositoryIdentity}`,
    `Revision: ${session.revision}`,
    `Controller generation: ${session.controller.generation}`,
  ].join("\n");
}

function humanStatus(status: WorkStatusProjection): string {
  const attachment = status.humanAttachment;
  const attempt = status.runtime.activeAttempt;
  const lines = [
    `WorkSession ${status.session.id}`,
    `Intent: ${status.session.intent}`,
    `State: ${status.session.status}; revision ${status.session.revision}; origin ${status.session.origin.kind}`,
    `Repository: ${status.session.repositoryIdentity}`,
    `Controller: ${status.controller.kind} ${status.controller.controllerId} (generation ${status.controller.generation})`,
    `Binding: ${status.configuration?.deploymentBinding.id ?? "unbound"} @ ${status.configuration?.deploymentBinding.digest ?? "unbound"}`,
    `Doctrine: ${status.doctrine === null ? "unpinned" : `${status.doctrine.repositoryIdentity}:${status.doctrine.path} @ ${status.doctrine.revision} (${status.doctrine.digest})`}`,
    `Plan: ${status.plan === null ? "not recorded" : `v${status.plan.version} — ${status.plan.summary}`}`,
    ...(status.plan === null
      ? []
      : status.plan.acceptanceCriteria.map(
          (criterion, index) => `  ${index + 1}. ${criterion}`,
        )),
    `Workspace: ${attachment === null ? "none attached" : `${attachment.path} (human-owned; removal never)`}`,
    ...(attachment?.inspection.status === "observed"
      ? [
          `  observed ${attachment.inspection.observedAt}; HEAD ${attachment.inspection.headSha ?? "unborn"}; tracked=${attachment.inspection.trackedChanges}; untracked=${attachment.inspection.untrackedChanges}; ignored=${attachment.inspection.ignoredChanges}`,
        ]
      : []),
    `Runtime: ${attempt === null ? `idle (${status.runtime.attemptCount} recorded attempt(s))` : `Attempt ${attempt.id} ${attempt.status}; lease ${attempt.runtimeLease.status} until ${attempt.runtimeLease.expiresAt}`}`,
    `Evidence: ${status.evidence.posture} — ${status.evidence.reason}`,
    `Delivery: ${status.delivery?.phase ?? "not started"}`,
    `Recent steering: ${status.decisions.count === 0 ? "none" : status.decisions.truncated ? `last ${status.decisions.recent.length} of ${status.decisions.count}` : status.decisions.count}`,
    ...status.decisions.recent.map(
      (decision) =>
        `  ${decision.recordedAt} [${decision.kind}${decision.principleId === null ? "" : ` ${decision.principleId}`}] ${decision.text}`,
    ),
  ];
  return lines.join("\n");
}

export async function executeManualWorkCommand(
  command: ManualWorkCommand,
  context: ManualWorkCommandContext,
  dependencies: ManualWorkCommandDependencies = {},
): Promise<string> {
  assertBindingPath(command.bindingPath);
  if (
    command.action === "start" &&
    (command.intent.trim() === "" || /[\0\r\n]/u.test(command.intent))
  ) {
    throw new SymphonyError(
      "interactive_input_invalid",
      "WorkSession intent must be one non-blank line",
    );
  }
  const trackerProfiles =
    dependencies.trackerProfiles ??
    new Map([[GITHUB_PROJECTS_TRACKER_KIND, githubProjectsConfigProfile]]);
  const deployment = await (
    dependencies.resolveBinding ?? resolveDeploymentBinding
  )({
    bindingPath: command.bindingPath,
    trackerProfiles,
    environment: context.environment,
    requireDeliverySecrets: false,
  });
  const databasePath = stateDatabasePathFromStateRoot(
    deployment.binding.stateRoot,
  );
  if (command.action === "start") assertInteractiveStartAuthority(deployment);
  if (command.action !== "start") assertExistingStateDatabase(databasePath);
  const stateStore = (
    dependencies.openStateStore ??
    ((target) => SqliteSymphonyStateStore.open(target))
  )(databasePath);
  try {
    const service = new InteractiveWorkService({
      actorId: dependencies.actorId ?? localActorId(),
      ...(dependencies.clock === undefined
        ? {}
        : { clock: dependencies.clock }),
      deployment,
      ...(dependencies.inspectCheckout === undefined
        ? {}
        : { inspectCheckout: dependencies.inspectCheckout }),
      stateStore,
    });
    switch (command.action) {
      case "start": {
        return sessionResult(
          "started",
          service.startInteractive(command.intent),
        );
      }
      case "attach": {
        const session = await service.attachWorkspace({
          sessionId: command.sessionId,
          expectedRevision: command.expectedRevision,
          path: command.path,
        });
        return sessionResult("attached to its human checkout", session);
      }
      case "plan": {
        const plan = await readWorkPlanFile(command.filePath);
        const session = service.replacePlan({
          sessionId: command.sessionId,
          expectedRevision: command.expectedRevision,
          plan,
        });
        return sessionResult(
          `recorded plan v${session.plan!.version}`,
          session,
        );
      }
      case "steer": {
        const session = service.appendSteering({
          sessionId: command.sessionId,
          expectedRevision: command.expectedRevision,
          message: command.message,
        });
        return sessionResult("recorded steering", session);
      }
      case "status": {
        const status = service.getStatus(command.sessionId);
        return command.json
          ? JSON.stringify(status, null, 2)
          : humanStatus(status);
      }
    }
  } finally {
    stateStore.close();
  }
}
