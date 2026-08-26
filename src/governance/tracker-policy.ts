import path from "node:path";
import { TextDecoder } from "node:util";

import { SymphonyError } from "../errors.js";
import { isRecord } from "../shared/json.js";
import type { RepositoryContentSnapshot } from "../state/model.js";
import {
  ACCEPTED_GOVERNANCE_SCHEMA_VERSION,
  DELIVERY_OPERATIONS,
  LANE_DELIVERY_OPERATIONS,
  TRACKER_POLICY_SCHEMA_VERSION,
  type AcceptedGovernanceManifestDocument,
  type DeliveryOperation,
  type TrackerActorKind,
  type TrackerLanePolicy,
  type TrackerPolicyDocument,
  type TrackerPolicyRuntimeProjection,
  type TrackerPolicySnapshot,
} from "./model.js";

const MAX_GOVERNANCE_FILE_BYTES = 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });

type GovernanceDocumentKind = "manifest" | "tracker policy";

function invalid(
  kind: GovernanceDocumentKind,
  location: string,
  expectation: string,
): never {
  throw new SymphonyError(
    kind === "manifest"
      ? "governance_manifest_invalid"
      : "tracker_policy_invalid",
    `${location} ${expectation}`,
  );
}

function exactObject(
  value: unknown,
  location: string,
  keys: readonly string[],
  kind: GovernanceDocumentKind,
): Record<string, unknown> {
  if (!isRecord(value)) invalid(kind, location, "must be an object");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const unknown = actual.find((key) => !expected.includes(key));
    const missing = expected.find((key) => !actual.includes(key));
    invalid(
      kind,
      location,
      unknown === undefined
        ? `is missing required key '${missing ?? "unknown"}'`
        : `contains unknown key '${unknown}'`,
    );
  }
  return value;
}

function nonEmptyString(
  value: unknown,
  location: string,
  kind: GovernanceDocumentKind,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    invalid(kind, location, "must be a non-empty string");
  }
  return value;
}

function boolean(
  value: unknown,
  location: string,
  kind: GovernanceDocumentKind,
): boolean {
  if (typeof value !== "boolean") invalid(kind, location, "must be boolean");
  return value;
}

function uniqueStrings<T extends string>(
  value: unknown,
  location: string,
  kind: GovernanceDocumentKind,
  allowed?: readonly T[],
): readonly T[] {
  if (!Array.isArray(value)) invalid(kind, location, "must be an array");
  const result = value.map((entry, index) => {
    const item = nonEmptyString(entry, `${location}[${index}]`, kind);
    if (allowed !== undefined && !allowed.includes(item as T)) {
      invalid(
        kind,
        `${location}[${index}]`,
        `must be one of ${allowed.join(", ")}`,
      );
    }
    return item as T;
  });
  const normalized = result.map((entry) => entry.toLowerCase());
  if (new Set(normalized).size !== normalized.length) {
    invalid(kind, location, "must not contain case-insensitive duplicates");
  }
  return result;
}

function repositoryIdentity(
  value: unknown,
  location: string,
  kind: GovernanceDocumentKind,
): string {
  const identity = nonEmptyString(value, location, kind);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(identity)) {
    invalid(kind, location, "must have the form owner/repository");
  }
  return identity;
}

function gitRevision(
  value: unknown,
  location: string,
  kind: GovernanceDocumentKind,
): string {
  const revision = nonEmptyString(value, location, kind);
  if (!/^[0-9a-f]{40}$/u.test(revision)) {
    invalid(kind, location, "must be a full lowercase Git SHA-1");
  }
  return revision;
}

function digest(
  value: unknown,
  location: string,
  kind: GovernanceDocumentKind,
): string {
  const candidate = nonEmptyString(value, location, kind);
  if (!/^sha256:[0-9a-f]{64}$/u.test(candidate)) {
    invalid(kind, location, "must be a full lowercase SHA-256 digest");
  }
  return candidate;
}

