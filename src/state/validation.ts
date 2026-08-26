import { isRecord } from "../shared/json.js";
import nodePath from "node:path";
import {
  WORK_SESSION_SCHEMA_VERSION,
  type AcceptedConfigurationSnapshot,
  type AttemptRecord,
  type ControllerAssignment,
  type DecisionEntry,
  type DeliveryState,
  type DoctrineSnapshot,
  type HumanWorkspaceAttachment,
  type PreparationRecord,
  type ProofCorrelation,
  type RequiredCheckObservation,
  type RetryIntent,
  type RuntimeLease,
  type SourceMaterializationRecord,
  type WorkPlan,
  type WorkSessionDocument,
  type WorkSessionOrigin,
  type WorkspaceLease,
} from "./model.js";
import { StateStoreError } from "./store.js";

function corrupt(path: string, expectation: string): never {
  throw new StateStoreError(
    "state_corrupt",
    `Symphony state ${path} ${expectation}`,
  );
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) corrupt(path, "must be an object");
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") corrupt(path, "must be a string");
  return value;
}

function nonEmptyString(value: unknown, path: string): string {
  const result = string(value, path);
  if (result.trim() === "") corrupt(path, "must not be blank");
  return result;
}

function nullableString(value: unknown, path: string): string | null {
  return value === null ? null : string(value, path);
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") corrupt(path, "must be a boolean");
  return value;
}

function integer(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    corrupt(path, `must be an integer >= ${minimum}`);
  }
  return value as number;
}

