import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { isRecord, toJsonObject, type JsonObject } from "../shared/json.js";
import {
  WORK_SESSION_SCHEMA_VERSION,
  type AppendDecisionInput,
  type AttemptRecord,
  type AttachHumanWorkspaceInput,
  type BeginDeliveryInput,
  type BeginMaterializationInput,
  type BeginManagedWorkspaceInput,
  type BegunMaterialization,
  type BegunManagedWorkspace,
  type EffectIntent,
  type ExpiredRuntimeLeaseCandidate,
  type ExpireRuntimeLeaseInput,
  type FinishAttemptInput,
  type FinishPreparationInput,
  type ManagedWorkspaceLease,
  type RecordWorkspaceInput,
  type RecordProofInput,
  type ReplacePlanInput,
  type RenewRuntimeLeaseInput,
  type RetryIntent,
  type RuntimeCorrelationInput,
  type RuntimeLease,
  type ScheduleRetryInput,
  type StartedAttempt,
  type StartAttemptInput,
  type StartInteractiveSessionInput,
  type StartPreparationInput,
  type StartTrackerSessionInput,
  type TransitionManagedWorkspaceInput,
  type TransitionDeliveryInput,
  type TransitionMaterializationInput,
  type WorkSessionDocument,
  type WorkSessionSnapshot,
  type WorkspaceLease,
} from "./model.js";
import { type SymphonyStateStore, StateStoreError } from "./store.js";
import { parseWorkSessionDocument } from "./validation.js";

const DATABASE_SCHEMA_VERSION = 2;

export function stateDatabasePath(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), ".symphony", "state.sqlite");
}

export function stateDatabasePathFromStateRoot(stateRoot: string): string {
  return path.join(path.resolve(stateRoot), "state.sqlite");
}

interface SessionRow {
  readonly created_at: string;
  readonly document_json: string;
  readonly id: string;
  readonly origin_kind: "interactive" | "tracker";
  readonly repository_identity: string;
  readonly revision: number;
  readonly status: "active" | "cancelled" | "completed";
  readonly updated_at: string;
}

interface EffectRow {
  readonly id: string;
  readonly session_id: string;
  readonly kind: string;
  readonly idempotency_key: string;
  readonly controller_generation: number;
  readonly status: "pending" | "applied" | "failed";
  readonly payload_json: string;
  readonly result_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

function trackerOriginKey(
  trackerKind: string,
  repositoryIdentity: string,
  issueId: string,
): string {
  return JSON.stringify(["tracker", trackerKind, repositoryIdentity, issueId]);
}

function timestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new TypeError(`${label} must be an ISO-8601 timestamp`);
  }
  return parsed;
}

function snapshot(
  document: WorkSessionDocument,
  revision: number,
): WorkSessionSnapshot {
  return { ...document, revision };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseJsonObject(source: string, label: string): JsonObject {
  let decoded: unknown;
  try {
    decoded = JSON.parse(source) as unknown;
  } catch (error) {
    throw new StateStoreError("state_corrupt", `${label} is invalid JSON`, {
      cause: error,
    });
  }
  try {
    return toJsonObject(decoded, label);
  } catch (error) {
    throw new StateStoreError("state_corrupt", `${label} is not an object`, {
      cause: error,
    });
  }
}

function migrationString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new StateStoreError(
      "state_corrupt",
      `Cannot migrate v1 WorkSession: ${label} must be a non-empty string`,
    );
  }
  return value;
}

/** Deterministic, side-effect-free document migration used inside one SQLite transaction. */
function migrateV1WorkSessionDocument(source: string): WorkSessionDocument {
  let decoded: unknown;
  try {
    decoded = JSON.parse(source) as unknown;
  } catch (error) {
    throw new StateStoreError(
      "state_corrupt",
      "Cannot migrate v1 WorkSession with invalid JSON",
      { cause: error },
    );
  }
  if (!isRecord(decoded) || decoded["schemaVersion"] !== 1) {
    throw new StateStoreError(
      "state_corrupt",
      "Database schema v1 contains a WorkSession that is not document schema v1",
    );
  }
  if (!Array.isArray(decoded["attempts"])) {
    throw new StateStoreError(
      "state_corrupt",
      "Cannot migrate v1 WorkSession without an attempts array",
    );
  }

  const repositoryIdentity = migrationString(
    decoded["repositoryIdentity"],
    "repositoryIdentity",
  );
  const controller = decoded["controller"];
  if (!isRecord(controller)) {
    throw new StateStoreError(
      "state_corrupt",
      "Cannot migrate v1 WorkSession without a controller",
    );
  }
  const attachedBy = migrationString(
    controller["controllerId"],
    "controller.controllerId",
  );
  let humanAttachment: Record<string, unknown> | null = null;
  const attempts = decoded["attempts"].map((value, index) => {
    if (!isRecord(value)) {
      throw new StateStoreError(
        "state_corrupt",
        `Cannot migrate v1 WorkSession attempt ${index}: not an object`,
      );
    }
    const attempt = { ...value };
    const lease = attempt["workspaceLease"];
    if (!isRecord(lease) || lease["mode"] !== "attached") return attempt;
    if (humanAttachment !== null) {
      throw new StateStoreError(
        "state_corrupt",
        "Cannot migrate a v1 WorkSession with multiple attached workspaces",
      );
    }
    const runtimeLease = attempt["runtimeLease"];
    if (!isRecord(runtimeLease) || runtimeLease["status"] === "active") {
      throw new StateStoreError(
        "state_corrupt",
        "Refusing to migrate a v1 attached workspace while its Attempt may still be active",
      );
    }
    if (
      attempt["preparation"] !== null &&
      attempt["preparation"] !== undefined
    ) {
      throw new StateStoreError(
        "state_corrupt",
        "Refusing to migrate a v1 attached workspace with Attempt-owned preparation state",
      );
    }
    const workspaceKey = migrationString(
      lease["workspaceKey"],
      `attempts[${index}].workspaceLease.workspaceKey`,
    );
    humanAttachment = {
      kind: "human-attachment",
      id: `migrated:${workspaceKey}`,
      ownership: "human",
      path: migrationString(
        lease["path"],
        `attempts[${index}].workspaceLease.path`,
      ),
      repositoryIdentity,
      inspection: { status: "unknown" },
      removalPolicy: "never",
      attachedBy,
      attachedAt: migrationString(
        lease["recordedAt"],
        `attempts[${index}].workspaceLease.recordedAt`,
      ),
    };
    attempt["workspaceLease"] = null;
    return attempt;
  });

  const decisionsValue = decoded["decisions"];
  if (!Array.isArray(decisionsValue)) {
    throw new StateStoreError(
      "state_corrupt",
      "Cannot migrate v1 WorkSession without a decisions array",
    );
  }
  const decisions = decisionsValue.map((value, index) => {
    if (!isRecord(value)) {
      throw new StateStoreError(
        "state_corrupt",
        `Cannot migrate v1 WorkSession decision ${index}: not an object`,
      );
    }
    const kind = value["kind"];
    if (kind !== "exception") {
      return { ...value, principleId: null, doctrine: null };
    }
    const text = migrationString(value["text"], `decisions[${index}].text`);
    const principleId = /\b(GP-\d{2})\b/u.exec(text)?.[1] ?? null;
    if (principleId === null || decoded["doctrine"] === null) {
      throw new StateStoreError(
        "state_corrupt",
        `Cannot migrate v1 exception decision ${index} without a GP-xx reference and pinned doctrine`,
      );
    }
    return {
      ...value,
      principleId,
      doctrine: decoded["doctrine"],
    };
  });

  const proofValue = decoded["proof"];
  if (!Array.isArray(proofValue)) {
    throw new StateStoreError(
      "state_corrupt",
      "Cannot migrate v1 WorkSession without a proof array",
    );
  }
  const recordedAt = migrationString(decoded["updatedAt"], "updatedAt");
  const proof = proofValue.map((value, index) => {
    if (!isRecord(value)) {
      throw new StateStoreError(
        "state_corrupt",
        `Cannot migrate v1 WorkSession proof ${index}: not an object`,
      );
    }
    return {
      id: migrationString(value["requestId"], `proof[${index}].requestId`),
      checkName: null,
      checkRunId: null,
      workflowRunId: null,
      sourceSha: value["sourceSha"],
      planDigest: value["planDigest"],
      adapterDigest: null,
      policyDigest: null,
      resultDigest: null,
      evidenceDigest: null,
      status: value["status"],
      recordedAt,
      observedAt: value["status"] === "pending" ? null : recordedAt,
    };
  });

  const legacyDelivery = decoded["delivery"];
  let delivery: Record<string, unknown> | null = null;
  if (legacyDelivery !== null) {
    if (!isRecord(legacyDelivery)) {
      throw new StateStoreError(
        "state_corrupt",
        "Cannot migrate malformed v1 delivery state",
      );
    }
    const legacyPhase = migrationString(
      legacyDelivery["phase"],
      "delivery.phase",
    );
    delivery = {
      phase: "refused",
      materializationId: null,
      branch: legacyDelivery["branch"],
      pullRequest: legacyDelivery["pullRequest"],
      immutableHeadSha: legacyDelivery["immutableHeadSha"],
      expectedRemoteHeadSha: null,
      remoteHeadSha: null,
      requiredChecks: [],
      mergeSha: null,
      cleanupStatus: "refused",
      releaseIntentId: null,
      lastError: `Migrated unbound v1 delivery phase ${legacyPhase}; operator reconciliation required`,
      startedAt: migrationString(decoded["createdAt"], "createdAt"),
      updatedAt: recordedAt,
    };
  }

  return parseWorkSessionDocument(
    JSON.stringify({
      ...decoded,
      schemaVersion: WORK_SESSION_SCHEMA_VERSION,
      configuration: null,
      decisions,
      plan: null,
      humanAttachment,
      attempts,
      materializations: [],
      proof,
      deliveryHistory: [],
      delivery,
    }),
  );
}