function repositoryPath(
  value: unknown,
  location: string,
  kind: GovernanceDocumentKind,
): string {
  const candidate = nonEmptyString(value, location, kind);
  if (
    candidate.includes("\\") ||
    candidate.includes(":") ||
    /[\0\r\n]/u.test(candidate) ||
    path.posix.isAbsolute(candidate) ||
    path.win32.isAbsolute(candidate) ||
    candidate === "." ||
    path.posix.normalize(candidate) !== candidate ||
    candidate.startsWith("../")
  ) {
    invalid(
      kind,
      location,
      "must be a normalized repository-relative POSIX path",
    );
  }
  return candidate;
}

function json(bytes: Buffer, kind: GovernanceDocumentKind): unknown {
  if (bytes.byteLength > MAX_GOVERNANCE_FILE_BYTES) {
    invalid(kind, kind, `must not exceed ${MAX_GOVERNANCE_FILE_BYTES} bytes`);
  }
  try {
    return JSON.parse(utf8.decode(bytes)) as unknown;
  } catch (error) {
    throw new SymphonyError(
      kind === "manifest"
        ? "governance_manifest_invalid"
        : "tracker_policy_invalid",
      `${kind} must be valid UTF-8 JSON`,
      { cause: error },
    );
  }
}

function manifestArtifact(
  value: unknown,
  location: string,
): AcceptedGovernanceManifestDocument["artifacts"]["doctrine"] {
  const source = exactObject(value, location, ["path", "digest"], "manifest");
  return {
    path: repositoryPath(source["path"], `${location}.path`, "manifest"),
    digest: digest(source["digest"], `${location}.digest`, "manifest"),
  };
}

export function parseAcceptedGovernanceManifest(
  bytes: Buffer,
): AcceptedGovernanceManifestDocument {
  const source = exactObject(
    json(bytes, "manifest"),
    "accepted governance manifest",
    ["schemaVersion", "repositoryIdentity", "acceptedRevision", "artifacts"],
    "manifest",
  );
  if (source["schemaVersion"] !== ACCEPTED_GOVERNANCE_SCHEMA_VERSION) {
    invalid(
      "manifest",
      "accepted governance manifest.schemaVersion",
      `must equal ${ACCEPTED_GOVERNANCE_SCHEMA_VERSION}`,
    );
  }
  const artifacts = exactObject(
    source["artifacts"],
    "accepted governance manifest.artifacts",
    ["doctrine", "trackerPolicy"],
    "manifest",
  );
  const doctrine = manifestArtifact(
    artifacts["doctrine"],
    "accepted governance manifest.artifacts.doctrine",
  );
  const trackerPolicy = manifestArtifact(
    artifacts["trackerPolicy"],
    "accepted governance manifest.artifacts.trackerPolicy",
  );
  if (doctrine.path === trackerPolicy.path) {
    invalid(
      "manifest",
      "accepted governance manifest.artifacts",
      "must name distinct doctrine and tracker-policy paths",
    );
  }
  const identity = repositoryIdentity(
    source["repositoryIdentity"],
    "accepted governance manifest.repositoryIdentity",
    "manifest",
  );
  if (!identity.toLowerCase().endsWith("/.github")) {
    invalid(
      "manifest",
      "accepted governance manifest.repositoryIdentity",
      "must identify an owner or organization .github repository",
    );
  }
  return {
    schemaVersion: ACCEPTED_GOVERNANCE_SCHEMA_VERSION,
    repositoryIdentity: identity,
    acceptedRevision: gitRevision(
      source["acceptedRevision"],
      "accepted governance manifest.acceptedRevision",
      "manifest",
    ),
    artifacts: { doctrine, trackerPolicy },
  };
}

function laneDelivery(
  value: unknown,
  location: string,
): TrackerLanePolicy["delivery"] {
  const source = exactObject(
    value,
    location,
    LANE_DELIVERY_OPERATIONS,
    "tracker policy",
  );
  return Object.fromEntries(
    LANE_DELIVERY_OPERATIONS.map((operation) => [
      operation,
      boolean(source[operation], `${location}.${operation}`, "tracker policy"),
    ]),
  ) as unknown as TrackerLanePolicy["delivery"];
}