function oneOf<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    corrupt(path, `must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) corrupt(path, "must be an array");
  return value;
}

function timestamp(value: string, path: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) corrupt(path, "must be an ISO-8601 timestamp");
  return parsed;
}

function assertUnique(
  values: readonly string[],
  path: string,
  label: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value))
      corrupt(path, `must not contain duplicate ${label} ${value}`);
    seen.add(value);
  }
}

function assertSha256(value: string, path: string): void {
  if (!value.startsWith("sha256:")) corrupt(path, "must use the sha256: form");
}

function assertGitSha(value: string, path: string): void {
  if (!/^[0-9a-f]{40}$/u.test(value)) {
    corrupt(path, "must be a full Git SHA-1");
  }
}

function assertNullableGitSha(value: string | null, path: string): void {
  if (value !== null) assertGitSha(value, path);
}

function assertRepositoryRelativePath(value: string, path: string): void {
  if (
    value.includes("\\") ||
    nodePath.posix.isAbsolute(value) ||
    nodePath.win32.isAbsolute(value) ||
    value === "." ||
    nodePath.posix.normalize(value) !== value ||
    value.startsWith("../")
  ) {
    corrupt(path, "must be a normalized repository-relative POSIX path");
  }
}

type ManagedWorkspacePin = Pick<
  Extract<WorkspaceLease, { readonly mode: "managed" }>,
  | "path"
  | "workspaceKey"
  | "repositoryIdentity"
  | "profileDigest"
  | "sourceRoot"
  | "workspaceRoot"
  | "baseRef"
  | "baseSha"
>;

function managedWorkspacePin(
  lease: Extract<WorkspaceLease, { readonly mode: "managed" }>,
): ManagedWorkspacePin {
  return {
    path: lease.path,
    workspaceKey: lease.workspaceKey,
    repositoryIdentity: lease.repositoryIdentity,
    profileDigest: lease.profileDigest,
    sourceRoot: lease.sourceRoot,
    workspaceRoot: lease.workspaceRoot,
    baseRef: lease.baseRef,
    baseSha: lease.baseSha,
  };
}

function parseOrigin(value: unknown): WorkSessionOrigin {
  const source = record(value, "document.origin");
  const kind = oneOf(source["kind"], "document.origin.kind", [
    "interactive",
    "tracker",
  ] as const);
  if (kind === "tracker") {
    return {
      kind,
      trackerKind: nonEmptyString(
        source["trackerKind"],
        "document.origin.trackerKind",
      ),
      repositoryIdentity: nonEmptyString(
        source["repositoryIdentity"],
        "document.origin.repositoryIdentity",
      ),
      issueId: nonEmptyString(source["issueId"], "document.origin.issueId"),
      issueIdentifier: nonEmptyString(
        source["issueIdentifier"],
        "document.origin.issueIdentifier",
      ),
      issueUrl: nullableString(source["issueUrl"], "document.origin.issueUrl"),
    };
  }
  return {
    kind,
    repositoryIdentity: nonEmptyString(
      source["repositoryIdentity"],
      "document.origin.repositoryIdentity",
    ),
    initiatingActor: nonEmptyString(
      source["initiatingActor"],
      "document.origin.initiatingActor",
    ),
  };
}

function parseDoctrine(value: unknown): DoctrineSnapshot | null {
  if (value === null) return null;
  const source = record(value, "document.doctrine");
  return {
    repositoryIdentity: nonEmptyString(
      source["repositoryIdentity"],
      "document.doctrine.repositoryIdentity",
    ),
    path: nonEmptyString(source["path"], "document.doctrine.path"),
    revision: nonEmptyString(source["revision"], "document.doctrine.revision"),
    digest: nonEmptyString(source["digest"], "document.doctrine.digest"),
  };
}

function parseConfiguration(
  value: unknown,
): AcceptedConfigurationSnapshot | null {
  if (value === null) return null;
  const source = record(value, "document.configuration");
  const profile = record(
    source["productProfile"],
    "document.configuration.productProfile",
  );
  const context = record(
    source["authoringContext"],
    "document.configuration.authoringContext",
  );
  const binding = record(
    source["deploymentBinding"],
    "document.configuration.deploymentBinding",
  );
  const deliveryValue = source["deliveryGrant"];
  const delivery =
    deliveryValue === undefined || deliveryValue === null
      ? null
      : record(deliveryValue, "document.configuration.deliveryGrant");
  const governingPolicy =
    delivery === null
      ? null
      : record(
          delivery["governingPolicy"],
          "document.configuration.deliveryGrant.governingPolicy",
        );
  return {
    productProfile: {
      repositoryIdentity: nonEmptyString(
        profile["repositoryIdentity"],
        "document.configuration.productProfile.repositoryIdentity",
      ),
      path: nonEmptyString(
        profile["path"],
        "document.configuration.productProfile.path",
      ),
      revision: nonEmptyString(
        profile["revision"],
        "document.configuration.productProfile.revision",
      ),
      digest: nonEmptyString(
        profile["digest"],
        "document.configuration.productProfile.digest",
      ),
    },
    authoringContext: {
      repositoryIdentity: nonEmptyString(
        context["repositoryIdentity"],
        "document.configuration.authoringContext.repositoryIdentity",
      ),
      revision: nonEmptyString(
        context["revision"],
        "document.configuration.authoringContext.revision",
      ),
      manifestDigest: nonEmptyString(
        context["manifestDigest"],
        "document.configuration.authoringContext.manifestDigest",
      ),
      entries: array(
        context["entries"],
        "document.configuration.authoringContext.entries",
      ).map((entry, index) => {
        const item = record(
          entry,
          `document.configuration.authoringContext.entries[${index}]`,
        );
        return {
          path: nonEmptyString(
            item["path"],
            `document.configuration.authoringContext.entries[${index}].path`,
          ),
          digest: nonEmptyString(
            item["digest"],
            `document.configuration.authoringContext.entries[${index}].digest`,
          ),
        };
      }),
    },
    deploymentBinding: {
      id: nonEmptyString(
        binding["id"],
        "document.configuration.deploymentBinding.id",
      ),
      digest: nonEmptyString(
        binding["digest"],
        "document.configuration.deploymentBinding.digest",
      ),
    },
    deliveryGrant:
      delivery === null || governingPolicy === null
        ? null
        : {
            authority: oneOf(
              delivery["authority"],
              "document.configuration.deliveryGrant.authority",
              ["owner-gated", "full-in-scope"] as const,
            ),
            governingPolicy: {
              repositoryIdentity: nonEmptyString(
                governingPolicy["repositoryIdentity"],
                "document.configuration.deliveryGrant.governingPolicy.repositoryIdentity",
              ),
              path: nonEmptyString(
                governingPolicy["path"],
                "document.configuration.deliveryGrant.governingPolicy.path",
              ),
              revision: nonEmptyString(
                governingPolicy["revision"],
                "document.configuration.deliveryGrant.governingPolicy.revision",
              ),
              digest: nonEmptyString(
                governingPolicy["digest"],
                "document.configuration.deliveryGrant.governingPolicy.digest",
              ),
            },
            requiredChecks: array(
              delivery["requiredChecks"],
              "document.configuration.deliveryGrant.requiredChecks",
            ).map((entry, index) =>
              nonEmptyString(
                entry,
                `document.configuration.deliveryGrant.requiredChecks[${index}]`,
              ),
            ),
          },
  };
}

function parseController(value: unknown): ControllerAssignment {
  const source = record(value, "document.controller");
  return {
    kind: oneOf(source["kind"], "document.controller.kind", [
      "human",
      "tracker",
    ] as const),
    controllerId: nonEmptyString(
      source["controllerId"],
      "document.controller.controllerId",
    ),
    generation: integer(
      source["generation"],
      "document.controller.generation",
      1,
    ),
    assignedAt: nonEmptyString(
      source["assignedAt"],
      "document.controller.assignedAt",
    ),
  };
}

function parseDecisions(value: unknown): readonly DecisionEntry[] {
  return array(value, "document.decisions").map((entry, index) => {
    const source = record(entry, `document.decisions[${index}]`);
    return {
      id: nonEmptyString(source["id"], `document.decisions[${index}].id`),
      kind: oneOf(source["kind"], `document.decisions[${index}].kind`, [
        "decision",
        "exception",
        "steering",
      ] as const),
      text: nonEmptyString(source["text"], `document.decisions[${index}].text`),
      acceptedBy: nonEmptyString(
        source["acceptedBy"],
        `document.decisions[${index}].acceptedBy`,
      ),
      principleId: nullableString(
        source["principleId"],
        `document.decisions[${index}].principleId`,
      ),
      doctrine: parseDoctrineAt(
        source["doctrine"],
        `document.decisions[${index}].doctrine`,
      ),
      recordedAt: nonEmptyString(
        source["recordedAt"],
        `document.decisions[${index}].recordedAt`,
      ),
    };
  });
}

function parseDoctrineAt(
  value: unknown,
  path: string,
): DoctrineSnapshot | null {
  if (value === null) return null;
  const source = record(value, path);
  return {
    repositoryIdentity: nonEmptyString(
      source["repositoryIdentity"],
      `${path}.repositoryIdentity`,
    ),
    path: nonEmptyString(source["path"], `${path}.path`),
    revision: nonEmptyString(source["revision"], `${path}.revision`),
    digest: nonEmptyString(source["digest"], `${path}.digest`),
  };
}

function parsePlan(value: unknown): WorkPlan | null {
  if (value === null) return null;
  const source = record(value, "document.plan");
  return {
    version: integer(source["version"], "document.plan.version", 1),
    summary: nonEmptyString(source["summary"], "document.plan.summary"),
    acceptanceCriteria: array(
      source["acceptanceCriteria"],
      "document.plan.acceptanceCriteria",
    ).map((entry, index) =>
      nonEmptyString(entry, `document.plan.acceptanceCriteria[${index}]`),
    ),
    recordedBy: nonEmptyString(
      source["recordedBy"],
      "document.plan.recordedBy",
    ),
    recordedAt: nonEmptyString(
      source["recordedAt"],
      "document.plan.recordedAt",
    ),
  };
}

function parseHumanAttachment(value: unknown): HumanWorkspaceAttachment | null {
  if (value === null) return null;
  const source = record(value, "document.humanAttachment");
  const inspection = record(
    source["inspection"],
    "document.humanAttachment.inspection",
  );
  const status = oneOf(
    inspection["status"],
    "document.humanAttachment.inspection.status",
    ["unknown", "observed"] as const,
  );
  return {
    kind: oneOf(source["kind"], "document.humanAttachment.kind", [
      "human-attachment",
    ] as const),
    id: nonEmptyString(source["id"], "document.humanAttachment.id"),
    ownership: oneOf(
      source["ownership"],
      "document.humanAttachment.ownership",
      ["human"] as const,
    ),
    path: nonEmptyString(source["path"], "document.humanAttachment.path"),
    repositoryIdentity: nonEmptyString(
      source["repositoryIdentity"],
      "document.humanAttachment.repositoryIdentity",
    ),
    inspection:
      status === "unknown"
        ? { status }
        : {
            status,
            headSha: nullableString(
              inspection["headSha"],
              "document.humanAttachment.inspection.headSha",
            ),
            trackedChanges: boolean(
              inspection["trackedChanges"],
              "document.humanAttachment.inspection.trackedChanges",
            ),
            untrackedChanges: boolean(
              inspection["untrackedChanges"],
              "document.humanAttachment.inspection.untrackedChanges",
            ),
            ignoredChanges: boolean(
              inspection["ignoredChanges"],
              "document.humanAttachment.inspection.ignoredChanges",
            ),
            observedAt: nonEmptyString(
              inspection["observedAt"],
              "document.humanAttachment.inspection.observedAt",
            ),
          },
    removalPolicy: oneOf(
      source["removalPolicy"],
      "document.humanAttachment.removalPolicy",
      ["never"] as const,
    ),
    attachedBy: nonEmptyString(
      source["attachedBy"],
      "document.humanAttachment.attachedBy",
    ),
    attachedAt: nonEmptyString(
      source["attachedAt"],
      "document.humanAttachment.attachedAt",
    ),
  };
}

function parseRuntimeLease(value: unknown, path: string): RuntimeLease {
  const source = record(value, path);
  return {
    token: nonEmptyString(source["token"], `${path}.token`),
    holderId: nonEmptyString(source["holderId"], `${path}.holderId`),
    controllerGeneration: integer(
      source["controllerGeneration"],
      `${path}.controllerGeneration`,
      1,
    ),
    status: oneOf(source["status"], `${path}.status`, [
      "active",
      "expired",
      "released",
    ] as const),
    acquiredAt: nonEmptyString(source["acquiredAt"], `${path}.acquiredAt`),
    renewedAt: nonEmptyString(source["renewedAt"], `${path}.renewedAt`),
    expiresAt: nonEmptyString(source["expiresAt"], `${path}.expiresAt`),
    releasedAt: nullableString(source["releasedAt"], `${path}.releasedAt`),
  };
}

function parseWorkspaceLease(
  value: unknown,
  path: string,
): WorkspaceLease | null {
  if (value === null) return null;
  const source = record(value, path);
  const mode = oneOf(source["mode"], `${path}.mode`, [
    "legacy-directory",
    "legacy-hook",
    "managed",
  ] as const);
  const common = {
    path: nonEmptyString(source["path"], `${path}.path`),
    workspaceKey: nonEmptyString(
      source["workspaceKey"],
      `${path}.workspaceKey`,
    ),
    recordedAt: nonEmptyString(source["recordedAt"], `${path}.recordedAt`),
  };
  if (mode === "legacy-directory" || mode === "legacy-hook") {
    return {
      ...common,
      mode,
      removalPolicy: oneOf(source["removalPolicy"], `${path}.removalPolicy`, [
        "guarded",
      ] as const),
    };
  }
  const driverVersion = integer(
    source["driverVersion"],
    `${path}.driverVersion`,
    1,
  );
  if (driverVersion !== 1) corrupt(`${path}.driverVersion`, "must equal 1");
  return {
    ...common,
    mode,
    removalPolicy: oneOf(source["removalPolicy"], `${path}.removalPolicy`, [
      "guarded",
    ] as const),
    leaseToken: nonEmptyString(source["leaseToken"], `${path}.leaseToken`),
    controllerGeneration: integer(
      source["controllerGeneration"],
      `${path}.controllerGeneration`,
      1,
    ),
    driver: oneOf(source["driver"], `${path}.driver`, [
      "git-worktree",
    ] as const),
    driverVersion: 1,
    phase: oneOf(source["phase"], `${path}.phase`, [
      "allocating",
      "provisioned",
      "ready",
      "superseded",
      "removal_pending",
      "removed",
      "retained",
    ] as const),
    repositoryIdentity: nonEmptyString(
      source["repositoryIdentity"],
      `${path}.repositoryIdentity`,
    ),
    profileDigest: nonEmptyString(
      source["profileDigest"],
      `${path}.profileDigest`,
    ),
    sourceRoot: nonEmptyString(source["sourceRoot"], `${path}.sourceRoot`),
    workspaceRoot: nonEmptyString(
      source["workspaceRoot"],
      `${path}.workspaceRoot`,
    ),
    baseRef: nonEmptyString(source["baseRef"], `${path}.baseRef`),
    baseSha: nonEmptyString(source["baseSha"], `${path}.baseSha`),
    branch: nonEmptyString(source["branch"], `${path}.branch`),
    freshAttemptGeneration: nullableString(
      source["freshAttemptGeneration"],
      `${path}.freshAttemptGeneration`,
    ),
    lastError: nullableString(source["lastError"], `${path}.lastError`),
    removedAt: nullableString(source["removedAt"], `${path}.removedAt`),
  };
}

function parsePreparation(
  value: unknown,
  path: string,
): PreparationRecord | null {
  if (value === null || value === undefined) return null;
  const source = record(value, path);
  const driverVersion = integer(
    source["driverVersion"],
    `${path}.driverVersion`,
    1,
  );
  if (driverVersion !== 1 && driverVersion !== 2) {
    corrupt(`${path}.driverVersion`, "must equal 1 or 2");
  }
  if (source["lifecycleScripts"] !== false) {
    corrupt(`${path}.lifecycleScripts`, "must be false");
  }
  const inputDigest =
    source["inputDigest"] === undefined
      ? null
      : nullableString(source["inputDigest"], `${path}.inputDigest`);
  const dependencyPolicyValue = source["dependencyPolicy"];
  const dependencyPolicy =
    dependencyPolicyValue === undefined || dependencyPolicyValue === null
      ? null
      : (() => {
          const policy = record(
            dependencyPolicyValue,
            `${path}.dependencyPolicy`,
          );
          return {
            id: nonEmptyString(policy["id"], `${path}.dependencyPolicy.id`),
            digest: nonEmptyString(
              policy["digest"],
              `${path}.dependencyPolicy.digest`,
            ),
            mode: oneOf(policy["mode"], `${path}.dependencyPolicy.mode`, [
              "offline",
            ] as const),
            registry: nonEmptyString(
              policy["registry"],
              `${path}.dependencyPolicy.registry`,
            ),
            seedStoreRoot: nonEmptyString(
              policy["seedStoreRoot"],
              `${path}.dependencyPolicy.seedStoreRoot`,
            ),
            pnpmVersion: nonEmptyString(
              policy["pnpmVersion"],
              `${path}.dependencyPolicy.pnpmVersion`,
            ),
          };
        })();
  if (driverVersion === 2 && dependencyPolicy === null) {
    corrupt(path, "driver version 2 requires dependencyPolicy");
  }
  return {
    driver: oneOf(source["driver"], `${path}.driver`, ["pnpm"] as const),
    driverVersion,
    status: oneOf(source["status"], `${path}.status`, [
      "failed",
      "interrupted",
      "running",
      "setup_refused",
      "succeeded",
    ] as const),
    command: array(source["command"], `${path}.command`).map((entry, index) =>
      nonEmptyString(entry, `${path}.command[${index}]`),
    ),
    manifestDigest: nullableString(
      source["manifestDigest"],
      `${path}.manifestDigest`,
    ),
    lockfileDigest: nullableString(
      source["lockfileDigest"],
      `${path}.lockfileDigest`,
    ),
    inputDigest,
    dependencyPolicy,
    cachePath: nonEmptyString(source["cachePath"], `${path}.cachePath`),
    lifecycleScripts: false,
    startedAt: nonEmptyString(source["startedAt"], `${path}.startedAt`),
    finishedAt: nullableString(source["finishedAt"], `${path}.finishedAt`),
    error: nullableString(source["error"], `${path}.error`),
  };
}

function parseAttempts(value: unknown): readonly AttemptRecord[] {
  return array(value, "document.attempts").map((entry, index) => {
    const path = `document.attempts[${index}]`;
    const source = record(entry, path);
    const correlation = record(
      source["runtimeCorrelation"],
      `${path}.runtimeCorrelation`,
    );
    const trackerAttemptValue = source["trackerAttempt"];
    return {
      id: nonEmptyString(source["id"], `${path}.id`),
      ordinal: integer(source["ordinal"], `${path}.ordinal`, 1),
      trackerAttempt:
        trackerAttemptValue === null
          ? null
          : integer(trackerAttemptValue, `${path}.trackerAttempt`, 1),
      freshAttemptGeneration: nullableString(
        source["freshAttemptGeneration"],
        `${path}.freshAttemptGeneration`,
      ),
      status: oneOf(source["status"], `${path}.status`, [
        "cancelled",
        "completed",
        "failed",
        "interrupted",
        "released",
        "running",
        "stalled",
      ] as const),
      startedAt: nonEmptyString(source["startedAt"], `${path}.startedAt`),
      finishedAt: nullableString(source["finishedAt"], `${path}.finishedAt`),
      error: nullableString(source["error"], `${path}.error`),
      runtimeLease: parseRuntimeLease(
        source["runtimeLease"],
        `${path}.runtimeLease`,
      ),
      workspaceLease: parseWorkspaceLease(
        source["workspaceLease"],
        `${path}.workspaceLease`,
      ),
      preparation: parsePreparation(
        source["preparation"],
        `${path}.preparation`,
      ),
      runtimeCorrelation: {
        processId:
          correlation["processId"] === null
            ? null
            : integer(
                correlation["processId"],
                `${path}.runtimeCorrelation.processId`,
                1,
              ),
        sessionId: nullableString(
          correlation["sessionId"],
          `${path}.runtimeCorrelation.sessionId`,
        ),
      },
    };
  });
}

function parseRetry(value: unknown): RetryIntent | null {
  if (value === null) return null;
  const source = record(value, "document.retry");
  return {
    kind: oneOf(source["kind"], "document.retry.kind", [
      "continuation",
      "failure",
      "fresh_handoff",
    ] as const),
    attempt: integer(source["attempt"], "document.retry.attempt", 1),
    dueAt: nonEmptyString(source["dueAt"], "document.retry.dueAt"),
    error: nullableString(source["error"], "document.retry.error"),
    freshAttemptGeneration: nullableString(
      source["freshAttemptGeneration"],
      "document.retry.freshAttemptGeneration",
    ),
    recordedAt: nonEmptyString(
      source["recordedAt"],
      "document.retry.recordedAt",
    ),
  };
}

function parseMaterializations(
  value: unknown,
): readonly SourceMaterializationRecord[] {
  return array(value, "document.materializations").map((entry, index) => {
    const path = `document.materializations[${index}]`;
    const source = record(entry, path);
    return {
      id: nonEmptyString(source["id"], `${path}.id`),
      attemptId: nonEmptyString(source["attemptId"], `${path}.attemptId`),
      workspaceLeaseToken: nonEmptyString(
        source["workspaceLeaseToken"],
        `${path}.workspaceLeaseToken`,
      ),
      controllerGeneration: integer(
        source["controllerGeneration"],
        `${path}.controllerGeneration`,
        1,
      ),
      phase: oneOf(source["phase"], `${path}.phase`, [
        "intent_recorded",
        "snapshot_recorded",
        "tree_written",
        "commit_written",
        "branch_updated",
        "refused",
      ] as const),
      parentSha: nonEmptyString(source["parentSha"], `${path}.parentSha`),
      branch: nonEmptyString(source["branch"], `${path}.branch`),
      expectedOldSha: nonEmptyString(
        source["expectedOldSha"],
        `${path}.expectedOldSha`,
      ),
      inclusionPolicyDigest: nonEmptyString(
        source["inclusionPolicyDigest"],
        `${path}.inclusionPolicyDigest`,
      ),
      inputManifestDigest: nullableString(
        source["inputManifestDigest"],
        `${path}.inputManifestDigest`,
      ),
      inputManifest:
        source["inputManifest"] === null ||
        source["inputManifest"] === undefined
          ? null
          : array(source["inputManifest"], `${path}.inputManifest`).map(
              (entry, entryIndex) => {
                const entryPath = `${path}.inputManifest[${entryIndex}]`;
                const item = record(entry, entryPath);
                return {
                  path: nonEmptyString(item["path"], `${entryPath}.path`),
                  kind: oneOf(item["kind"], `${entryPath}.kind`, [
                    "regular",
                    "symlink",
                  ] as const),
                  mode: oneOf(item["mode"], `${entryPath}.mode`, [
                    "100644",
                    "100755",
                    "120000",
                  ] as const),
                  size: integer(item["size"], `${entryPath}.size`, 0),
                  contentDigest: nonEmptyString(
                    item["contentDigest"],
                    `${entryPath}.contentDigest`,
                  ),
                  blobSha: nonEmptyString(
                    item["blobSha"],
                    `${entryPath}.blobSha`,
                  ),
                  origin: oneOf(item["origin"], `${entryPath}.origin`, [
                    "tracked",
                    "untracked",
                  ] as const),
                };
              },
            ),
      treeSha: nullableString(source["treeSha"], `${path}.treeSha`),
      commitSha: nullableString(source["commitSha"], `${path}.commitSha`),
      lastError: nullableString(source["lastError"], `${path}.lastError`),
      startedAt: nonEmptyString(source["startedAt"], `${path}.startedAt`),
      updatedAt: nonEmptyString(source["updatedAt"], `${path}.updatedAt`),
    };
  });
}

function parseProof(value: unknown): readonly ProofCorrelation[] {
  return array(value, "document.proof").map((entry, index) => {
    const path = `document.proof[${index}]`;
    const source = record(entry, path);
    return {
      id: nonEmptyString(source["id"], `${path}.id`),
      checkName: nullableString(source["checkName"], `${path}.checkName`),
      checkRunId: nullableString(source["checkRunId"], `${path}.checkRunId`),
      workflowRunId: nullableString(
        source["workflowRunId"],
        `${path}.workflowRunId`,
      ),
      sourceSha: nonEmptyString(source["sourceSha"], `${path}.sourceSha`),
      planDigest: nonEmptyString(source["planDigest"], `${path}.planDigest`),
      adapterDigest: nullableString(
        source["adapterDigest"],
        `${path}.adapterDigest`,
      ),
      policyDigest: nullableString(
        source["policyDigest"],
        `${path}.policyDigest`,
      ),
      resultDigest: nullableString(
        source["resultDigest"],
        `${path}.resultDigest`,
      ),
      evidenceDigest: nullableString(
        source["evidenceDigest"],
        `${path}.evidenceDigest`,
      ),
      status: oneOf(source["status"], `${path}.status`, [
        "pending",
        "passed",
        "failed",
        "setup_refused",
        "non_verdict",
      ] as const),
      recordedAt: nonEmptyString(source["recordedAt"], `${path}.recordedAt`),
      observedAt: nullableString(source["observedAt"], `${path}.observedAt`),
    };
  });
}

function parseRequiredChecks(
  value: unknown,
): readonly RequiredCheckObservation[] {
  return array(value, "document.delivery.requiredChecks").map(
    (entry, index) => {
      const path = `document.delivery.requiredChecks[${index}]`;
      const source = record(entry, path);
      return {
        name: nonEmptyString(source["name"], `${path}.name`),
        headSha: nonEmptyString(source["headSha"], `${path}.headSha`),
        checkRunId: nullableString(source["checkRunId"], `${path}.checkRunId`),
        workflowRunId: nullableString(
          source["workflowRunId"],
          `${path}.workflowRunId`,
        ),
        status: oneOf(source["status"], `${path}.status`, [
          "pending",
          "passed",
          "failed",
          "setup_refused",
          "non_verdict",
        ] as const),
        observedAt: nullableString(source["observedAt"], `${path}.observedAt`),
      };
    },
  );
}

function parseDelivery(value: unknown): DeliveryState | null {
  if (value === null) return null;
  const source = record(value, "document.delivery");
  return {
    phase: oneOf(source["phase"], "document.delivery.phase", [
      "intent_recorded",
      "push_pending",
      "pushed",
      "pull_request_pending",
      "pull_request_open",
      "checks_pending",
      "review_pending",
      "merge_pending",
      "merged",
      "cleanup_pending",
      "completed",
      "refused",
    ] as const),
    materializationId: nullableString(
      source["materializationId"],
      "document.delivery.materializationId",
    ),
    branch: nullableString(source["branch"], "document.delivery.branch"),
    pullRequest: nullableString(
      source["pullRequest"],
      "document.delivery.pullRequest",
    ),
    immutableHeadSha: nullableString(
      source["immutableHeadSha"],
      "document.delivery.immutableHeadSha",
    ),
    expectedRemoteHeadSha: nullableString(
      source["expectedRemoteHeadSha"],
      "document.delivery.expectedRemoteHeadSha",
    ),
    remoteHeadSha: nullableString(
      source["remoteHeadSha"],
      "document.delivery.remoteHeadSha",
    ),
    requiredChecks: parseRequiredChecks(source["requiredChecks"]),
    mergeSha: nullableString(source["mergeSha"], "document.delivery.mergeSha"),
    cleanupStatus: oneOf(
      source["cleanupStatus"],
      "document.delivery.cleanupStatus",
      ["not_started", "pending", "completed", "retained", "refused"] as const,
    ),
    releaseIntentId: nullableString(
      source["releaseIntentId"],
      "document.delivery.releaseIntentId",
    ),
    lastError: nullableString(
      source["lastError"],
      "document.delivery.lastError",
    ),
    startedAt: nonEmptyString(
      source["startedAt"],
      "document.delivery.startedAt",
    ),
    updatedAt: nonEmptyString(
      source["updatedAt"],
      "document.delivery.updatedAt",
    ),
  };
}

function assertDocumentInvariants(document: WorkSessionDocument): void {
  if (document.origin.repositoryIdentity !== document.repositoryIdentity) {
    corrupt(
      "document.origin.repositoryIdentity",
      "must match document.repositoryIdentity",
    );
  }

  const createdAt = timestamp(document.createdAt, "document.createdAt");
  const updatedAt = timestamp(document.updatedAt, "document.updatedAt");
  if (updatedAt < createdAt) {
    corrupt("document.updatedAt", "must not precede document.createdAt");
  }
  timestamp(document.controller.assignedAt, "document.controller.assignedAt");
  if (document.doctrine !== null) {
    assertSha256(document.doctrine.digest, "document.doctrine.digest");
    assertRepositoryRelativePath(
      document.doctrine.path,
      "document.doctrine.path",
    );
  }

  if (document.configuration !== null) {
    const {
      productProfile,
      authoringContext,
      deploymentBinding,
      deliveryGrant,
    } = document.configuration;
    if (
      productProfile.repositoryIdentity !== document.repositoryIdentity ||
      authoringContext.repositoryIdentity !== document.repositoryIdentity
    ) {
      corrupt(
        "document.configuration",
        "must describe the WorkSession repository identity",
      );
    }
    if (productProfile.revision !== authoringContext.revision) {
      corrupt(
        "document.configuration.authoringContext.revision",
        "must match the accepted product profile revision",
      );
    }
    assertSha256(
      productProfile.digest,
      "document.configuration.productProfile.digest",
    );
    assertRepositoryRelativePath(
      productProfile.path,
      "document.configuration.productProfile.path",
    );
    assertSha256(
      authoringContext.manifestDigest,
      "document.configuration.authoringContext.manifestDigest",
    );
    assertSha256(
      deploymentBinding.digest,
      "document.configuration.deploymentBinding.digest",
    );
    if (deliveryGrant !== null) {
      const policy = deliveryGrant.governingPolicy;
      if (!policy.repositoryIdentity.toLowerCase().endsWith("/.github")) {
        corrupt(
          "document.configuration.deliveryGrant.governingPolicy.repositoryIdentity",
          "must identify an owner or organization .github repository",
        );
      }
      assertRepositoryRelativePath(
        policy.path,
        "document.configuration.deliveryGrant.governingPolicy.path",
      );
      assertGitSha(
        policy.revision,
        "document.configuration.deliveryGrant.governingPolicy.revision",
      );
      assertSha256(
        policy.digest,
        "document.configuration.deliveryGrant.governingPolicy.digest",
      );
      if (deliveryGrant.requiredChecks.length === 0) {
        corrupt(
          "document.configuration.deliveryGrant.requiredChecks",
          "must contain at least one required check",
        );
      }
      assertUnique(
        deliveryGrant.requiredChecks.map((entry) => entry.toLowerCase()),
        "document.configuration.deliveryGrant.requiredChecks",
        "case-insensitive check name",
      );
      if (
        JSON.stringify(deliveryGrant.requiredChecks) !==
        JSON.stringify([...deliveryGrant.requiredChecks].sort())
      ) {
        corrupt(
          "document.configuration.deliveryGrant.requiredChecks",
          "must be ordered by check name",
        );
      }
    }
    assertUnique(
      authoringContext.entries.map((entry) => entry.path),
      "document.configuration.authoringContext.entries",
      "context path",
    );
    const orderedPaths = authoringContext.entries.map((entry) => entry.path);
    if (
      JSON.stringify(orderedPaths) !== JSON.stringify([...orderedPaths].sort())
    ) {
      corrupt(
        "document.configuration.authoringContext.entries",
        "must be ordered by path",
      );
    }
    for (const [index, entry] of authoringContext.entries.entries()) {
      assertRepositoryRelativePath(
        entry.path,
        `document.configuration.authoringContext.entries[${index}].path`,
      );
      assertSha256(
        entry.digest,
        `document.configuration.authoringContext.entries[${index}].digest`,
      );
    }
  }

  assertUnique(
    document.decisions.map((entry) => entry.id),
    "document.decisions",
    "decision id",
  );
  for (const [index, decision] of document.decisions.entries()) {
    timestamp(decision.recordedAt, `document.decisions[${index}].recordedAt`);
    if (decision.kind === "exception") {
      if (!/^GP-\d{2}$/u.test(decision.principleId ?? "")) {
        corrupt(
          `document.decisions[${index}].principleId`,
          "must identify one GP-xx principle for an exception",
        );
      }
      if (decision.doctrine === null) {
        corrupt(
          `document.decisions[${index}].doctrine`,
          "must pin the doctrine governing an exception",
        );
      }
    } else if (decision.principleId !== null || decision.doctrine !== null) {
      corrupt(
        `document.decisions[${index}]`,
        "may pin a principle and doctrine only for an exception",
      );
    }
    if (decision.doctrine !== null) {
      assertRepositoryRelativePath(
        decision.doctrine.path,
        `document.decisions[${index}].doctrine.path`,
      );
      assertSha256(
        decision.doctrine.digest,
        `document.decisions[${index}].doctrine.digest`,
      );
    }
  }

  if (document.plan !== null) {
    timestamp(document.plan.recordedAt, "document.plan.recordedAt");
    assertUnique(
      document.plan.acceptanceCriteria,
      "document.plan.acceptanceCriteria",
      "criterion",
    );
  }

  if (document.humanAttachment !== null) {
    const attachment = document.humanAttachment;
    if (attachment.repositoryIdentity !== document.repositoryIdentity) {
      corrupt(
        "document.humanAttachment.repositoryIdentity",
        "must match document.repositoryIdentity",
      );
    }
    if (!nodePath.isAbsolute(attachment.path)) {
      corrupt("document.humanAttachment.path", "must be absolute");
    }
    timestamp(attachment.attachedAt, "document.humanAttachment.attachedAt");
    if (attachment.inspection.status === "observed") {
      assertNullableGitSha(
        attachment.inspection.headSha,
        "document.humanAttachment.inspection.headSha",
      );
      const observedAt = timestamp(
        attachment.inspection.observedAt,
        "document.humanAttachment.inspection.observedAt",
      );
      if (
        observedAt >
        timestamp(attachment.attachedAt, "document.humanAttachment.attachedAt")
      ) {
        corrupt(
          "document.humanAttachment.inspection.observedAt",
          "must not follow attachedAt",
        );
      }
    }
  }

  assertUnique(
    document.attempts.map((attempt) => attempt.id),
    "document.attempts",
    "attempt id",
  );
  let activeLeaseCount = 0;
  const liveWorkspacePaths = new Set<string>();
  const liveManagedPaths = new Set<string>();
  const liveManagedBranches = new Set<string>();
  let pinnedManagedWorkspace: ManagedWorkspacePin | null = null;
  for (const [index, attempt] of document.attempts.entries()) {
    const path = `document.attempts[${index}]`;
    if (attempt.ordinal !== index + 1) {
      corrupt(`${path}.ordinal`, `must equal append-only ordinal ${index + 1}`);
    }
    const startedAt = timestamp(attempt.startedAt, `${path}.startedAt`);
    const acquiredAt = timestamp(
      attempt.runtimeLease.acquiredAt,
      `${path}.runtimeLease.acquiredAt`,
    );
    const renewedAt = timestamp(
      attempt.runtimeLease.renewedAt,
      `${path}.runtimeLease.renewedAt`,
    );
    const expiresAt = timestamp(
      attempt.runtimeLease.expiresAt,
      `${path}.runtimeLease.expiresAt`,
    );
    if (
      acquiredAt < startedAt ||
      renewedAt < acquiredAt ||
      expiresAt <= renewedAt
    ) {
      corrupt(
        `${path}.runtimeLease`,
        "must satisfy startedAt <= acquiredAt <= renewedAt < expiresAt",
      );
    }
    if (
      attempt.runtimeLease.controllerGeneration > document.controller.generation
    ) {
      corrupt(
        `${path}.runtimeLease.controllerGeneration`,
        "must not exceed the WorkSession controller generation",
      );
    }

    if (attempt.runtimeLease.status === "active") {
      activeLeaseCount += 1;
      if (
        attempt.status !== "running" ||
        attempt.finishedAt !== null ||
        attempt.runtimeLease.releasedAt !== null ||
        attempt.runtimeLease.controllerGeneration !==
          document.controller.generation
      ) {
        corrupt(
          path,
          "with an active lease must be running, unfinished, unreleased, and fenced by the current controller",
        );
      }
    } else {
      if (
        attempt.status === "running" ||
        attempt.finishedAt === null ||
        attempt.runtimeLease.releasedAt === null
      ) {
        corrupt(
          path,
          "with an inactive lease must be terminal, finished, and released",
        );
      }
      timestamp(attempt.finishedAt, `${path}.finishedAt`);
      timestamp(
        attempt.runtimeLease.releasedAt,
        `${path}.runtimeLease.releasedAt`,
      );
      if (
        attempt.runtimeLease.status === "expired" &&
        attempt.status !== "interrupted"
      ) {
        corrupt(path, "with an expired lease must be interrupted");
      }
    }

    if (attempt.workspaceLease !== null) {
      timestamp(
        attempt.workspaceLease.recordedAt,
        `${path}.workspaceLease.recordedAt`,
      );
      if (attempt.workspaceLease.removalPolicy !== "guarded") {
        corrupt(
          `${path}.workspaceLease.removalPolicy`,
          `must be guarded for ${attempt.workspaceLease.mode} mode`,
        );
      }
      if (!nodePath.isAbsolute(attempt.workspaceLease.path)) {
        corrupt(`${path}.workspaceLease.path`, "must be absolute");
      }
      if (attempt.workspaceLease.mode !== "managed") {
        liveWorkspacePaths.add(attempt.workspaceLease.path);
      }
      if (attempt.workspaceLease.mode === "managed") {
        const lease = attempt.workspaceLease;
        const pin = managedWorkspacePin(lease);
        if (pinnedManagedWorkspace === null) {
          pinnedManagedWorkspace = pin;
        } else if (
          JSON.stringify(pinnedManagedWorkspace) !== JSON.stringify(pin)
        ) {
          corrupt(
            `${path}.workspaceLease`,
            "must preserve the WorkSession's pinned managed repository base",
          );
        }
        if (
          !nodePath.isAbsolute(lease.path) ||
          !nodePath.isAbsolute(lease.sourceRoot) ||
          !nodePath.isAbsolute(lease.workspaceRoot)
        ) {
          corrupt(path, "managed workspace paths must be absolute");
        }
        if (!lease.profileDigest.startsWith("sha256:")) {
          corrupt(`${path}.workspaceLease.profileDigest`, "must use sha256:");
        }
        if (
          document.configuration !== null &&
          (lease.repositoryIdentity !== document.repositoryIdentity ||
            lease.profileDigest !==
              document.configuration.productProfile.digest)
        ) {
          corrupt(
            `${path}.workspaceLease`,
            "must match the WorkSession's accepted product configuration",
          );
        }
        if (!/^[0-9a-f]{40}$/u.test(lease.baseSha)) {
          corrupt(`${path}.workspaceLease.baseSha`, "must be a full Git SHA-1");
        }
        if (lease.controllerGeneration > document.controller.generation) {
          corrupt(
            `${path}.workspaceLease.controllerGeneration`,
            "must not exceed the WorkSession controller generation",
          );
        }
        if (
          lease.phase === "superseded" &&
          attempt.runtimeLease.status === "active"
        ) {
          corrupt(
            `${path}.workspaceLease.phase`,
            "cannot be superseded while its Attempt runtime lease is active",
          );
        }
        if (lease.phase !== "removed" && lease.phase !== "superseded") {
          if (liveManagedPaths.has(lease.path)) {
            corrupt(
              `${path}.workspaceLease.path`,
              `duplicates live managed workspace ${lease.path}`,
            );
          }
          if (liveManagedBranches.has(lease.branch)) {
            corrupt(
              `${path}.workspaceLease.branch`,
              `duplicates live managed branch ${lease.branch}`,
            );
          }
          liveManagedPaths.add(lease.path);
          liveManagedBranches.add(lease.branch);
          liveWorkspacePaths.add(lease.path);
        }
        if (lease.phase === "removed") {
          if (lease.removedAt === null) {
            corrupt(
              `${path}.workspaceLease.removedAt`,
              "must be present when phase is removed",
            );
          }
          timestamp(lease.removedAt, `${path}.workspaceLease.removedAt`);
        } else if (lease.removedAt !== null) {
          corrupt(
            `${path}.workspaceLease.removedAt`,
            "must be null until phase is removed",
          );
        }
      }
    }
    if (attempt.preparation !== null) {
      const preparation = attempt.preparation;
      if (attempt.workspaceLease === null) {
        corrupt(
          `${path}.preparation`,
          "requires an Attempt-owned workspace lease",
        );
      }
      timestamp(preparation.startedAt, `${path}.preparation.startedAt`);
      if (!nodePath.isAbsolute(preparation.cachePath)) {
        corrupt(`${path}.preparation.cachePath`, "must be absolute");
      }
      for (const [name, digest] of [
        ["manifestDigest", preparation.manifestDigest],
        ["lockfileDigest", preparation.lockfileDigest],
        ["inputDigest", preparation.inputDigest],
      ] as const) {
        if (digest !== null && !digest.startsWith("sha256:")) {
          corrupt(`${path}.preparation.${name}`, "must use sha256:");
        }
      }
      if (
        preparation.status === "succeeded" &&
        (preparation.manifestDigest === null ||
          preparation.lockfileDigest === null ||
          preparation.inputDigest === null)
      ) {
        corrupt(
          `${path}.preparation`,
          "requires all input digests when succeeded",
        );
      }
      if (preparation.dependencyPolicy !== null) {
        assertSha256(
          preparation.dependencyPolicy.digest,
          `${path}.preparation.dependencyPolicy.digest`,
        );
        if (!nodePath.isAbsolute(preparation.dependencyPolicy.seedStoreRoot)) {
          corrupt(
            `${path}.preparation.dependencyPolicy.seedStoreRoot`,
            "must be absolute",
          );
        }
        let registry: URL;
        try {
          registry = new URL(preparation.dependencyPolicy.registry);
        } catch {
          corrupt(
            `${path}.preparation.dependencyPolicy.registry`,
            "must be an absolute URL",
          );
        }
        if (
          registry.protocol !== "https:" ||
          registry.username !== "" ||
          registry.password !== ""
        ) {
          corrupt(
            `${path}.preparation.dependencyPolicy.registry`,
            "must be credential-free HTTPS",
          );
        }
      }
      if (preparation.status === "running") {
        if (
          attempt.runtimeLease.status !== "active" ||
          preparation.finishedAt !== null ||
          preparation.error !== null
        ) {
          corrupt(
            `${path}.preparation`,
            "can be running only under an active lease without a terminal result",
          );
        }
      } else {
        if (preparation.finishedAt === null) {
          corrupt(
            `${path}.preparation.finishedAt`,
            "must be present for a terminal preparation",
          );
        }
        timestamp(preparation.finishedAt, `${path}.preparation.finishedAt`);
        if (preparation.status === "succeeded" && preparation.error !== null) {
          corrupt(
            `${path}.preparation.error`,
            "must be null when preparation succeeded",
          );
        }
        if (
          preparation.status !== "succeeded" &&
          (preparation.error === null || preparation.error.trim() === "")
        ) {
          corrupt(
            `${path}.preparation.error`,
            "must explain an unsuccessful preparation",
          );
        }
      }
    }
  }
  if (activeLeaseCount > 1) {
    corrupt(
      "document.attempts",
      "must contain at most one active runtime lease",
    );
  }
  if (
    document.humanAttachment !== null &&
    (activeLeaseCount !== 0 || liveWorkspacePaths.size !== 0)
  ) {
    corrupt(
      "document.humanAttachment",
      "cannot coexist with an active runtime or live Attempt workspace lease",
    );
  }

  if (document.retry !== null) {
    const recordedAt = timestamp(
      document.retry.recordedAt,
      "document.retry.recordedAt",
    );
    const dueAt = timestamp(document.retry.dueAt, "document.retry.dueAt");
    if (dueAt < recordedAt) {
      corrupt(
        "document.retry.dueAt",
        "must not precede document.retry.recordedAt",
      );
    }
    if (document.status !== "active" || activeLeaseCount !== 0) {
      corrupt(
        "document.retry",
        "requires an active WorkSession with no active runtime lease",
      );
    }
  }
  if (document.status !== "active" && activeLeaseCount !== 0) {
    corrupt(
      "document.status",
      "cannot be terminal while a runtime lease is active",
    );
  }
  if (document.status !== "active" && document.retry !== null) {
    corrupt("document.retry", "must be null for a terminal WorkSession");
  }

  assertUnique(
    document.materializations.map((entry) => entry.id),
    "document.materializations",
    "materialization id",
  );
  for (const [index, materialization] of document.materializations.entries()) {
    const path = `document.materializations[${index}]`;
    const attempt = document.attempts.find(
      (entry) => entry.id === materialization.attemptId,
    );
    const lease = attempt?.workspaceLease;
    if (
      attempt === undefined ||
      lease?.mode !== "managed" ||
      lease.leaseToken !== materialization.workspaceLeaseToken ||
      lease.branch !== materialization.branch
    ) {
      corrupt(path, "must bind one matching managed workspace lease");
    }
    if (attempt.runtimeLease.status === "active") {
      corrupt(path, "cannot begin while its Attempt runtime lease is active");
    }
    if (materialization.controllerGeneration > document.controller.generation) {
      corrupt(
        `${path}.controllerGeneration`,
        "must not exceed the WorkSession controller generation",
      );
    }
    assertGitSha(materialization.parentSha, `${path}.parentSha`);
    assertGitSha(materialization.expectedOldSha, `${path}.expectedOldSha`);
    assertSha256(
      materialization.inclusionPolicyDigest,
      `${path}.inclusionPolicyDigest`,
    );
    if (materialization.inputManifestDigest !== null) {
      assertSha256(
        materialization.inputManifestDigest,
        `${path}.inputManifestDigest`,
      );
    }
    assertNullableGitSha(materialization.treeSha, `${path}.treeSha`);
    assertNullableGitSha(materialization.commitSha, `${path}.commitSha`);
    const startedAt = timestamp(materialization.startedAt, `${path}.startedAt`);
    const materializationUpdatedAt = timestamp(
      materialization.updatedAt,
      `${path}.updatedAt`,
    );
    if (materializationUpdatedAt < startedAt) {
      corrupt(`${path}.updatedAt`, "must not precede startedAt");
    }
    const phaseRank = [
      "intent_recorded",
      "snapshot_recorded",
      "tree_written",
      "commit_written",
      "branch_updated",
    ].indexOf(materialization.phase);
    if (
      phaseRank >= 1 &&
      (materialization.inputManifestDigest === null ||
        materialization.inputManifest === null)
    ) {
      corrupt(
        `${path}.inputManifest`,
        "must be present after the snapshot is recorded",
      );
    }
    if (materialization.inputManifest !== null) {
      assertUnique(
        materialization.inputManifest.map((entry) => entry.path),
        `${path}.inputManifest`,
        "input path",
      );
      const orderedPaths = materialization.inputManifest.map(
        (entry) => entry.path,
      );
      if (
        JSON.stringify(orderedPaths) !==
        JSON.stringify([...orderedPaths].sort())
      ) {
        corrupt(`${path}.inputManifest`, "must be ordered by path");
      }
      for (const [
        entryIndex,
        entry,
      ] of materialization.inputManifest.entries()) {
        const entryPath = `${path}.inputManifest[${entryIndex}]`;
        assertRepositoryRelativePath(entry.path, `${entryPath}.path`);
        assertSha256(entry.contentDigest, `${entryPath}.contentDigest`);
        assertGitSha(entry.blobSha, `${entryPath}.blobSha`);
        if (entry.kind === "symlink" && entry.mode !== "120000") {
          corrupt(`${entryPath}.mode`, "must be 120000 for a symlink");
        }
        if (entry.kind === "regular" && entry.mode === "120000") {
          corrupt(`${entryPath}.mode`, "must be a regular-file mode");
        }
      }
    }
    if (phaseRank >= 2 && materialization.treeSha === null) {
      corrupt(`${path}.treeSha`, "must be present after the tree is written");
    }
    if (phaseRank >= 3 && materialization.commitSha === null) {
      corrupt(
        `${path}.commitSha`,
        "must be present after the commit is written",
      );
    }
    if (materialization.phase === "refused") {
      if (materialization.lastError === null) {
        corrupt(`${path}.lastError`, "must explain a refusal");
      }
    } else if (materialization.lastError !== null) {
      corrupt(
        `${path}.lastError`,
        "must be null unless materialization refused",
      );
    }
  }

  assertUnique(
    document.proof.map((entry) => entry.id),
    "document.proof",
    "proof correlation id",
  );
  for (const [index, proof] of document.proof.entries()) {
    const path = `document.proof[${index}]`;
    assertGitSha(proof.sourceSha, `${path}.sourceSha`);
    assertSha256(proof.planDigest, `${path}.planDigest`);
    for (const [name, digest] of [
      ["adapterDigest", proof.adapterDigest],
      ["policyDigest", proof.policyDigest],
      ["resultDigest", proof.resultDigest],
      ["evidenceDigest", proof.evidenceDigest],
    ] as const) {
      if (digest !== null) assertSha256(digest, `${path}.${name}`);
    }
    timestamp(proof.recordedAt, `${path}.recordedAt`);
    if (proof.status === "pending") {
      if (proof.observedAt !== null) {
        corrupt(`${path}.observedAt`, "must be null while proof is pending");
      }
    } else if (proof.observedAt === null) {
      corrupt(`${path}.observedAt`, "must be present for terminal proof");
    } else {
      timestamp(proof.observedAt, `${path}.observedAt`);
    }
  }

  const historicalMaterializations = new Set<string>();
  for (const [index, delivery] of document.deliveryHistory.entries()) {
    const path = `document.deliveryHistory[${index}]`;
    if (
      delivery.phase !== "completed" &&
      !(
        delivery.phase === "refused" &&
        (delivery.cleanupStatus === "completed" ||
          delivery.cleanupStatus === "retained")
      )
    ) {
      corrupt(
        `${path}.phase`,
        "must be completed or refused with resolved cleanup before archival",
      );
    }
    if (
      delivery.materializationId !== null &&
      historicalMaterializations.has(delivery.materializationId)
    ) {
      corrupt(
        `${path}.materializationId`,
        "must not duplicate another historical delivery",
      );
    }
    if (delivery.materializationId !== null) {
      historicalMaterializations.add(delivery.materializationId);
    }
    // Reuse the complete current-delivery invariant set without maintaining a
    // second, weaker validator for archived evidence.
    assertDocumentInvariants({
      ...document,
      deliveryHistory: [],
      delivery,
    });
  }

  if (
    document.delivery?.materializationId !== null &&
    document.delivery?.materializationId !== undefined &&
    historicalMaterializations.has(document.delivery.materializationId)
  ) {
    corrupt(
      "document.delivery.materializationId",
      "must not duplicate a historical delivery",
    );
  }

  if (document.delivery !== null) {
    const delivery = document.delivery;
    const deliveryStartedAt = timestamp(
      delivery.startedAt,
      "document.delivery.startedAt",
    );
    const deliveryUpdatedAt = timestamp(
      delivery.updatedAt,
      "document.delivery.updatedAt",
    );
    if (deliveryUpdatedAt < deliveryStartedAt) {
      corrupt("document.delivery.updatedAt", "must not precede startedAt");
    }
    for (const [name, sha] of [
      ["immutableHeadSha", delivery.immutableHeadSha],
      ["expectedRemoteHeadSha", delivery.expectedRemoteHeadSha],
      ["remoteHeadSha", delivery.remoteHeadSha],
      ["mergeSha", delivery.mergeSha],
    ] as const) {
      assertNullableGitSha(sha, `document.delivery.${name}`);
    }
    if (delivery.materializationId === null) {
      if (delivery.phase !== "refused") {
        corrupt(
          "document.delivery.materializationId",
          "may be null only for a refused migrated legacy delivery",
        );
      }
    } else {
      const materialization = document.materializations.find(
        (entry) => entry.id === delivery.materializationId,
      );
      if (materialization === undefined) {
        corrupt(
          "document.delivery.materializationId",
          "must identify a WorkSession materialization",
        );
      }
      if (
        delivery.immutableHeadSha !== null &&
        materialization.commitSha !== delivery.immutableHeadSha
      ) {
        corrupt(
          "document.delivery.immutableHeadSha",
          "must equal the bound materialization commit",
        );
      }
    }
    if (delivery.phase === "refused" && delivery.lastError === null) {
      corrupt("document.delivery.lastError", "must explain a refusal");
    } else if (delivery.phase !== "refused" && delivery.lastError !== null) {
      corrupt(
        "document.delivery.lastError",
        "must be null unless delivery is refused",
      );
    }
    assertUnique(
      delivery.requiredChecks.map((check) => check.name),
      "document.delivery.requiredChecks",
      "required check name",
    );
    for (const [index, check] of delivery.requiredChecks.entries()) {
      const path = `document.delivery.requiredChecks[${index}]`;
      assertGitSha(check.headSha, `${path}.headSha`);
      if (
        delivery.immutableHeadSha !== null &&
        check.headSha !== delivery.immutableHeadSha
      ) {
        corrupt(`${path}.headSha`, "must match the immutable delivery head");
      }
      if (check.status === "pending") {
        if (check.observedAt !== null) {
          corrupt(`${path}.observedAt`, "must be null while check is pending");
        }
      } else if (check.observedAt === null) {
        corrupt(`${path}.observedAt`, "must be present for a terminal check");
      } else {
        timestamp(check.observedAt, `${path}.observedAt`);
      }
    }
    const ordinaryPhases = [
      "intent_recorded",
      "push_pending",
      "pushed",
      "pull_request_pending",
      "pull_request_open",
      "checks_pending",
      "review_pending",
      "merge_pending",
      "merged",
      "cleanup_pending",
      "completed",
    ] as const;
    const phaseRank = ordinaryPhases.indexOf(
      delivery.phase as (typeof ordinaryPhases)[number],
    );
    if (phaseRank >= 0) {
      if (
        delivery.materializationId === null ||
        delivery.branch === null ||
        delivery.immutableHeadSha === null
      ) {
        corrupt(
          "document.delivery",
          "ordinary delivery must bind a materialization, branch, and immutable head",
        );
      }
      if (
        phaseRank >= ordinaryPhases.indexOf("pushed") &&
        delivery.remoteHeadSha !== delivery.immutableHeadSha
      ) {
        corrupt(
          "document.delivery.remoteHeadSha",
          "must equal the immutable head after the exact push is observed",
        );
      }
      if (
        phaseRank >= ordinaryPhases.indexOf("pull_request_open") &&
        delivery.pullRequest === null
      ) {
        corrupt(
          "document.delivery.pullRequest",
          "must be present after the pull request is observed",
        );
      }
      if (
        phaseRank >= ordinaryPhases.indexOf("review_pending") &&
        delivery.requiredChecks.some((check) => check.status !== "passed")
      ) {
        corrupt(
          "document.delivery.requiredChecks",
          "must all pass before review or merge",
        );
      }
      if (
        phaseRank >= ordinaryPhases.indexOf("merged") &&
        delivery.mergeSha === null
      ) {
        corrupt(
          "document.delivery.mergeSha",
          "must be present after merge is observed",
        );
      }
      if (
        delivery.phase === "completed" &&
        delivery.cleanupStatus !== "completed" &&
        delivery.cleanupStatus !== "retained"
      ) {
        corrupt(
          "document.delivery.cleanupStatus",
          "must record completed or deliberately retained cleanup",
        );
      }
      if (
        phaseRank >= ordinaryPhases.indexOf("cleanup_pending") &&
        delivery.releaseIntentId === null
      ) {
        corrupt(
          "document.delivery.releaseIntentId",
          "must identify the remote-branch release effect during cleanup",
        );
      }
    }
  }
}

export function parseWorkSessionDocument(source: string): WorkSessionDocument {
  let decoded: unknown;
  try {
    decoded = JSON.parse(source) as unknown;
  } catch (error) {
    throw new StateStoreError(
      "state_corrupt",
      "Symphony WorkSession document is not valid JSON",
      { cause: error },
    );
  }
  const value = record(decoded, "document");
  if (value["schemaVersion"] !== WORK_SESSION_SCHEMA_VERSION) {
    corrupt(
      "document.schemaVersion",
      `must equal supported version ${WORK_SESSION_SCHEMA_VERSION}`,
    );
  }
  const document: WorkSessionDocument = {
    schemaVersion: WORK_SESSION_SCHEMA_VERSION,
    id: nonEmptyString(value["id"], "document.id"),
    origin: parseOrigin(value["origin"]),
    repositoryIdentity: nonEmptyString(
      value["repositoryIdentity"],
      "document.repositoryIdentity",
    ),
    intent: nonEmptyString(value["intent"], "document.intent"),
    status: oneOf(value["status"], "document.status", [
      "active",
      "cancelled",
      "completed",
    ] as const),
    doctrine: parseDoctrine(value["doctrine"]),
    configuration: parseConfiguration(value["configuration"]),
    controller: parseController(value["controller"]),
    decisions: parseDecisions(value["decisions"]),
    plan: parsePlan(value["plan"]),
    humanAttachment: parseHumanAttachment(value["humanAttachment"]),
    attempts: parseAttempts(value["attempts"]),
    retry: parseRetry(value["retry"]),
    materializations: parseMaterializations(value["materializations"]),
    proof: parseProof(value["proof"]),
    deliveryHistory:
      value["deliveryHistory"] === undefined
        ? []
        : array(value["deliveryHistory"], "document.deliveryHistory").map(
            (entry, index) => {
              const delivery = parseDelivery(entry);
              if (delivery === null) {
                corrupt(
                  `document.deliveryHistory[${index}]`,
                  "must contain a delivery object",
                );
              }
              return delivery;
            },
          ),
    delivery: parseDelivery(value["delivery"]),
    createdAt: nonEmptyString(value["createdAt"], "document.createdAt"),
    updatedAt: nonEmptyString(value["updatedAt"], "document.updatedAt"),
  };
  assertDocumentInvariants(document);
  return document;
}