function effectFromRow(row: EffectRow): EffectIntent {
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    idempotencyKey: row.idempotency_key,
    controllerGeneration: row.controller_generation,
    status: row.status,
    payload: parseJsonObject(row.payload_json, `effect ${row.id} payload`),
    result:
      row.result_json === null
        ? null
        : parseJsonObject(row.result_json, `effect ${row.id} result`),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function activeAttempt(document: WorkSessionDocument): AttemptRecord | null {
  return (
    document.attempts.find(
      (attempt) => attempt.runtimeLease.status === "active",
    ) ?? null
  );
}

function liveWorkspacePaths(document: WorkSessionDocument): readonly string[] {
  const paths: string[] = [];
  for (const attempt of document.attempts) {
    const lease = attempt.workspaceLease;
    if (lease === null) continue;
    if (
      lease.mode === "managed" &&
      (lease.phase === "removed" || lease.phase === "superseded")
    ) {
      continue;
    }
    paths.push(lease.path);
  }
  return paths;
}

function workspacePathsOverlap(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  const inside = (relative: string) =>
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative));
  return (
    inside(path.relative(normalizedLeft, normalizedRight)) ||
    inside(path.relative(normalizedRight, normalizedLeft))
  );
}

function assertExpectedRevision(
  row: SessionRow,
  expectedRevision: number,
  operation: string,
): void {
  if (row.revision !== expectedRevision) {
    throw new StateStoreError(
      "stale_revision",
      `Cannot ${operation} WorkSession ${row.id} at revision ${expectedRevision}; current revision is ${row.revision}`,
    );
  }
}

function assertActiveLease(
  document: WorkSessionDocument,
  input: {
    readonly attemptId: string;
    readonly runtimeLeaseToken: string;
    readonly controllerGeneration: number;
    readonly now: string;
  },
): { readonly attempt: AttemptRecord; readonly index: number } {
  if (
    input.controllerGeneration !== document.controller.generation ||
    document.status !== "active"
  ) {
    throw new StateStoreError(
      "stale_fence",
      `WorkSession ${document.id} controller generation is no longer active`,
    );
  }
  const index = document.attempts.findIndex(
    (attempt) => attempt.id === input.attemptId,
  );
  const attempt = document.attempts[index];
  if (
    attempt === undefined ||
    attempt.runtimeLease.status !== "active" ||
    attempt.runtimeLease.token !== input.runtimeLeaseToken ||
    attempt.runtimeLease.controllerGeneration !== input.controllerGeneration ||
    timestamp(attempt.runtimeLease.expiresAt, "runtime lease expiry") <=
      timestamp(input.now, "mutation time")
  ) {
    throw new StateStoreError(
      "stale_fence",
      `Attempt ${input.attemptId} no longer holds the active runtime lease`,
    );
  }
  return { attempt, index };
}

function replaceAttempt(
  document: WorkSessionDocument,
  index: number,
  attempt: AttemptRecord,
  now: string,
): WorkSessionDocument {
  const attempts = [...document.attempts];
  attempts[index] = attempt;
  return { ...document, attempts, updatedAt: now };
}

function interruptRunningPreparation(
  attempt: AttemptRecord,
  now: string,
  error: string,
): AttemptRecord {
  if (attempt.preparation?.status !== "running") return attempt;
  return {
    ...attempt,
    preparation: {
      ...attempt.preparation,
      status: "interrupted",
      finishedAt: now,
      error,
    },
  };
}

function noActiveLease(document: WorkSessionDocument, operation: string): void {
  if (activeAttempt(document) !== null) {
    throw new StateStoreError(
      "active_runtime_lease",
      `Cannot ${operation} WorkSession ${document.id} while a runtime lease is active`,
    );
  }
}

function assertControllerGeneration(
  document: WorkSessionDocument,
  controllerGeneration: number,
  operation: string,
): void {
  if (
    document.status !== "active" ||
    document.controller.generation !== controllerGeneration
  ) {
    throw new StateStoreError(
      "stale_fence",
      `Cannot ${operation} WorkSession ${document.id} with stale controller generation ${controllerGeneration}`,
    );
  }
}

function managedTransitionAllowed(
  from: TransitionManagedWorkspaceInput["phase"],
  to: TransitionManagedWorkspaceInput["phase"],
): boolean {
  if (from === to) return true;
  switch (from) {
    case "allocating":
      return (
        to === "provisioned" || to === "removal_pending" || to === "retained"
      );
    case "provisioned":
      return to === "ready" || to === "removal_pending" || to === "retained";
    case "ready":
      return to === "removal_pending" || to === "retained";
    case "superseded":
      return false;
    case "removal_pending":
      return to === "removed" || to === "retained";
    case "retained":
      return to === "removal_pending";
    case "removed":
      return false;
  }
}

function materializationTransitionAllowed(
  from: TransitionMaterializationInput["expectedPhases"][number],
  to: TransitionMaterializationInput["phase"],
): boolean {
  if (from === to) return true;
  if (to === "refused") return from !== "branch_updated" && from !== "refused";
  switch (from) {
    case "intent_recorded":
      return to === "snapshot_recorded";
    case "snapshot_recorded":
      return to === "tree_written";
    case "tree_written":
      return to === "commit_written";
    case "commit_written":
      return to === "branch_updated";
    case "branch_updated":
    case "refused":
      return false;
  }
}