function lane(value: unknown, index: number): TrackerLanePolicy {
  const location = `tracker policy.lanes[${index}]`;
  const source = exactObject(
    value,
    location,
    [
      "name",
      "writers",
      "active",
      "terminal",
      "authoring",
      "freshAttempt",
      "delivery",
    ],
    "tracker policy",
  );
  const result: TrackerLanePolicy = {
    name: nonEmptyString(source["name"], `${location}.name`, "tracker policy"),
    writers: uniqueStrings<TrackerActorKind>(
      source["writers"],
      `${location}.writers`,
      "tracker policy",
      ["agent", "human"],
    ),
    active: boolean(source["active"], `${location}.active`, "tracker policy"),
    terminal: boolean(
      source["terminal"],
      `${location}.terminal`,
      "tracker policy",
    ),
    authoring: boolean(
      source["authoring"],
      `${location}.authoring`,
      "tracker policy",
    ),
    freshAttempt: boolean(
      source["freshAttempt"],
      `${location}.freshAttempt`,
      "tracker policy",
    ),
    delivery: laneDelivery(source["delivery"], `${location}.delivery`),
  };
  if (result.writers.length === 0) {
    invalid("tracker policy", `${location}.writers`, "must not be empty");
  }
  if (
    result.terminal &&
    (result.active || result.authoring || result.freshAttempt)
  ) {
    invalid("tracker policy", location, "cannot be terminal and runnable");
  }
  if (result.authoring && !result.active) {
    invalid(
      "tracker policy",
      location,
      "cannot authorize authoring while inactive",
    );
  }
  if (result.freshAttempt && !result.authoring) {
    invalid(
      "tracker policy",
      location,
      "cannot authorize a fresh Attempt without authoring",
    );
  }
  if (result.delivery.mergePullRequest && !result.delivery.observeChecks) {
    invalid(
      "tracker policy",
      `${location}.delivery`,
      "cannot merge without exact-check observation",
    );
  }
  return result;
}

function deliveryProfile(
  value: unknown,
  location: string,
): readonly DeliveryOperation[] {
  return uniqueStrings<DeliveryOperation>(
    value,
    location,
    "tracker policy",
    DELIVERY_OPERATIONS,
  );
}

export function parseTrackerPolicy(
  bytes: Buffer,
  sourceReference: RepositoryContentSnapshot,
): TrackerPolicySnapshot {
  const source = exactObject(
    json(bytes, "tracker policy"),
    "tracker policy",
    [
      "schemaVersion",
      "policyId",
      "drivers",
      "lanes",
      "deliveryProfiles",
      "retry",
    ],
    "tracker policy",
  );
  if (source["schemaVersion"] !== TRACKER_POLICY_SCHEMA_VERSION) {
    invalid(
      "tracker policy",
      "tracker policy.schemaVersion",
      `must equal ${TRACKER_POLICY_SCHEMA_VERSION}`,
    );
  }

  const drivers = exactObject(
    source["drivers"],
    "tracker policy.drivers",
    ["exactlyOneRequired", "changeOnlyInLane", "labels"],
    "tracker policy",
  );
  if (drivers["exactlyOneRequired"] !== true) {
    invalid(
      "tracker policy",
      "tracker policy.drivers.exactlyOneRequired",
      "must equal true",
    );
  }
  if (!Array.isArray(drivers["labels"])) {
    invalid(
      "tracker policy",
      "tracker policy.drivers.labels",
      "must be an array",
    );
  }
  const labels = drivers["labels"].map((entry, index) => {
    const location = `tracker policy.drivers.labels[${index}]`;
    const label = exactObject(
      entry,
      location,
      ["key", "name", "color", "description"],
      "tracker policy",
    );
    const color = nonEmptyString(
      label["color"],
      `${location}.color`,
      "tracker policy",
    );
    if (!/^[0-9A-Fa-f]{6}$/u.test(color)) {
      invalid(
        "tracker policy",
        `${location}.color`,
        "must be a six-digit hex color",
      );
    }
    return {
      key: nonEmptyString(label["key"], `${location}.key`, "tracker policy"),
      name: nonEmptyString(label["name"], `${location}.name`, "tracker policy"),
      color,
      description: nonEmptyString(
        label["description"],
        `${location}.description`,
        "tracker policy",
      ),
    };
  });
  if (labels.length !== 2) {
    invalid(
      "tracker policy",
      "tracker policy.drivers.labels",
      "must contain exactly the direct and symphony selectors",
    );
  }
  for (const field of ["key", "name"] as const) {
    const values = labels.map((entry) => entry[field].toLowerCase());
    if (new Set(values).size !== values.length) {
      invalid(
        "tracker policy",
        "tracker policy.drivers.labels",
        `must have unique ${field} values`,
      );
    }
  }
  if (
    !labels.some((entry) => entry.key.toLowerCase() === "direct") ||
    !labels.some((entry) => entry.key.toLowerCase() === "symphony")
  ) {
    invalid(
      "tracker policy",
      "tracker policy.drivers.labels",
      "must contain driver keys 'direct' and 'symphony'",
    );
  }

  if (!Array.isArray(source["lanes"]) || source["lanes"].length === 0) {
    invalid(
      "tracker policy",
      "tracker policy.lanes",
      "must be a non-empty array",
    );
  }
  const lanes = source["lanes"].map((entry, index) => lane(entry, index));
  const laneNames = lanes.map((entry) => entry.name.toLowerCase());
  if (new Set(laneNames).size !== laneNames.length) {
    invalid(
      "tracker policy",
      "tracker policy.lanes",
      "must not contain case-insensitive duplicate names",
    );
  }
  if (!lanes.some((entry) => entry.freshAttempt)) {
    invalid(
      "tracker policy",
      "tracker policy.lanes",
      "must declare at least one fresh-Attempt lane",
    );
  }
  const namedLane = (name: string): TrackerLanePolicy | undefined =>
    lanes.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
  const backlog = namedLane("Backlog");
  const humanReview = namedLane("Human Review");
  const merging = namedLane("Merging");
  const done = namedLane("Done");
  if (
    backlog === undefined ||
    humanReview === undefined ||
    merging === undefined ||
    done === undefined
  ) {
    invalid(
      "tracker policy",
      "tracker policy.lanes",
      "must declare Backlog, Human Review, Merging, and Done",
    );
  }
  if (!done.terminal || !done.writers.includes("agent")) {
    invalid(
      "tracker policy",
      "tracker policy.lanes.Done",
      "must be terminal and writable by an agent",
    );
  }
  if (
    merging.writers.length !== 1 ||
    merging.writers[0] !== "human" ||
    !merging.active ||
    merging.authoring ||
    !merging.delivery.mergePullRequest
  ) {
    invalid(
      "tracker policy",
      "tracker policy.lanes.Merging",
      "must be human-selected delivery-only merge authority",
    );
  }
  const changeOnlyInLane = nonEmptyString(
    drivers["changeOnlyInLane"],
    "tracker policy.drivers.changeOnlyInLane",
    "tracker policy",
  );
  if (namedLane(changeOnlyInLane) === undefined) {
    invalid(
      "tracker policy",
      "tracker policy.drivers.changeOnlyInLane",
      "must name a declared lane",
    );
  }

  const profiles = exactObject(
    source["deliveryProfiles"],
    "tracker policy.deliveryProfiles",
    ["owner-gated", "full-in-scope"],
    "tracker policy",
  );
  const ownerGated = deliveryProfile(
    profiles["owner-gated"],
    "tracker policy.deliveryProfiles.owner-gated",
  );
  const fullInScope = deliveryProfile(
    profiles["full-in-scope"],
    "tracker policy.deliveryProfiles.full-in-scope",
  );
  if (ownerGated.includes("mergePullRequest")) {
    invalid(
      "tracker policy",
      "tracker policy.deliveryProfiles.owner-gated",
      "must never grant mergePullRequest",
    );
  }
  if (!fullInScope.includes("mergePullRequest")) {
    invalid(
      "tracker policy",
      "tracker policy.deliveryProfiles.full-in-scope",
      "must grant mergePullRequest",
    );
  }
  if (ownerGated.some((operation) => !fullInScope.includes(operation))) {
    invalid(
      "tracker policy",
      "tracker policy.deliveryProfiles",
      "owner-gated operations must be a subset of full-in-scope operations",
    );
  }

  const retry = exactObject(
    source["retry"],
    "tracker policy.retry",
    ["continuation", "failure", "rework", "freshAttemptFailureLane"],
    "tracker policy",
  );
  const continuation = nonEmptyString(
    retry["continuation"],
    "tracker policy.retry.continuation",
    "tracker policy",
  );
  const failure = nonEmptyString(
    retry["failure"],
    "tracker policy.retry.failure",
    "tracker policy",
  );
  const rework = nonEmptyString(
    retry["rework"],
    "tracker policy.retry.rework",
    "tracker policy",
  );
  if (continuation !== "same-work-session-and-workspace") {
    invalid(
      "tracker policy",
      "tracker policy.retry.continuation",
      "has unsupported semantics",
    );
  }
  if (failure !== "same-work-session-with-bounded-backoff") {
    invalid(
      "tracker policy",
      "tracker policy.retry.failure",
      "has unsupported semantics",
    );
  }
  if (rework !== "fresh-attempt-discarding-prior-workspace-and-workpad") {
    invalid(
      "tracker policy",
      "tracker policy.retry.rework",
      "has unsupported semantics",
    );
  }
  const freshAttemptFailureLane = nonEmptyString(
    retry["freshAttemptFailureLane"],
    "tracker policy.retry.freshAttemptFailureLane",
    "tracker policy",
  );
  const failureLane = namedLane(freshAttemptFailureLane);
  if (
    failureLane === undefined ||
    !failureLane.writers.includes("agent") ||
    failureLane.authoring ||
    failureLane.terminal
  ) {
    invalid(
      "tracker policy",
      "tracker policy.retry.freshAttemptFailureLane",
      "must name a non-authoring, non-terminal lane writable by an agent",
    );
  }

  const document: TrackerPolicyDocument = {
    schemaVersion: TRACKER_POLICY_SCHEMA_VERSION,
    policyId: nonEmptyString(
      source["policyId"],
      "tracker policy.policyId",
      "tracker policy",
    ),
    drivers: { exactlyOneRequired: true, changeOnlyInLane, labels },
    lanes,
    deliveryProfiles: {
      "owner-gated": ownerGated,
      "full-in-scope": fullInScope,
    },
    retry: {
      continuation,
      failure,
      rework,
      freshAttemptFailureLane,
    },
  };
  return { ...document, source: sourceReference };
}