function deliveryTransitionAllowed(
  from: TransitionDeliveryInput["expectedPhases"][number],
  to: TransitionDeliveryInput["phase"],
): boolean {
  if (from === to) return true;
  if (to === "refused") return from !== "completed" && from !== "refused";
  if (
    (from === "checks_pending" || from === "review_pending") &&
    to === "merged"
  ) {
    return true;
  }
  const sequence = [
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
  return (
    sequence.indexOf(to as (typeof sequence)[number]) ===
    sequence.indexOf(from as (typeof sequence)[number]) + 1
  );
}

/**
 * The single production persistence boundary for Symphony operational state.
 * Each mutation is one SQLite transaction over a complete WorkSession aggregate.
 */
export class SqliteSymphonyStateStore implements SymphonyStateStore {
  readonly #database: Database.Database;

  private constructor(database: Database.Database) {
    this.#database = database;
  }

  static open(databasePath: string): SqliteSymphonyStateStore {
    const memory = databasePath === ":memory:";
    const resolvedDatabasePath = memory
      ? databasePath
      : path.resolve(databasePath);
    if (!memory) {
      const directory = path.dirname(resolvedDatabasePath);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const directoryEntry = lstatSync(directory);
      if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink()) {
        throw new StateStoreError(
          "state_corrupt",
          `State directory ${directory} must be a real directory`,
        );
      }
      chmodSync(directory, 0o700);
      try {
        closeSync(openSync(resolvedDatabasePath, "wx", 0o600));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new StateStoreError(
            "state_corrupt",
            `Could not create private state database ${resolvedDatabasePath}`,
            { cause: error },
          );
        }
      }
      const databaseEntry = lstatSync(resolvedDatabasePath);
      if (!databaseEntry.isFile() || databaseEntry.isSymbolicLink()) {
        throw new StateStoreError(
          "state_corrupt",
          `State database ${resolvedDatabasePath} must be a regular file`,
        );
      }
      chmodSync(resolvedDatabasePath, 0o600);
    }

    const database = new Database(resolvedDatabasePath, { timeout: 5_000 });
    try {
      database.pragma("foreign_keys = ON");
      database.pragma("busy_timeout = 5000");
      database.pragma("synchronous = FULL");
      if (!memory) database.pragma("journal_mode = WAL");
      SqliteSymphonyStateStore.#migrate(database);
      SqliteSymphonyStateStore.#checkIntegrity(database);
      if (!memory) chmodSync(resolvedDatabasePath, 0o600);
      const store = new SqliteSymphonyStateStore(database);
      store.#checkDocuments();
      return store;
    } catch (error) {
      database.close();
      if (error instanceof StateStoreError) throw error;
      throw new StateStoreError(
        "state_corrupt",
        `Could not open Symphony state store at ${resolvedDatabasePath}`,
        { cause: error },
      );
    }
  }

  static openInMemory(): SqliteSymphonyStateStore {
    return SqliteSymphonyStateStore.open(":memory:");
  }

  static #migrate(database: Database.Database): void {
    const version = database.pragma("user_version", {
      simple: true,
    }) as number;
    if (version > DATABASE_SCHEMA_VERSION) {
      throw new StateStoreError(
        "state_corrupt",
        `State schema version ${version} is newer than supported version ${DATABASE_SCHEMA_VERSION}`,
      );
    }
    if (version === DATABASE_SCHEMA_VERSION) return;

    const migrate = database.transaction(() => {
      if (version === 0) {
        database.exec(`
          CREATE TABLE work_sessions (
            id TEXT PRIMARY KEY,
            origin_kind TEXT NOT NULL CHECK (origin_kind IN ('tracker', 'interactive')),
            origin_key TEXT NOT NULL UNIQUE,
            repository_identity TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('active', 'cancelled', 'completed')),
            revision INTEGER NOT NULL CHECK (revision >= 1),
            document_json TEXT NOT NULL CHECK (json_valid(document_json)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );

          CREATE INDEX work_sessions_status_idx ON work_sessions(status);

          CREATE TABLE effect_intents (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES work_sessions(id) ON DELETE RESTRICT,
            kind TEXT NOT NULL,
            idempotency_key TEXT NOT NULL,
            controller_generation INTEGER NOT NULL CHECK (controller_generation >= 1),
            status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'failed')),
            payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
            result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE (session_id, idempotency_key)
          );

          CREATE INDEX effect_intents_status_idx ON effect_intents(status, created_at);
        `);
      } else if (version === 1) {
        const rows = database
          .prepare("SELECT id, document_json FROM work_sessions ORDER BY id")
          .all() as Array<{ id: string; document_json: string }>;
        const update = database.prepare(
          "UPDATE work_sessions SET document_json = ? WHERE id = ?",
        );
        for (const row of rows) {
          const migrated = migrateV1WorkSessionDocument(row.document_json);
          update.run(JSON.stringify(migrated), row.id);
        }
      }
      database.pragma(`user_version = ${DATABASE_SCHEMA_VERSION}`);
    });
    migrate.immediate();
  }

  static #checkIntegrity(database: Database.Database): void {
    const rows = database.pragma("quick_check") as readonly unknown[];
    if (
      rows.length !== 1 ||
      !isRecord(rows[0]) ||
      rows[0]["quick_check"] !== "ok"
    ) {
      throw new StateStoreError(
        "state_corrupt",
        `SQLite quick_check failed: ${JSON.stringify(rows)}`,
      );
    }
  }

  getOrCreateTrackerSession(
    input: StartTrackerSessionInput,
  ): WorkSessionSnapshot {
    const originKey = trackerOriginKey(
      input.trackerKind,
      input.repositoryIdentity,
      input.issueId,
    );
    return this.#transaction(() => {
      const existing = this.#rowByOriginKey(originKey);
      if (existing !== null) {
        const current = this.#decode(existing);
        if (current.origin.kind !== "tracker") {
          throw new StateStoreError(
            "state_corrupt",
            `Origin key ${originKey} resolves to a non-tracker WorkSession`,
          );
        }
        if (
          current.attempts.length !== 0 &&
          ((current.doctrine === null && input.doctrine !== null) ||
            (current.configuration === null && input.configuration !== null))
        ) {
          throw new StateStoreError(
            "input_conflict",
            `WorkSession ${current.id} cannot pin new doctrine or configuration after its first Attempt`,
          );
        }
        const doctrine = current.doctrine ?? input.doctrine;
        const configuration = current.configuration ?? input.configuration;
        const origin = {
          ...current.origin,
          issueIdentifier: input.issueIdentifier,
          issueUrl: input.issueUrl,
        };
        if (
          current.intent === input.intent &&
          sameJson(current.origin, origin) &&
          sameJson(current.doctrine, doctrine) &&
          sameJson(current.configuration, configuration)
        ) {
          return snapshot(current, existing.revision);
        }
        return this.#write(existing, {
          ...current,
          origin,
          intent: input.intent,
          doctrine,
          configuration,
          updatedAt: input.now,
        });
      }

      const id = randomUUID();
      const document: WorkSessionDocument = {
        schemaVersion: WORK_SESSION_SCHEMA_VERSION,
        id,
        origin: {
          kind: "tracker",
          trackerKind: input.trackerKind,
          repositoryIdentity: input.repositoryIdentity,
          issueId: input.issueId,
          issueIdentifier: input.issueIdentifier,
          issueUrl: input.issueUrl,
        },
        repositoryIdentity: input.repositoryIdentity,
        intent: input.intent,
        status: "active",
        doctrine: input.doctrine,
        configuration: input.configuration,
        controller: {
          kind: "tracker",
          controllerId: input.controllerId,
          generation: 1,
          assignedAt: input.now,
        },
        decisions: [],
        plan: null,
        humanAttachment: null,
        attempts: [],
        retry: null,
        materializations: [],
        proof: [],
        deliveryHistory: [],
        delivery: null,
        createdAt: input.now,
        updatedAt: input.now,
      };
      this.#insert(document, originKey);
      return snapshot(document, 1);
    });
  }

  createInteractiveSession(
    input: StartInteractiveSessionInput,
  ): WorkSessionSnapshot {
    return this.#transaction(() => {
      const id = randomUUID();
      const document: WorkSessionDocument = {
        schemaVersion: WORK_SESSION_SCHEMA_VERSION,
        id,
        origin: {
          kind: "interactive",
          repositoryIdentity: input.repositoryIdentity,
          initiatingActor: input.initiatingActor,
        },
        repositoryIdentity: input.repositoryIdentity,
        intent: input.intent,
        status: "active",
        doctrine: input.doctrine,
        configuration: input.configuration,
        controller: {
          kind: "human",
          controllerId: input.controllerId,
          generation: 1,
          assignedAt: input.now,
        },
        decisions: [],
        plan: null,
        humanAttachment: null,
        attempts: [],
        retry: null,
        materializations: [],
        proof: [],
        deliveryHistory: [],
        delivery: null,
        createdAt: input.now,
        updatedAt: input.now,
      };
      this.#insert(document, JSON.stringify(["interactive", id]));
      return snapshot(document, 1);
    });
  }

  getSession(sessionId: string): WorkSessionSnapshot | null {
    const row = this.#rowById(sessionId);
    if (row === null) return null;
    return snapshot(this.#decode(row), row.revision);
  }

  getTrackerSession(
    trackerKind: string,
    repositoryIdentity: string,
    issueId: string,
  ): WorkSessionSnapshot | null {
    const row = this.#rowByOriginKey(
      trackerOriginKey(trackerKind, repositoryIdentity, issueId),
    );
    if (row === null) return null;
    return snapshot(this.#decode(row), row.revision);
  }

  listActiveSessions(): readonly WorkSessionSnapshot[] {
    const rows = this.#database
      .prepare(
        "SELECT * FROM work_sessions WHERE status = 'active' ORDER BY created_at, id",
      )
      .all() as SessionRow[];
    return rows.map((row) => snapshot(this.#decode(row), row.revision));
  }

  replacePlan(input: ReplacePlanInput): WorkSessionSnapshot {
    timestamp(input.now, "plan replacement time");
    if (input.summary.trim() === "") {
      throw new TypeError("plan summary must not be blank");
    }
    if (input.acceptanceCriteria.some((entry) => entry.trim() === "")) {
      throw new TypeError("plan acceptance criteria must not be blank");
    }
    return this.#transaction(() => {
      const row = this.#requireRow(input.sessionId);
      assertExpectedRevision(
        row,
        input.expectedRevision,
        "replace the plan for",
      );
      const document = this.#decode(row);
      assertControllerGeneration(
        document,
        input.controllerGeneration,
        "replace the plan for",
      );
      if (input.recordedBy !== document.controller.controllerId) {
        throw new StateStoreError(
          "controller_conflict",
          `Actor ${input.recordedBy} is not the controller of WorkSession ${document.id}`,
        );
      }
      const contents = {
        summary: input.summary,
        acceptanceCriteria: [...input.acceptanceCriteria],
        recordedBy: input.recordedBy,
      };
      if (
        document.plan !== null &&
        sameJson(
          {
            summary: document.plan.summary,
            acceptanceCriteria: document.plan.acceptanceCriteria,
            recordedBy: document.plan.recordedBy,
          },
          contents,
        )
      ) {
        return snapshot(document, row.revision);
      }
      return this.#write(row, {
        ...document,
        plan: {
          version: (document.plan?.version ?? 0) + 1,
          ...contents,
          recordedAt: input.now,
        },
        updatedAt: input.now,
      });
    });
  }

  appendDecision(input: AppendDecisionInput): WorkSessionSnapshot {
    timestamp(input.now, "decision time");
    if (input.text.trim() === "") {
      throw new TypeError("decision text must not be blank");
    }
    return this.#transaction(() => {
      const row = this.#requireRow(input.sessionId);
      assertExpectedRevision(
        row,
        input.expectedRevision,
        "append a decision to",
      );
      const document = this.#decode(row);
      assertControllerGeneration(
        document,
        input.controllerGeneration,
        "append a decision to",
      );
      if (input.kind === "exception") {
        if (!/^GP-\d{2}$/u.test(input.principleId ?? "")) {
          throw new TypeError("an exception must identify one GP-xx principle");
        }
        if (document.doctrine === null) {
          throw new StateStoreError(
            "controller_conflict",
            `WorkSession ${document.id} cannot accept a doctrine exception before doctrine is pinned`,
          );
        }
      } else if (input.principleId !== null) {
        throw new TypeError(
          "principleId may be present only for an exception decision",
        );
      }
      if (
        input.kind !== "exception" &&
        input.acceptedBy !== document.controller.controllerId
      ) {
        throw new StateStoreError(
          "controller_conflict",
          `Actor ${input.acceptedBy} is not the controller of WorkSession ${document.id}`,
        );
      }
      return this.#write(row, {
        ...document,
        decisions: [
          ...document.decisions,
          {
            id: randomUUID(),
            kind: input.kind,
            text: input.text,
            acceptedBy: input.acceptedBy,
            principleId: input.principleId,
            doctrine: input.kind === "exception" ? document.doctrine : null,
            recordedAt: input.now,
          },
        ],
        updatedAt: input.now,
      });
    });
  }

  attachHumanWorkspace(input: AttachHumanWorkspaceInput): WorkSessionSnapshot {
    timestamp(input.now, "human workspace attachment time");
    timestamp(input.inspection.observedAt, "human workspace observation time");
    if (!path.isAbsolute(input.path)) {
      throw new TypeError("human workspace path must be absolute");
    }
    const attachmentPath = path.resolve(input.path);
    return this.#transaction(() => {
      const row = this.#requireRow(input.sessionId);
      assertExpectedRevision(
        row,
        input.expectedRevision,
        "attach a workspace to",
      );
      const document = this.#decode(row);
      if (
        document.status !== "active" ||
        document.controller.kind !== "human" ||
        document.controller.controllerId !== input.controllerId
      ) {
        throw new StateStoreError(
          "controller_conflict",
          `Actor ${input.controllerId} is not the active human controller of WorkSession ${document.id}`,
        );
      }
      if (
        input.repositoryIdentity !== document.repositoryIdentity ||
        document.configuration?.productProfile.repositoryIdentity !==
          document.repositoryIdentity
      ) {
        throw new StateStoreError(
          "repository_mismatch",
          `Checkout repository ${input.repositoryIdentity} does not match WorkSession ${document.repositoryIdentity}`,
        );
      }
      noActiveLease(document, "attach a human workspace to");
      if (liveWorkspacePaths(document).length !== 0) {
        throw new StateStoreError(
          "workspace_conflict",
          `WorkSession ${document.id} already has a live Attempt workspace lease`,
        );
      }
      if (document.humanAttachment !== null) {
        throw new StateStoreError(
          "workspace_conflict",
          `WorkSession ${document.id} already has a human workspace attachment`,
        );
      }

      this.#assertWorkspacePathAvailable(document.id, attachmentPath);

      return this.#write(row, {
        ...document,
        humanAttachment: {
          kind: "human-attachment",
          id: randomUUID(),
          ownership: "human",
          path: attachmentPath,
          repositoryIdentity: input.repositoryIdentity,
          inspection: { ...input.inspection },
          removalPolicy: "never",
          attachedBy: input.controllerId,
          attachedAt: input.now,
        },
        updatedAt: input.now,
      });
    });
  }

  listExpiredRuntimeLeases(
    now: string,
  ): readonly ExpiredRuntimeLeaseCandidate[] {
    const nowMs = timestamp(now, "lease reconciliation time");
    const expired: ExpiredRuntimeLeaseCandidate[] = [];
    for (const candidate of this.listActiveSessions()) {
      const attempt = activeAttempt(candidate);
      if (
        attempt === null ||
        timestamp(attempt.runtimeLease.expiresAt, "runtime lease expiry") >
          nowMs
      ) {
        continue;
      }
      expired.push({
        sessionId: candidate.id,
        attemptId: attempt.id,
        runtimeLeaseToken: attempt.runtimeLease.token,
        controllerGeneration: candidate.controller.generation,
        expiresAt: attempt.runtimeLease.expiresAt,
      });
    }
    return expired;
  }

  expireRuntimeLease(input: ExpireRuntimeLeaseInput): WorkSessionSnapshot {
    const nowMs = timestamp(input.now, "lease reconciliation time");
    return this.#mutate(input.sessionId, (document) => {
      if (document.controller.generation !== input.controllerGeneration) {
        throw new StateStoreError(
          "stale_fence",
          `Cannot expire runtime lease with stale controller generation ${input.controllerGeneration}`,
        );
      }
      const index = document.attempts.findIndex(
        (entry) => entry.id === input.attemptId,
      );
      const current = document.attempts[index];
      if (
        current === undefined ||
        current.runtimeLease.token !== input.runtimeLeaseToken
      ) {
        throw new StateStoreError(
          "stale_fence",
          `Runtime lease ${input.runtimeLeaseToken} is no longer authoritative`,
        );
      }
      if (current.runtimeLease.status === "expired") return document;
      if (current.runtimeLease.status !== "active") {
        throw new StateStoreError(
          "stale_fence",
          `Runtime lease ${input.runtimeLeaseToken} is ${current.runtimeLease.status}`,
        );
      }
      if (
        timestamp(current.runtimeLease.expiresAt, "runtime lease expiry") >
        nowMs
      ) {
        throw new StateStoreError(
          "stale_fence",
          `Runtime lease ${input.runtimeLeaseToken} has not expired`,
        );
      }
      return replaceAttempt(
        document,
        index,
        {
          ...interruptRunningPreparation(
            current,
            input.now,
            "runtime lease expired during preparation",
          ),
          status: "interrupted",
          finishedAt: input.now,
          error: "runtime lease expired before completion",
          runtimeLease: {
            ...current.runtimeLease,
            status: "expired",
            releasedAt: input.now,
          },
        },
        input.now,
      );
    });
  }

  startAttempt(input: StartAttemptInput): StartedAttempt {
    return this.#transaction(() => {
      const row = this.#requireRow(input.sessionId);
      let document = this.#decode(row);
      const nowMs = timestamp(input.now, "attempt start time");
      if (timestamp(input.leaseExpiresAt, "runtime lease expiry") <= nowMs) {
        throw new TypeError("leaseExpiresAt must be after now");
      }
      if (document.status !== "active") {
        throw new StateStoreError(
          "stale_fence",
          `WorkSession ${document.id} is ${document.status}`,
        );
      }
      assertControllerGeneration(
        document,
        input.controllerGeneration,
        "start an attempt for",
      );
      if (
        document.configuration !== null &&
        (document.doctrine === null ||
          document.configuration.governanceManifest === null ||
          document.configuration.trackerPolicy === null)
      ) {
        throw new StateStoreError(
          "input_conflict",
          `WorkSession ${document.id} cannot start a managed Attempt without pinned accepted governance`,
        );
      }
      if (document.humanAttachment !== null) {
        throw new StateStoreError(
          "workspace_conflict",
          `WorkSession ${document.id} has a human-owned attachment and cannot start an Attempt`,
        );
      }
      if (
        document.retry !== null &&
        timestamp(document.retry.dueAt, "retry due time") > nowMs
      ) {
        throw new StateStoreError(
          "retry_not_due",
          `WorkSession ${document.id} retry is not due until ${document.retry.dueAt}`,
        );
      }

      const existing = activeAttempt(document);
      if (existing !== null) {
        throw new StateStoreError(
          "active_runtime_lease",
          `WorkSession ${document.id} is already executing attempt ${existing.id}`,
        );
      }

      const attemptId = randomUUID();
      const runtimeLeaseToken = randomUUID();
      const ordinal =
        document.attempts.reduce(
          (maximum, attempt) => Math.max(maximum, attempt.ordinal),
          0,
        ) + 1;
      const runtimeLease: RuntimeLease = {
        token: runtimeLeaseToken,
        holderId: input.holderId,
        controllerGeneration: document.controller.generation,
        status: "active",
        acquiredAt: input.now,
        renewedAt: input.now,
        expiresAt: input.leaseExpiresAt,
        releasedAt: null,
      };
      const attempt: AttemptRecord = {
        id: attemptId,
        ordinal,
        trackerAttempt: input.trackerAttempt,
        freshAttemptGeneration: input.freshAttemptGeneration,
        status: "running",
        startedAt: input.now,
        finishedAt: null,
        error: null,
        runtimeLease,
        workspaceLease: null,
        preparation: null,
        runtimeCorrelation: { processId: null, sessionId: null },
      };
      const updated: WorkSessionDocument = {
        ...document,
        attempts: [...document.attempts, attempt],
        retry: null,
        updatedAt: input.now,
      };
      const session = this.#write(row, updated);
      return {
        session,
        attemptId,
        runtimeLeaseToken,
        controllerGeneration: document.controller.generation,
      };
    });
  }

  renewRuntimeLease(input: RenewRuntimeLeaseInput): WorkSessionSnapshot {
    return this.#mutate(input.sessionId, (document) => {
      const { attempt, index } = assertActiveLease(document, input);
      if (
        timestamp(input.leaseExpiresAt, "renewed runtime lease expiry") <=
        timestamp(input.now, "runtime lease renewal time")
      ) {
        throw new TypeError("leaseExpiresAt must be after now");
      }
      return replaceAttempt(
        document,
        index,
        {
          ...attempt,
          runtimeLease: {
            ...attempt.runtimeLease,
            renewedAt: input.now,
            expiresAt: input.leaseExpiresAt,
          },
        },
        input.now,
      );
    });
  }

  recordWorkspace(input: RecordWorkspaceInput): WorkSessionSnapshot {
    if (!path.isAbsolute(input.path)) {
      throw new TypeError("workspace path must be absolute");
    }
    return this.#mutate(input.sessionId, (document) => {
      const { attempt, index } = assertActiveLease(document, input);
      this.#assertWorkspacePathAvailable(document.id, input.path);
      const workspaceLease: WorkspaceLease = {
        mode: input.mode,
        path: input.path,
        workspaceKey: input.workspaceKey,
        removalPolicy: "guarded",
        recordedAt: input.now,
      };
      if (
        attempt.workspaceLease !== null &&
        (attempt.workspaceLease.mode !== workspaceLease.mode ||
          attempt.workspaceLease.path !== workspaceLease.path ||
          attempt.workspaceLease.workspaceKey !== workspaceLease.workspaceKey ||
          attempt.workspaceLease.removalPolicy !== workspaceLease.removalPolicy)
      ) {
        throw new StateStoreError(
          "stale_fence",
          `Attempt ${attempt.id} already owns a different workspace lease`,
        );
      }
      if (attempt.workspaceLease !== null) return document;
      return replaceAttempt(
        document,
        index,
        { ...attempt, workspaceLease },
        input.now,
      );
    });
  }

  beginManagedWorkspace(
    input: BeginManagedWorkspaceInput,
  ): BegunManagedWorkspace {
    timestamp(input.now, "managed workspace allocation time");
    if (!path.isAbsolute(input.path)) {
      throw new TypeError("managed workspace path must be absolute");
    }
    return this.#transaction(() => {
      const row = this.#requireRow(input.sessionId);
      const document = this.#decode(row);
      const { attempt, index } = assertActiveLease(document, input);
      this.#assertWorkspacePathAvailable(document.id, input.path);
      this.#assertManagedBranchAvailable(
        document.id,
        input.repositoryIdentity,
        input.branch,
      );
      const existing = attempt.workspaceLease;
      const identity = {
        path: input.path,
        workspaceKey: input.workspaceKey,
        repositoryIdentity: input.repositoryIdentity,
        profileDigest: input.profileDigest,
        sourceRoot: input.sourceRoot,
        workspaceRoot: input.workspaceRoot,
        baseRef: input.baseRef,
        baseSha: input.baseSha,
        branch: input.branch,
        freshAttemptGeneration: input.freshAttemptGeneration,
      };
      const sessionPin = {
        path: input.path,
        workspaceKey: input.workspaceKey,
        repositoryIdentity: input.repositoryIdentity,
        profileDigest: input.profileDigest,
        sourceRoot: input.sourceRoot,
        workspaceRoot: input.workspaceRoot,
        baseRef: input.baseRef,
        baseSha: input.baseSha,
      };
      for (const priorAttempt of document.attempts) {
        const priorLease = priorAttempt.workspaceLease;
        if (priorLease?.mode !== "managed") continue;
        const priorPin = {
          path: priorLease.path,
          workspaceKey: priorLease.workspaceKey,
          repositoryIdentity: priorLease.repositoryIdentity,
          profileDigest: priorLease.profileDigest,
          sourceRoot: priorLease.sourceRoot,
          workspaceRoot: priorLease.workspaceRoot,
          baseRef: priorLease.baseRef,
          baseSha: priorLease.baseSha,
        };
        if (!sameJson(priorPin, sessionPin)) {
          throw new StateStoreError(
            "stale_fence",
            `WorkSession ${document.id} is already pinned to a different managed repository base`,
          );
        }
      }
      const matchesIdentity = (lease: ManagedWorkspaceLease): boolean =>
        sameJson(
          {
            path: lease.path,
            workspaceKey: lease.workspaceKey,
            repositoryIdentity: lease.repositoryIdentity,
            profileDigest: lease.profileDigest,
            sourceRoot: lease.sourceRoot,
            workspaceRoot: lease.workspaceRoot,
            baseRef: lease.baseRef,
            baseSha: lease.baseSha,
            branch: lease.branch,
            freshAttemptGeneration: lease.freshAttemptGeneration,
          },
          identity,
        );
      if (existing !== null) {
        if (existing.mode !== "managed" || !matchesIdentity(existing)) {
          throw new StateStoreError(
            "stale_fence",
            `Attempt ${attempt.id} already owns a different workspace lease`,
          );
        }
        return {
          session: snapshot(document, row.revision),
          workspaceLeaseToken: existing.leaseToken,
        };
      }

      const workspaceLeaseToken = randomUUID();
      const priorIndex = document.attempts.findIndex(
        (candidate, candidateIndex) => {
          const lease = candidate.workspaceLease;
          return (
            candidateIndex !== index &&
            lease?.mode === "managed" &&
            lease.phase !== "removed" &&
            lease.phase !== "superseded" &&
            matchesIdentity(lease)
          );
        },
      );
      let transferred = document;
      if (priorIndex !== -1) {
        const priorAttempt = document.attempts[priorIndex];
        const priorLease = priorAttempt?.workspaceLease;
        if (priorAttempt === undefined || priorLease?.mode !== "managed") {
          throw new StateStoreError(
            "state_corrupt",
            `Managed workspace transfer source ${priorIndex} is invalid`,
          );
        }
        transferred = replaceAttempt(
          document,
          priorIndex,
          {
            ...priorAttempt,
            workspaceLease: {
              ...priorLease,
              phase: "superseded",
              lastError: null,
              removedAt: null,
            },
          },
          input.now,
        );
      }
      const updated = replaceAttempt(
        transferred,
        index,
        {
          ...attempt,
          workspaceLease: {
            mode: "managed",
            removalPolicy: "guarded",
            leaseToken: workspaceLeaseToken,
            controllerGeneration: input.controllerGeneration,
            driver: "git-worktree",
            driverVersion: 1,
            phase: "allocating",
            ...identity,
            lastError: null,
            removedAt: null,
            recordedAt: input.now,
          },
        },
        input.now,
      );
      return {
        session: this.#write(row, updated),
        workspaceLeaseToken,
      };
    });
  }

  transitionManagedWorkspace(
    input: TransitionManagedWorkspaceInput,
  ): WorkSessionSnapshot {
    timestamp(input.now, "managed workspace transition time");
    return this.#transaction(() => {
      const row = this.#requireRow(input.sessionId);
      const document = this.#decode(row);
      if (
        document.status !== "active" ||
        document.controller.generation !== input.controllerGeneration
      ) {
        throw new StateStoreError(
          "stale_fence",
          `WorkSession ${document.id} controller generation is no longer active`,
        );
      }
      if (input.runtimeLeaseToken === null) {
        noActiveLease(document, "transition a managed workspace for");
      } else {
        assertActiveLease(document, {
          attemptId: input.runtimeAttemptId ?? input.attemptId,
          runtimeLeaseToken: input.runtimeLeaseToken,
          controllerGeneration: input.controllerGeneration,
          now: input.now,
        });
      }

      const index = document.attempts.findIndex(
        (attempt) => attempt.id === input.attemptId,
      );
      const attempt = document.attempts[index];
      const lease = attempt?.workspaceLease;
      if (
        attempt === undefined ||
        lease === null ||
        lease === undefined ||
        lease.mode !== "managed" ||
        lease.leaseToken !== input.workspaceLeaseToken ||
        lease.controllerGeneration !== input.controllerGeneration
      ) {
        throw new StateStoreError(
          "stale_fence",
          `Managed workspace lease for attempt ${input.attemptId} is no longer current`,
        );
      }
      if (!input.expectedPhases.includes(lease.phase)) {
        if (lease.phase === input.phase && lease.lastError === input.error) {
          return snapshot(document, row.revision);
        }
        throw new StateStoreError(
          "stale_fence",
          `Managed workspace is ${lease.phase}; expected ${input.expectedPhases.join(" or ")}`,
        );
      }
      if (!managedTransitionAllowed(lease.phase, input.phase)) {
        throw new StateStoreError(
          "stale_fence",
          `Managed workspace cannot transition from ${lease.phase} to ${input.phase}`,
        );
      }
      if (lease.phase === input.phase && lease.lastError === input.error) {
        return snapshot(document, row.revision);
      }

      const updated = replaceAttempt(
        document,
        index,
        {
          ...attempt,
          workspaceLease: {
            ...lease,
            phase: input.phase,
            lastError: input.error,
            removedAt: input.phase === "removed" ? input.now : null,
          },
        },
        input.now,
      );
      return this.#write(row, updated);
    });
  }

  recordRuntimeCorrelation(
    input: RuntimeCorrelationInput,
  ): WorkSessionSnapshot {
    return this.#mutate(input.sessionId, (document) => {
      const { attempt, index } = assertActiveLease(document, input);
      return replaceAttempt(
        document,
        index,
        {
          ...attempt,
          runtimeCorrelation: {
            processId: input.processId ?? attempt.runtimeCorrelation.processId,
            sessionId:
              input.sessionIdValue ?? attempt.runtimeCorrelation.sessionId,
          },
        },
        input.now,
      );
    });
  }

  startPreparation(input: StartPreparationInput): WorkSessionSnapshot {
    timestamp(input.now, "preparation start time");
    if (input.command.length === 0) {
      throw new TypeError("preparation command must not be empty");
    }
    return this.#mutate(input.sessionId, (document) => {
      const { attempt, index } = assertActiveLease(document, input);
      if (attempt.workspaceLease === null) {
        throw new StateStoreError(
          "stale_fence",
          `Attempt ${attempt.id} has no durable workspace lease`,
        );
      }
      if (
        attempt.workspaceLease.mode === "managed" &&
        attempt.workspaceLease.phase !== "ready"
      ) {
        throw new StateStoreError(
          "stale_fence",
          `Managed workspace for attempt ${attempt.id} is not ready`,
        );
      }
      const plan = {
        command: [...input.command],
        manifestDigest: input.manifestDigest,
        lockfileDigest: input.lockfileDigest,
        inputDigest: input.inputDigest,
        dependencyPolicy: input.dependencyPolicy,
        cachePath: input.cachePath,
      };
      if (attempt.preparation !== null) {
        if (
          !sameJson(
            {
              command: attempt.preparation.command,
              manifestDigest: attempt.preparation.manifestDigest,
              lockfileDigest: attempt.preparation.lockfileDigest,
              inputDigest: attempt.preparation.inputDigest,
              dependencyPolicy: attempt.preparation.dependencyPolicy,
              cachePath: attempt.preparation.cachePath,
            },
            plan,
          )
        ) {
          throw new StateStoreError(
            "stale_fence",
            `Attempt ${attempt.id} is already bound to a different preparation plan`,
          );
        }
        if (
          attempt.preparation.status === "running" ||
          attempt.preparation.status === "succeeded"
        ) {
          return document;
        }
        throw new StateStoreError(
          "stale_fence",
          `Attempt ${attempt.id} preparation is already ${attempt.preparation.status}`,
        );
      }
      return replaceAttempt(
        document,
        index,
        {
          ...attempt,
          preparation: {
            driver: "pnpm",
            driverVersion: 2,
            status: "running",
            ...plan,
            lifecycleScripts: false,
            startedAt: input.now,
            finishedAt: null,
            error: null,
          },
        },
        input.now,
      );
    });
  }

  finishPreparation(input: FinishPreparationInput): WorkSessionSnapshot {
    timestamp(input.now, "preparation finish time");
    return this.#mutate(input.sessionId, (document) => {
      const { attempt, index } = assertActiveLease(document, input);
      const preparation = attempt.preparation;
      if (preparation === null) {
        throw new StateStoreError(
          "state_not_found",
          `Attempt ${attempt.id} has no preparation record`,
        );
      }
      if (preparation.status !== "running") {
        if (
          preparation.status === input.status &&
          preparation.error === input.error
        ) {
          return document;
        }
        throw new StateStoreError(
          "stale_fence",
          `Attempt ${attempt.id} preparation is already ${preparation.status}`,
        );
      }
      return replaceAttempt(
        document,
        index,
        {
          ...attempt,
          preparation: {
            ...preparation,
            status: input.status,
            finishedAt: input.now,
            error: input.error,
          },
        },
        input.now,
      );
    });
  }

  finishAttempt(input: FinishAttemptInput): WorkSessionSnapshot {
    return this.#mutate(input.sessionId, (document) => {
      const { attempt, index } = assertActiveLease(document, input);
      const finishedAttempt = interruptRunningPreparation(
        attempt,
        input.now,
        "attempt finished before preparation completed",
      );
      return replaceAttempt(
        document,
        index,
        {
          ...finishedAttempt,
          status: input.status,
          finishedAt: input.now,
          error: input.error,
          runtimeLease: {
            ...finishedAttempt.runtimeLease,
            status: "released",
            releasedAt: input.now,
          },
        },
        input.now,
      );
    });
  }

  beginMaterialization(input: BeginMaterializationInput): BegunMaterialization {
    timestamp(input.now, "materialization start time");
    return this.#transaction(() => {
      const row = this.#requireRow(input.sessionId);
      const document = this.#decode(row);
      assertControllerGeneration(
        document,
        input.controllerGeneration,
        "begin materialization for",
      );
      noActiveLease(document, "begin materialization for");
      if (document.configuration?.deliveryGrant == null) {
        throw new StateStoreError(
          "controller_conflict",
          `WorkSession ${document.id} has no accepted product-owner delivery grant`,
        );
      }
      if (
        document.delivery !== null &&
        document.delivery.phase !== "completed" &&
        !(
          document.delivery.phase === "refused" &&
          (document.delivery.cleanupStatus === "completed" ||
            document.delivery.cleanupStatus === "retained")
        )
      ) {
        throw new StateStoreError(
          "stale_fence",
          `WorkSession ${document.id} already has unresolved delivery state`,
        );
      }
      const attempt = document.attempts.find(
        (candidate) => candidate.id === input.attemptId,
      );
      const lease = attempt?.workspaceLease;
      if (
        attempt === undefined ||
        lease?.mode !== "managed" ||
        lease.leaseToken !== input.workspaceLeaseToken ||
        lease.controllerGeneration !== input.controllerGeneration ||
        lease.phase !== "ready" ||
        attempt.runtimeLease.status === "active"
      ) {
        throw new StateStoreError(
          "stale_fence",
          `Attempt ${input.attemptId} does not hold a quiescent ready managed-workspace lease`,
        );
      }
      if (attempt.status !== "completed" && attempt.status !== "released") {
        throw new StateStoreError(
          "stale_fence",
          `Attempt ${attempt.id} ended as ${attempt.status}; its bytes are not deliverable`,
        );
      }
      if (
        lease.branch !== input.branch ||
        lease.baseSha !== input.parentSha ||
        input.parentSha !== input.expectedOldSha
      ) {
        throw new StateStoreError(
          "input_conflict",
          `Materialization facts do not match managed lease ${lease.leaseToken}`,
        );
      }
      const existing = document.materializations.find(
        (candidate) =>
          candidate.attemptId === input.attemptId &&
          candidate.workspaceLeaseToken === input.workspaceLeaseToken &&
          candidate.phase !== "refused",
      );
      const immutableInput = {
        attemptId: input.attemptId,
        workspaceLeaseToken: input.workspaceLeaseToken,
        controllerGeneration: input.controllerGeneration,
        parentSha: input.parentSha,
        branch: input.branch,
        expectedOldSha: input.expectedOldSha,
        inclusionPolicyDigest: input.inclusionPolicyDigest,
      };
      if (existing !== undefined) {
        if (
          !sameJson(
            {
              attemptId: existing.attemptId,
              workspaceLeaseToken: existing.workspaceLeaseToken,
              controllerGeneration: existing.controllerGeneration,
              parentSha: existing.parentSha,
              branch: existing.branch,
              expectedOldSha: existing.expectedOldSha,
              inclusionPolicyDigest: existing.inclusionPolicyDigest,
            },
            immutableInput,
          )
        ) {
          throw new StateStoreError(
            "input_conflict",
            `Attempt ${attempt.id} already has a different materialization intent`,
          );
        }
        return {
          session: snapshot(document, row.revision),
          materializationId: existing.id,
        };
      }
      const materializationId = randomUUID();
      const updated: WorkSessionDocument = {
        ...document,
        materializations: [
          ...document.materializations,
          {
            id: materializationId,
            ...immutableInput,
            phase: "intent_recorded",
            inputManifestDigest: null,
            inputManifest: null,
            treeSha: null,
            commitSha: null,
            lastError: null,
            startedAt: input.now,
            updatedAt: input.now,
          },
        ],
        updatedAt: input.now,
      };
      return {
        session: this.#write(row, updated),
        materializationId,
      };
    });
  }

  transitionMaterialization(
    input: TransitionMaterializationInput,
  ): WorkSessionSnapshot {
    timestamp(input.now, "materialization transition time");
    return this.#mutate(input.sessionId, (document) => {
      assertControllerGeneration(
        document,
        input.controllerGeneration,
        "transition materialization for",
      );
      noActiveLease(document, "transition materialization for");
      const index = document.materializations.findIndex(
        (candidate) => candidate.id === input.materializationId,
      );
      const current = document.materializations[index];
      if (current === undefined) {
        throw new StateStoreError(
          "state_not_found",
          `Materialization ${input.materializationId} does not exist`,
        );
      }
      if (current.controllerGeneration !== input.controllerGeneration) {
        throw new StateStoreError(
          "stale_fence",
          `Materialization ${current.id} belongs to controller generation ${current.controllerGeneration}`,
        );
      }
      if (!input.expectedPhases.includes(current.phase)) {
        if (current.phase === input.phase) return document;
        throw new StateStoreError(
          "stale_fence",
          `Materialization ${current.id} is ${current.phase}, not one of ${input.expectedPhases.join(", ")}`,
        );
      }
      if (!materializationTransitionAllowed(current.phase, input.phase)) {
        throw new StateStoreError(
          "stale_fence",
          `Materialization cannot transition from ${current.phase} to ${input.phase}`,
        );
      }
      const next = {
        ...current,
        phase: input.phase,
        ...(input.phase === "snapshot_recorded"
          ? {
              inputManifestDigest: input.inputManifestDigest,
              inputManifest: [...input.inputManifest],
            }
          : {}),
        ...(input.phase === "tree_written" ? { treeSha: input.treeSha } : {}),
        ...(input.phase === "commit_written"
          ? { commitSha: input.commitSha }
          : {}),
        lastError: input.phase === "refused" ? input.error : null,
        updatedAt: input.now,
      };
      const materializations = [...document.materializations];
      materializations[index] = next;
      return { ...document, materializations, updatedAt: input.now };
    });
  }

  beginDelivery(input: BeginDeliveryInput): WorkSessionSnapshot {
    timestamp(input.now, "delivery start time");
    return this.#mutate(input.sessionId, (document) => {
      assertControllerGeneration(
        document,
        input.controllerGeneration,
        "begin delivery for",
      );
      noActiveLease(document, "begin delivery for");
      const grant = document.configuration?.deliveryGrant;
      if (grant === null || grant === undefined) {
        throw new StateStoreError(
          "controller_conflict",
          `WorkSession ${document.id} has no accepted product-owner delivery grant`,
        );
      }
      const materialization = document.materializations.find(
        (candidate) => candidate.id === input.materializationId,
      );
      if (
        materialization?.phase !== "branch_updated" ||
        materialization.commitSha === null
      ) {
        throw new StateStoreError(
          "stale_fence",
          `Materialization ${input.materializationId} is not an immutable branch head`,
        );
      }
      let deliveryHistory = document.deliveryHistory;
      if (document.delivery !== null) {
        if (
          document.delivery.materializationId === input.materializationId &&
          document.delivery.expectedRemoteHeadSha ===
            input.expectedRemoteHeadSha
        ) {
          return document;
        }
        if (
          document.delivery.phase !== "completed" &&
          !(
            document.delivery.phase === "refused" &&
            (document.delivery.cleanupStatus === "completed" ||
              document.delivery.cleanupStatus === "retained")
          )
        ) {
          throw new StateStoreError(
            "input_conflict",
            `WorkSession ${document.id} already has a nonterminal delivery intent`,
          );
        }
        deliveryHistory = [...deliveryHistory, document.delivery];
      }
      return {
        ...document,
        deliveryHistory,
        delivery: {
          phase: "intent_recorded",
          materializationId: materialization.id,
          branch: materialization.branch,
          pullRequest: null,
          immutableHeadSha: materialization.commitSha,
          expectedRemoteHeadSha: input.expectedRemoteHeadSha,
          remoteHeadSha: null,
          requiredChecks: grant.requiredChecks.map((name) => ({
            name,
            headSha: materialization.commitSha!,
            checkRunId: null,
            workflowRunId: null,
            status: "pending" as const,
            observedAt: null,
          })),
          mergeSha: null,
          cleanupStatus: "not_started",
          releaseIntentId: null,
          lastError: null,
          startedAt: input.now,
          updatedAt: input.now,
        },
        updatedAt: input.now,
      };
    });
  }

  transitionDelivery(input: TransitionDeliveryInput): WorkSessionSnapshot {
    timestamp(input.now, "delivery transition time");
    return this.#mutate(input.sessionId, (document) => {
      assertControllerGeneration(
        document,
        input.controllerGeneration,
        "transition delivery for",
      );
      noActiveLease(document, "transition delivery for");
      const current = document.delivery;
      if (current === null) {
        throw new StateStoreError(
          "state_not_found",
          `WorkSession ${document.id} has no delivery intent`,
        );
      }
      if (!input.expectedPhases.includes(current.phase)) {
        if (current.phase === input.phase) return document;
        throw new StateStoreError(
          "stale_fence",
          `Delivery is ${current.phase}, not one of ${input.expectedPhases.join(", ")}`,
        );
      }
      if (!deliveryTransitionAllowed(current.phase, input.phase)) {
        throw new StateStoreError(
          "stale_fence",
          `Delivery cannot transition from ${current.phase} to ${input.phase}`,
        );
      }
      if (
        input.phase === "merge_pending" &&
        document.configuration?.deliveryGrant?.authority !== "full-in-scope"
      ) {
        throw new StateStoreError(
          "controller_conflict",
          "Only a pinned full-in-scope product-owner grant may authorize a Symphony merge intent",
        );
      }
      const delivery = {
        ...current,
        phase: input.phase,
        ...(input.pullRequest === undefined
          ? {}
          : { pullRequest: input.pullRequest }),
        ...(input.remoteHeadSha === undefined
          ? {}
          : { remoteHeadSha: input.remoteHeadSha }),
        ...(input.requiredChecks === undefined
          ? {}
          : { requiredChecks: [...input.requiredChecks] }),
        ...(input.mergeSha === undefined ? {} : { mergeSha: input.mergeSha }),
        ...(input.cleanupStatus === undefined
          ? {}
          : { cleanupStatus: input.cleanupStatus }),
        ...(input.releaseIntentId === undefined
          ? {}
          : { releaseIntentId: input.releaseIntentId }),
        lastError: input.phase === "refused" ? (input.error ?? null) : null,
        updatedAt: input.now,
      };
      return { ...document, delivery, updatedAt: input.now };
    });
  }

  recordProof(input: RecordProofInput): WorkSessionSnapshot {
    timestamp(input.now, "proof observation time");
    return this.#mutate(input.sessionId, (document) => {
      assertControllerGeneration(
        document,
        input.controllerGeneration,
        "record proof for",
      );
      const head = document.delivery?.immutableHeadSha;
      const grant = document.configuration?.deliveryGrant;
      if (
        head === null ||
        head === undefined ||
        input.proof.sourceSha !== head ||
        input.proof.checkName === null ||
        grant === null ||
        grant === undefined ||
        !grant.requiredChecks.includes(input.proof.checkName)
      ) {
        throw new StateStoreError(
          "input_conflict",
          "Proof observation is not bound to this delivery head and accepted required-check grant",
        );
      }
      const index = document.proof.findIndex(
        (candidate) => candidate.id === input.proof.id,
      );
      if (index >= 0) {
        const current = document.proof[index]!;
        const immutable = (proof: typeof current) => ({
          id: proof.id,
          checkName: proof.checkName,
          checkRunId: proof.checkRunId,
          workflowRunId: proof.workflowRunId,
          sourceSha: proof.sourceSha,
          planDigest: proof.planDigest,
          adapterDigest: proof.adapterDigest,
          policyDigest: proof.policyDigest,
          recordedAt: proof.recordedAt,
        });
        if (!sameJson(immutable(current), immutable(input.proof))) {
          throw new StateStoreError(
            "input_conflict",
            `Proof ${input.proof.id} already binds different immutable evidence`,
          );
        }
        if (sameJson(current, input.proof)) return document;
        if (current.status !== "pending") {
          throw new StateStoreError(
            "stale_fence",
            `Proof ${input.proof.id} is already terminal`,
          );
        }
        const proof = [...document.proof];
        proof[index] = input.proof;
        return { ...document, proof, updatedAt: input.now };
      }
      return {
        ...document,
        proof: [...document.proof, input.proof],
        updatedAt: input.now,
      };
    });
  }

  scheduleRetry(input: ScheduleRetryInput): WorkSessionSnapshot {
    timestamp(input.retry.dueAt, "retry due time");
    timestamp(input.retry.recordedAt, "retry recorded time");
    return this.#mutate(input.sessionId, (document) => {
      assertControllerGeneration(
        document,
        input.controllerGeneration,
        "schedule a retry for",
      );
      noActiveLease(document, "schedule a retry for");
      return {
        ...document,
        retry: input.retry,
        updatedAt: input.retry.recordedAt,
      };
    });
  }

  clearRetry(
    sessionId: string,
    controllerGeneration: number,
    now: string,
  ): WorkSessionSnapshot {
    timestamp(now, "retry clear time");
    return this.#transaction(() => {
      const row = this.#requireRow(sessionId);
      const document = this.#decode(row);
      if (document.retry === null) return snapshot(document, row.revision);
      assertControllerGeneration(
        document,
        controllerGeneration,
        "clear the retry for",
      );
      return this.#write(row, {
        ...document,
        retry: null,
        updatedAt: now,
      });
    });
  }

  markSessionTerminal(
    sessionId: string,
    controllerGeneration: number,
    status: "cancelled" | "completed",
    now: string,
  ): WorkSessionSnapshot {
    return this.#transaction(() => {
      const row = this.#requireRow(sessionId);
      const document = this.#decode(row);
      if (document.controller.generation !== controllerGeneration) {
        throw new StateStoreError(
          "stale_fence",
          `Cannot complete WorkSession ${document.id} with stale controller generation ${controllerGeneration}`,
        );
      }
      if (document.status === status) return snapshot(document, row.revision);
      if (document.status !== "active") {
        throw new StateStoreError(
          "stale_fence",
          `Cannot change terminal WorkSession ${document.id} from ${document.status} to ${status}`,
        );
      }
      noActiveLease(document, "complete");
      return this.#write(row, {
        ...document,
        status,
        retry: null,
        updatedAt: now,
      });
    });
  }

  enqueueEffect(input: {
    readonly sessionId: string;
    readonly controllerGeneration: number;
    readonly kind: string;
    readonly idempotencyKey: string;
    readonly payload: JsonObject;
    readonly now: string;
  }): EffectIntent {
    return this.#transaction(() => {
      const session = this.#decode(this.#requireRow(input.sessionId));
      if (
        session.status !== "active" ||
        session.controller.generation !== input.controllerGeneration
      ) {
        throw new StateStoreError(
          "stale_fence",
          `Cannot enqueue effect for stale WorkSession generation ${input.controllerGeneration}`,
        );
      }
      const existing = this.#database
        .prepare(
          "SELECT * FROM effect_intents WHERE session_id = ? AND idempotency_key = ?",
        )
        .get(input.sessionId, input.idempotencyKey) as EffectRow | undefined;
      if (existing !== undefined) {
        const effect = effectFromRow(existing);
        if (
          effect.kind !== input.kind ||
          effect.controllerGeneration !== input.controllerGeneration ||
          !sameJson(effect.payload, input.payload)
        ) {
          throw new StateStoreError(
            "effect_conflict",
            `Idempotency key ${input.idempotencyKey} is already bound to a different effect`,
          );
        }
        return effect;
      }
      const id = randomUUID();
      this.#database
        .prepare(
          `INSERT INTO effect_intents (
             id, session_id, kind, idempotency_key, controller_generation,
             status, payload_json, result_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?)`,
        )
        .run(
          id,
          input.sessionId,
          input.kind,
          input.idempotencyKey,
          input.controllerGeneration,
          JSON.stringify(input.payload),
          input.now,
          input.now,
        );
      return {
        id,
        sessionId: input.sessionId,
        kind: input.kind,
        idempotencyKey: input.idempotencyKey,
        controllerGeneration: input.controllerGeneration,
        status: "pending",
        payload: input.payload,
        result: null,
        createdAt: input.now,
        updatedAt: input.now,
      };
    });
  }

  finishEffect(input: {
    readonly effectId: string;
    readonly controllerGeneration: number;
    readonly status: "applied" | "failed";
    readonly result: JsonObject;
    readonly now: string;
  }): EffectIntent {
    return this.#transaction(() => {
      const existing = this.#database
        .prepare("SELECT * FROM effect_intents WHERE id = ?")
        .get(input.effectId) as EffectRow | undefined;
      if (existing === undefined) {
        throw new StateStoreError(
          "state_not_found",
          `Effect ${input.effectId} does not exist`,
        );
      }
      if (existing.controller_generation !== input.controllerGeneration) {
        throw new StateStoreError(
          "stale_fence",
          `Effect ${input.effectId} belongs to controller generation ${existing.controller_generation}`,
        );
      }
      if (existing.status !== "pending") {
        const effect = effectFromRow(existing);
        if (
          effect.status !== input.status ||
          !sameJson(effect.result, input.result)
        ) {
          throw new StateStoreError(
            "effect_conflict",
            `Effect ${input.effectId} already has a different terminal result`,
          );
        }
        return effect;
      }
      const session = this.#decode(this.#requireRow(existing.session_id));
      assertControllerGeneration(
        session,
        input.controllerGeneration,
        `finish effect ${input.effectId} for`,
      );
      this.#database
        .prepare(
          "UPDATE effect_intents SET status = ?, result_json = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
        )
        .run(
          input.status,
          JSON.stringify(input.result),
          input.now,
          input.effectId,
        );
      return effectFromRow({
        ...existing,
        status: input.status,
        result_json: JSON.stringify(input.result),
        updated_at: input.now,
      });
    });
  }

  listPendingEffects(): readonly EffectIntent[] {
    const rows = this.#database
      .prepare(
        "SELECT * FROM effect_intents WHERE status = 'pending' ORDER BY created_at, id",
      )
      .all() as EffectRow[];
    return rows.map(effectFromRow);
  }

  async backup(destinationPath: string): Promise<void> {
    const resolved = path.resolve(destinationPath);
    if (existsSync(resolved)) {
      throw new Error(
        `Refusing to overwrite existing state backup ${resolved}`,
      );
    }
    mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
    await this.#database.backup(resolved);
    chmodSync(resolved, 0o600);
  }

  close(): void {
    if (this.#database.open) this.#database.close();
  }

  #assertWorkspacePathAvailable(
    sessionId: string,
    workspacePath: string,
  ): void {
    const normalized = path.resolve(workspacePath);
    const activeRows = this.#database
      .prepare("SELECT * FROM work_sessions WHERE status = 'active'")
      .all() as SessionRow[];
    for (const candidateRow of activeRows) {
      if (candidateRow.id === sessionId) continue;
      const candidate = this.#decode(candidateRow);
      const claimedPaths = [
        ...(candidate.humanAttachment === null
          ? []
          : [candidate.humanAttachment.path]),
        ...liveWorkspacePaths(candidate),
      ];
      if (
        claimedPaths.some((claimed) =>
          workspacePathsOverlap(claimed, normalized),
        )
      ) {
        throw new StateStoreError(
          "workspace_conflict",
          `Workspace ${normalized} is already claimed by active WorkSession ${candidate.id}`,
        );
      }
    }
  }

  #assertManagedBranchAvailable(
    sessionId: string,
    repositoryIdentity: string,
    branch: string,
  ): void {
    const activeRows = this.#database
      .prepare("SELECT * FROM work_sessions WHERE status = 'active'")
      .all() as SessionRow[];
    for (const candidateRow of activeRows) {
      if (candidateRow.id === sessionId) continue;
      const candidate = this.#decode(candidateRow);
      if (candidate.repositoryIdentity !== repositoryIdentity) continue;
      const conflict = candidate.attempts.some((attempt) => {
        const lease = attempt.workspaceLease;
        return (
          lease?.mode === "managed" &&
          lease.branch === branch &&
          lease.phase !== "removed" &&
          lease.phase !== "superseded"
        );
      });
      if (conflict) {
        throw new StateStoreError(
          "workspace_conflict",
          `Managed branch ${branch} is already claimed by active WorkSession ${candidate.id}`,
        );
      }
    }
  }

  #checkDocuments(): void {
    const sessions = this.#database
      .prepare("SELECT * FROM work_sessions")
      .all() as SessionRow[];
    const generations = new Map<string, number>();
    const activeWorkspaceClaims = new Map<string, string>();
    const activeManagedBranchClaims = new Map<string, string>();
    for (const row of sessions) {
      const document = this.#decode(row);
      generations.set(document.id, document.controller.generation);
      if (document.status === "active") {
        const paths = new Set([
          ...(document.humanAttachment === null
            ? []
            : [document.humanAttachment.path]),
          ...liveWorkspacePaths(document),
        ]);
        for (const claimedPath of paths) {
          const normalized = path.resolve(claimedPath);
          const conflict = [...activeWorkspaceClaims].find(
            ([existingPath, owner]) =>
              owner !== document.id &&
              workspacePathsOverlap(existingPath, normalized),
          );
          if (conflict !== undefined) {
            throw new StateStoreError(
              "state_corrupt",
              `Active WorkSessions ${conflict[1]} and ${document.id} have overlapping workspace claims ${conflict[0]} and ${normalized}`,
            );
          }
          activeWorkspaceClaims.set(normalized, document.id);
        }
        for (const attempt of document.attempts) {
          const lease = attempt.workspaceLease;
          if (
            lease?.mode !== "managed" ||
            lease.phase === "removed" ||
            lease.phase === "superseded"
          ) {
            continue;
          }
          const key = JSON.stringify([
            document.repositoryIdentity,
            lease.branch,
          ]);
          const owner = activeManagedBranchClaims.get(key);
          if (owner !== undefined && owner !== document.id) {
            throw new StateStoreError(
              "state_corrupt",
              `Active WorkSessions ${owner} and ${document.id} both claim managed branch ${lease.branch}`,
            );
          }
          activeManagedBranchClaims.set(key, document.id);
        }
      }
    }
    const effects = this.#database
      .prepare("SELECT * FROM effect_intents")
      .all() as EffectRow[];
    for (const row of effects) {
      const effect = effectFromRow(row);
      const generation = generations.get(effect.sessionId);
      if (
        generation === undefined ||
        effect.controllerGeneration > generation
      ) {
        throw new StateStoreError(
          "state_corrupt",
          `Effect ${effect.id} has no matching WorkSession controller generation`,
        );
      }
    }
  }

  #transaction<T>(operation: () => T): T {
    return this.#database.transaction(operation).immediate();
  }

  #mutate(
    sessionId: string,
    operation: (document: WorkSessionDocument) => WorkSessionDocument,
  ): WorkSessionSnapshot {
    return this.#transaction(() => {
      const row = this.#requireRow(sessionId);
      const document = this.#decode(row);
      const updated = operation(document);
      if (sameJson(document, updated)) return snapshot(document, row.revision);
      return this.#write(row, updated);
    });
  }

  #rowById(sessionId: string): SessionRow | null {
    return (
      (this.#database
        .prepare("SELECT * FROM work_sessions WHERE id = ?")
        .get(sessionId) as SessionRow | undefined) ?? null
    );
  }

  #rowByOriginKey(originKey: string): SessionRow | null {
    return (
      (this.#database
        .prepare("SELECT * FROM work_sessions WHERE origin_key = ?")
        .get(originKey) as SessionRow | undefined) ?? null
    );
  }

  #requireRow(sessionId: string): SessionRow {
    const row = this.#rowById(sessionId);
    if (row === null) {
      throw new StateStoreError(
        "state_not_found",
        `WorkSession ${sessionId} does not exist`,
      );
    }
    return row;
  }

  #decode(row: SessionRow): WorkSessionDocument {
    const document = parseWorkSessionDocument(row.document_json);
    if (document.id !== row.id) {
      throw new StateStoreError(
        "state_corrupt",
        `WorkSession row ${row.id} contains document ${document.id}`,
      );
    }
    if (
      document.origin.kind !== row.origin_kind ||
      document.repositoryIdentity !== row.repository_identity ||
      document.status !== row.status ||
      document.createdAt !== row.created_at ||
      document.updatedAt !== row.updated_at
    ) {
      throw new StateStoreError(
        "state_corrupt",
        `WorkSession row ${row.id} projections do not match its canonical document`,
      );
    }
    return document;
  }

  #insert(document: WorkSessionDocument, originKey: string): void {
    const validated = parseWorkSessionDocument(JSON.stringify(document));
    this.#database
      .prepare(
        `INSERT INTO work_sessions (
           id, origin_kind, origin_key, repository_identity, status, revision,
           document_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        validated.id,
        validated.origin.kind,
        originKey,
        validated.repositoryIdentity,
        validated.status,
        JSON.stringify(validated),
        validated.createdAt,
        validated.updatedAt,
      );
  }

  #write(row: SessionRow, document: WorkSessionDocument): WorkSessionSnapshot {
    const validated = parseWorkSessionDocument(JSON.stringify(document));
    const revision = row.revision + 1;
    const result = this.#database
      .prepare(
        `UPDATE work_sessions
         SET status = ?, revision = ?, document_json = ?, updated_at = ?
         WHERE id = ? AND revision = ?`,
      )
      .run(
        validated.status,
        revision,
        JSON.stringify(validated),
        validated.updatedAt,
        row.id,
        row.revision,
      );
    if (result.changes !== 1) {
      throw new StateStoreError(
        "stale_revision",
        `WorkSession ${row.id} changed during mutation`,
      );
    }
    return snapshot(validated, revision);
  }
}