export function trackerLane(
  policy: TrackerPolicyDocument,
  name: string,
): TrackerLanePolicy | null {
  const normalized = name.trim().toLowerCase();
  return (
    policy.lanes.find((entry) => entry.name.toLowerCase() === normalized) ??
    null
  );
}

export function deriveTrackerPolicyRuntime(
  policy: TrackerPolicyDocument,
): TrackerPolicyRuntimeProjection {
  const symphony = policy.drivers.labels.find(
    (entry) => entry.key.toLowerCase() === "symphony",
  );
  if (symphony === undefined) {
    throw new SymphonyError(
      "tracker_policy_invalid",
      "tracker policy has no Symphony driver selector",
    );
  }
  return {
    requiredLabels: [symphony.name],
    excludedLabels: policy.drivers.labels
      .filter((entry) => entry.key.toLowerCase() !== "symphony")
      .map((entry) => entry.name),
    activeStates: policy.lanes
      .filter((entry) => entry.active)
      .map((entry) => entry.name),
    terminalStates: policy.lanes
      .filter((entry) => entry.terminal)
      .map((entry) => entry.name),
    freshAttemptStates: policy.lanes
      .filter((entry) => entry.freshAttempt)
      .map((entry) => entry.name),
    freshAttemptFailureState: policy.retry.freshAttemptFailureLane,
  };
}
