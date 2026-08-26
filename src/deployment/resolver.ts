import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { BlockList, isIP } from "node:net";
import { TextDecoder } from "node:util";

import { SymphonyError } from "../errors.js";
import {
  trustedGitArguments,
  trustedGitEnvironment,
} from "../repository/git-process.js";
import { isRecord, toJsonObject, type JsonObject } from "../shared/json.js";
import type { AcceptedConfigurationSnapshot } from "../state/model.js";
import type { TrackerConfigProfiles } from "../tracker/config-profile.js";
import {
  resolveServiceConfig,
  type ManagedPnpmPreparationAuthorityConfig,
  type ServiceConfig,
} from "../workflow/config.js";
import type { WorkflowDefinition } from "../workflow/definition.js";
import type { WorkflowSnapshot } from "../workflow/store.js";
import {
  DEPLOYMENT_BINDING_SCHEMA_VERSION,
  LEGACY_DEPLOYMENT_BINDING_SCHEMA_VERSION,
  LEGACY_REPOSITORY_PROFILE_SCHEMA_VERSION,
  REPOSITORY_PROFILE_SCHEMA_VERSION,
  type NormalizedDeploymentBindingDocument,
  type RepositoryProfileDocument,
  type ResolvedDeployment,
} from "./model.js";

const MAX_AUTHORITY_FILE_BYTES = 1024 * 1024;
const MAX_CONTEXT_FILE_BYTES = 4 * 1024 * 1024;
const MAX_CONTEXT_TOTAL_BYTES = 16 * 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const forbiddenIpv6Registries = new BlockList();
forbiddenIpv6Registries.addSubnet("::", 128, "ipv6");
forbiddenIpv6Registries.addSubnet("::1", 128, "ipv6");
forbiddenIpv6Registries.addSubnet("fc00::", 7, "ipv6");
forbiddenIpv6Registries.addSubnet("fe80::", 10, "ipv6");
forbiddenIpv6Registries.addSubnet("::ffff:0.0.0.0", 96, "ipv6");

interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface DeploymentResolutionOptions {
  readonly bindingPath: string;
  readonly trackerProfiles: TrackerConfigProfiles;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
}

function invalid(
  kind: "binding" | "profile",
  location: string,
  expectation: string,
): never {
  throw new SymphonyError(
    kind === "binding"
      ? "deployment_binding_invalid"
      : "repository_profile_invalid",
    `${location} ${expectation}`,
  );
}

function refuse(message: string, cause?: unknown): never {
  throw new SymphonyError("deployment_binding_refused", message, {
    ...(cause === undefined ? {} : { cause }),
  });
}

function strictObject(
  value: unknown,
  location: string,
  keys: readonly string[],
  kind: "binding" | "profile",
): Record<string, unknown> {
  if (!isRecord(value)) invalid(kind, location, "must be an object");
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length !== 0) {
    invalid(kind, location, `contains unknown key '${unknown.sort()[0]}'`);
  }
  return value;
}

function nonEmptyString(
  value: unknown,
  location: string,
  kind: "binding" | "profile",
): string {
  if (typeof value !== "string" || value.trim() === "") {
    invalid(kind, location, "must be a non-empty string");
  }
  return value;
}

function nullableString(
  value: unknown,
  location: string,
  kind: "binding" | "profile",
): string | null {
  if (value === null) return null;
  return nonEmptyString(value, location, kind);
}

function integer(value: unknown, location: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    invalid("binding", location, `must be an integer >= ${minimum}`);
  }
  return value as number;
}

function stringList(
  value: unknown,
  location: string,
  kind: "binding" | "profile",
): readonly string[] {
  if (!Array.isArray(value)) invalid(kind, location, "must be an array");
  const values = value.map((entry, index) =>
    nonEmptyString(entry, `${location}[${index}]`, kind),
  );
  const normalized = values.map((entry) => entry.trim().toLowerCase());
  if (new Set(normalized).size !== normalized.length) {
    invalid(kind, location, "must not contain duplicates");
  }
  return values;
}

function sha256(bytes: string | Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function strictDigest(
  value: unknown,
  location: string,
  kind: "binding" | "profile",
): string {
  const digest = nonEmptyString(value, location, kind);
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) {
    invalid(kind, location, "must be a full lowercase SHA-256 digest");
  }
  return digest;
}

function repositoryIdentity(
  value: unknown,
  location: string,
  kind: "binding" | "profile",
): string {
  const identity = nonEmptyString(value, location, kind);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(identity)) {
    invalid(kind, location, "must have the form owner/repository");
  }
  return identity;
}

function repositoryPath(
  value: unknown,
  location: string,
  kind: "binding" | "profile",
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

function absolutePath(value: unknown, location: string): string {
  const candidate = nonEmptyString(value, location, "binding");
  if (!path.isAbsolute(candidate) || /[\0\r\n]/u.test(candidate)) {
    invalid("binding", location, "must be an absolute path");
  }
  return path.resolve(candidate);
}

function exactPackageManagerVersion(value: unknown, location: string): string {
  const version = nonEmptyString(value, location, "binding");
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version)) {
    invalid(
      "binding",
      location,
      "must be an exact stable semantic version such as '11.3.0'",
    );
  }
  return version;
}

function dependencyRegistry(value: unknown, location: string): string {
  const candidate = nonEmptyString(value, location, "binding");
  let registry: URL;
  try {
    registry = new URL(candidate);
  } catch {
    invalid("binding", location, "must be an absolute HTTPS URL");
  }
  if (
    registry.protocol !== "https:" ||
    registry.username !== "" ||
    registry.password !== "" ||
    registry.search !== "" ||
    registry.hash !== "" ||
    registry.hostname === "" ||
    !registry.pathname.endsWith("/")
  ) {
    invalid(
      "binding",
      location,
      "must be a credential-free HTTPS registry URL ending in '/'",
    );
  }
  const hostname = registry.hostname
    .toLowerCase()
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "");
  const ipVersion = isIP(hostname);
  const forbiddenIpv4 = (() => {
    if (ipVersion !== 4) return false;
    const octets = hostname.split(".").map(Number);
    const [first = -1, second = -1] = octets;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19))
    );
  })();
  const forbiddenIpv6 =
    ipVersion === 6 && forbiddenIpv6Registries.check(hostname, "ipv6");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "metadata.google.internal" ||
    forbiddenIpv4 ||
    forbiddenIpv6
  ) {
    invalid(
      "binding",
      location,
      "must not identify loopback, private, link-local, or metadata infrastructure",
    );
  }
  return registry.toString();
}

function branchPrefix(value: unknown): string {
  const prefix = nonEmptyString(value, "binding.branchPrefix", "binding");
  if (
    !prefix.endsWith("/") ||
    prefix.startsWith("/") ||
    prefix.includes("..") ||
    prefix.includes("@{") ||
    prefix.includes("\\")
  ) {
    invalid(
      "binding",
      "binding.branchPrefix",
      "must be a safe relative Git namespace ending in '/'",
    );
  }
  return prefix;
}

function parseJson(
  bytes: Buffer,
  location: string,
  kind: "binding" | "profile",
) {
  if (bytes.byteLength > MAX_AUTHORITY_FILE_BYTES) {
    invalid(
      kind,
      location,
      `must not exceed ${MAX_AUTHORITY_FILE_BYTES} bytes`,
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(utf8.decode(bytes)) as unknown;
  } catch (error) {
    throw new SymphonyError(
      kind === "binding"
        ? "deployment_binding_invalid"
        : "repository_profile_invalid",
      `${location} is not valid UTF-8 JSON`,
      { cause: error },
    );
  }
  return decoded;
}

function parseRepositoryProfile(bytes: Buffer): RepositoryProfileDocument {
  const decoded = parseJson(bytes, "repository profile", "profile");
  if (!isRecord(decoded)) {
    invalid("profile", "repository profile", "must be an object");
  }
  const schemaVersion = decoded["schemaVersion"];
  if (
    schemaVersion !== LEGACY_REPOSITORY_PROFILE_SCHEMA_VERSION &&
    schemaVersion !== REPOSITORY_PROFILE_SCHEMA_VERSION
  ) {
    invalid(
      "profile",
      "repository profile.schemaVersion",
      `must equal ${LEGACY_REPOSITORY_PROFILE_SCHEMA_VERSION} or ${REPOSITORY_PROFILE_SCHEMA_VERSION}`,
    );
  }
  const source = strictObject(
    decoded,
    "repository profile",
    [
      "schemaVersion",
      "repositoryIdentity",
      "baseRef",
      "authoringContext",
      "preparationClass",
      ...(schemaVersion === REPOSITORY_PROFILE_SCHEMA_VERSION
        ? ["deliveryGrant"]
        : []),
    ],
    "profile",
  );
  const context = strictObject(
    source["authoringContext"],
    "repository profile.authoringContext",
    ["promptPath", "paths"],
    "profile",
  );
  const baseRef = nonEmptyString(
    source["baseRef"],
    "repository profile.baseRef",
    "profile",
  );
  if (
    !baseRef.startsWith("refs/heads/") &&
    !baseRef.startsWith("refs/remotes/")
  ) {
    invalid(
      "profile",
      "repository profile.baseRef",
      "must be a full refs/heads/* or refs/remotes/* ref",
    );
  }
  const promptPath = repositoryPath(
    context["promptPath"],
    "repository profile.authoringContext.promptPath",
    "profile",
  );
  const paths = stringList(
    context["paths"],
    "repository profile.authoringContext.paths",
    "profile",
  ).map((entry, index) =>
    repositoryPath(
      entry,
      `repository profile.authoringContext.paths[${index}]`,
      "profile",
    ),
  );
  if (paths.includes(promptPath)) {
    invalid(
      "profile",
      "repository profile.authoringContext.paths",
      "must not repeat promptPath",
    );
  }
  if (JSON.stringify(paths) !== JSON.stringify([...paths].sort())) {
    invalid(
      "profile",
      "repository profile.authoringContext.paths",
      "must be sorted by path",
    );
  }
  const preparationClass = source["preparationClass"];
  if (preparationClass !== "none" && preparationClass !== "pnpm") {
    invalid(
      "profile",
      "repository profile.preparationClass",
      "must be 'none' or 'pnpm'",
    );
  }
  let deliveryGrant: RepositoryProfileDocument["deliveryGrant"] = null;
  if (schemaVersion === REPOSITORY_PROFILE_SCHEMA_VERSION) {
    const grant = strictObject(
      source["deliveryGrant"],
      "repository profile.deliveryGrant",
      ["authority", "governingPolicy", "requiredChecks"],
      "profile",
    );
    const authority = grant["authority"];
    if (authority !== "owner-gated" && authority !== "full-in-scope") {
      invalid(
        "profile",
        "repository profile.deliveryGrant.authority",
        "must be 'owner-gated' or 'full-in-scope'",
      );
    }
    const policy = strictObject(
      grant["governingPolicy"],
      "repository profile.deliveryGrant.governingPolicy",
      ["repositoryIdentity", "path", "revision", "digest"],
      "profile",
    );
    const policyIdentity = repositoryIdentity(
      policy["repositoryIdentity"],
      "repository profile.deliveryGrant.governingPolicy.repositoryIdentity",
      "profile",
    );
    if (!policyIdentity.toLowerCase().endsWith("/.github")) {
      invalid(
        "profile",
        "repository profile.deliveryGrant.governingPolicy.repositoryIdentity",
        "must identify an owner or organization .github repository",
      );
    }
    const policyRevision = nonEmptyString(
      policy["revision"],
      "repository profile.deliveryGrant.governingPolicy.revision",
      "profile",
    );
    if (!/^[0-9a-f]{40}$/u.test(policyRevision)) {
      invalid(
        "profile",
        "repository profile.deliveryGrant.governingPolicy.revision",
        "must be a full lowercase Git SHA-1",
      );
    }
    const requiredChecks = stringList(
      grant["requiredChecks"],
      "repository profile.deliveryGrant.requiredChecks",
      "profile",
    );
    if (requiredChecks.length === 0) {
      invalid(
        "profile",
        "repository profile.deliveryGrant.requiredChecks",
        "must contain at least one protected required check",
      );
    }
    if (
      JSON.stringify(requiredChecks) !==
      JSON.stringify([...requiredChecks].sort())
    ) {
      invalid(
        "profile",
        "repository profile.deliveryGrant.requiredChecks",
        "must be sorted by check name",
      );
    }
    deliveryGrant = {
      authority,
      governingPolicy: {
        repositoryIdentity: policyIdentity,
        path: repositoryPath(
          policy["path"],
          "repository profile.deliveryGrant.governingPolicy.path",
          "profile",
        ),
        revision: policyRevision,
        digest: strictDigest(
          policy["digest"],
          "repository profile.deliveryGrant.governingPolicy.digest",
          "profile",
        ),
      },
      requiredChecks,
    };
  }
  return {
    schemaVersion,
    repositoryIdentity: repositoryIdentity(
      source["repositoryIdentity"],
      "repository profile.repositoryIdentity",
      "profile",
    ),
    baseRef,
    authoringContext: { promptPath, paths },
    preparationClass,
    deliveryGrant,
  };
}

function parseTracker(
  value: unknown,
): NormalizedDeploymentBindingDocument["tracker"] {
  const source = strictObject(
    value,
    "binding.tracker",
    [
      "kind",
      "provider",
      "requiredLabels",
      "excludedLabels",
      "activeStates",
      "terminalStates",
      "freshAttemptStates",
      "freshAttemptFailureState",
    ],
    "binding",
  );
  let provider: JsonObject;
  try {
    provider = toJsonObject(source["provider"], "binding.tracker.provider");
  } catch (error) {
    throw new SymphonyError(
      "deployment_binding_invalid",
      "binding.tracker.provider must be a JSON object",
      { cause: error },
    );
  }
  return {
    kind: nonEmptyString(source["kind"], "binding.tracker.kind", "binding"),
    provider,
    requiredLabels: stringList(
      source["requiredLabels"],
      "binding.tracker.requiredLabels",
      "binding",
    ),
    excludedLabels: stringList(
      source["excludedLabels"],
      "binding.tracker.excludedLabels",
      "binding",
    ),
    activeStates: stringList(
      source["activeStates"],
      "binding.tracker.activeStates",
      "binding",
    ),
    terminalStates: stringList(
      source["terminalStates"],
      "binding.tracker.terminalStates",
      "binding",
    ),
    freshAttemptStates: stringList(
      source["freshAttemptStates"],
      "binding.tracker.freshAttemptStates",
      "binding",
    ),
    freshAttemptFailureState: nullableString(
      source["freshAttemptFailureState"],
      "binding.tracker.freshAttemptFailureState",
      "binding",
    ),
  };
}

function numberMap(
  value: unknown,
  location: string,
): Readonly<Record<string, number>> {
  const source = strictObject(
    value,
    location,
    Object.keys(isRecord(value) ? value : {}),
    "binding",
  );
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (key.trim() === "")
      invalid("binding", location, "must not contain a blank state");
    result[key] = integer(entry, `${location}.${key}`, 1);
  }
  return result;
}

function parseDeploymentBinding(
  bytes: Buffer,
): NormalizedDeploymentBindingDocument {
  const decoded = parseJson(bytes, "deployment binding", "binding");
  if (!isRecord(decoded)) {
    invalid("binding", "binding", "must be an object");
  }
  const schemaVersion = decoded["schemaVersion"];
  if (
    schemaVersion !== LEGACY_DEPLOYMENT_BINDING_SCHEMA_VERSION &&
    schemaVersion !== DEPLOYMENT_BINDING_SCHEMA_VERSION
  ) {
    invalid(
      "binding",
      "binding.schemaVersion",
      `must equal ${LEGACY_DEPLOYMENT_BINDING_SCHEMA_VERSION} or ${DEPLOYMENT_BINDING_SCHEMA_VERSION}`,
    );
  }
  const source = strictObject(
    decoded,
    "binding",
    [
      "schemaVersion",
      "id",
      "productProfile",
      "stateRoot",
      "workspaceRoot",
      "branchPrefix",
      "gitExecutable",
      ...(schemaVersion === DEPLOYMENT_BINDING_SCHEMA_VERSION
        ? ["deliveryProvider"]
        : []),
      "tracker",
      "polling",
      "preparation",
      "agent",
      "runtime",
    ],
    "binding",
  );
  const profile = strictObject(
    source["productProfile"],
    "binding.productProfile",
    ["repositoryIdentity", "sourceRoot", "path", "revision", "digest"],
    "binding",
  );
  const revision = nonEmptyString(
    profile["revision"],
    "binding.productProfile.revision",
    "binding",
  );
  if (!/^[0-9a-f]{40}$/u.test(revision)) {
    invalid(
      "binding",
      "binding.productProfile.revision",
      "must be a full lowercase Git SHA-1",
    );
  }
  const polling = strictObject(
    source["polling"],
    "binding.polling",
    ["intervalMs"],
    "binding",
  );
  const preparationValue = source["preparation"];
  const preparation =
    preparationValue === null
      ? null
      : strictObject(
          preparationValue,
          "binding.preparation",
          [
            "timeoutMs",
            "nodeExecutable",
            "pnpmEntryPoint",
            "sandboxExecutable",
            "dependencyPolicy",
          ],
          "binding",
        );
  const dependencyPolicy =
    preparation === null
      ? null
      : strictObject(
          preparation["dependencyPolicy"],
          "binding.preparation.dependencyPolicy",
          ["id", "mode", "registry", "seedStoreRoot", "pnpmVersion"],
          "binding",
        );
  if (dependencyPolicy !== null && dependencyPolicy["mode"] !== "offline") {
    invalid(
      "binding",
      "binding.preparation.dependencyPolicy.mode",
      "must be 'offline'",
    );
  }
  const agent = strictObject(
    source["agent"],
    "binding.agent",
    [
      "maxConcurrentAgents",
      "maxTurns",
      "maxRetryBackoffMs",
      "maxConcurrentAgentsByState",
    ],
    "binding",
  );
  const runtime = strictObject(
    source["runtime"],
    "binding.runtime",
    [
      "codexExecutable",
      "turnTimeoutMs",
      "readTimeoutMs",
      "stallTimeoutMs",
      "containment",
    ],
    "binding",
  );
  const containment = strictObject(
    runtime["containment"],
    "binding.runtime.containment",
    [
      "provider",
      "shutdownTimeoutMs",
      "systemdRunExecutable",
      "systemctlExecutable",
    ],
    "binding",
  );
  if (containment["provider"] !== "systemd-user-scope") {
    invalid(
      "binding",
      "binding.runtime.containment.provider",
      "must be 'systemd-user-scope'",
    );
  }
  const deliveryProviderValue =
    schemaVersion === DEPLOYMENT_BINDING_SCHEMA_VERSION
      ? source["deliveryProvider"]
      : null;
  const deliveryProvider =
    deliveryProviderValue === null
      ? null
      : strictObject(
          deliveryProviderValue,
          "binding.deliveryProvider",
          [
            "protocolVersion",
            "executable",
            "timeoutMs",
            "secretEnvironmentNames",
          ],
          "binding",
        );
  if (deliveryProvider !== null && deliveryProvider["protocolVersion"] !== 1) {
    invalid(
      "binding",
      "binding.deliveryProvider.protocolVersion",
      "must equal 1",
    );
  }
  const deliverySecretNames =
    deliveryProvider === null
      ? []
      : stringList(
          deliveryProvider["secretEnvironmentNames"],
          "binding.deliveryProvider.secretEnvironmentNames",
          "binding",
        );
  for (const [index, name] of deliverySecretNames.entries()) {
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(name)) {
      invalid(
        "binding",
        `binding.deliveryProvider.secretEnvironmentNames[${index}]`,
        "must be an uppercase environment-variable name",
      );
    }
  }
  if (
    JSON.stringify(deliverySecretNames) !==
    JSON.stringify([...deliverySecretNames].sort())
  ) {
    invalid(
      "binding",
      "binding.deliveryProvider.secretEnvironmentNames",
      "must be sorted",
    );
  }
  return {
    schemaVersion,
    id: nonEmptyString(source["id"], "binding.id", "binding"),
    productProfile: {
      repositoryIdentity: repositoryIdentity(
        profile["repositoryIdentity"],
        "binding.productProfile.repositoryIdentity",
        "binding",
      ),
      sourceRoot: absolutePath(
        profile["sourceRoot"],
        "binding.productProfile.sourceRoot",
      ),
      path: repositoryPath(
        profile["path"],
        "binding.productProfile.path",
        "binding",
      ),
      revision,
      digest: strictDigest(
        profile["digest"],
        "binding.productProfile.digest",
        "binding",
      ),
    },
    stateRoot: absolutePath(source["stateRoot"], "binding.stateRoot"),
    workspaceRoot: absolutePath(
      source["workspaceRoot"],
      "binding.workspaceRoot",
    ),
    branchPrefix: branchPrefix(source["branchPrefix"]),
    gitExecutable: absolutePath(
      source["gitExecutable"],
      "binding.gitExecutable",
    ),
    deliveryProvider:
      deliveryProvider === null
        ? null
        : {
            protocolVersion: 1,
            executable: absolutePath(
              deliveryProvider["executable"],
              "binding.deliveryProvider.executable",
            ),
            timeoutMs: integer(
              deliveryProvider["timeoutMs"],
              "binding.deliveryProvider.timeoutMs",
              1,
            ),
            secretEnvironmentNames: deliverySecretNames,
          },
    tracker: parseTracker(source["tracker"]),
    polling: {
      intervalMs: integer(
        polling["intervalMs"],
        "binding.polling.intervalMs",
        1,
      ),
    },
    preparation:
      preparation === null || dependencyPolicy === null
        ? null
        : {
            timeoutMs: integer(
              preparation["timeoutMs"],
              "binding.preparation.timeoutMs",
              1,
            ),
            nodeExecutable: absolutePath(
              preparation["nodeExecutable"],
              "binding.preparation.nodeExecutable",
            ),
            pnpmEntryPoint: absolutePath(
              preparation["pnpmEntryPoint"],
              "binding.preparation.pnpmEntryPoint",
            ),
            sandboxExecutable: absolutePath(
              preparation["sandboxExecutable"],
              "binding.preparation.sandboxExecutable",
            ),
            dependencyPolicy: {
              id: nonEmptyString(
                dependencyPolicy["id"],
                "binding.preparation.dependencyPolicy.id",
                "binding",
              ),
              mode: "offline",
              registry: dependencyRegistry(
                dependencyPolicy["registry"],
                "binding.preparation.dependencyPolicy.registry",
              ),
              seedStoreRoot: absolutePath(
                dependencyPolicy["seedStoreRoot"],
                "binding.preparation.dependencyPolicy.seedStoreRoot",
              ),
              pnpmVersion: exactPackageManagerVersion(
                dependencyPolicy["pnpmVersion"],
                "binding.preparation.dependencyPolicy.pnpmVersion",
              ),
            },
          },
    agent: {
      maxConcurrentAgents: integer(
        agent["maxConcurrentAgents"],
        "binding.agent.maxConcurrentAgents",
        1,
      ),
      maxTurns: integer(agent["maxTurns"], "binding.agent.maxTurns", 1),
      maxRetryBackoffMs: integer(
        agent["maxRetryBackoffMs"],
        "binding.agent.maxRetryBackoffMs",
        0,
      ),
      maxConcurrentAgentsByState: numberMap(
        agent["maxConcurrentAgentsByState"],
        "binding.agent.maxConcurrentAgentsByState",
      ),
    },
    runtime: {
      codexExecutable: absolutePath(
        runtime["codexExecutable"],
        "binding.runtime.codexExecutable",
      ),
      turnTimeoutMs: integer(
        runtime["turnTimeoutMs"],
        "binding.runtime.turnTimeoutMs",
        1,
      ),
      readTimeoutMs: integer(
        runtime["readTimeoutMs"],
        "binding.runtime.readTimeoutMs",
        1,
      ),
      stallTimeoutMs: integer(
        runtime["stallTimeoutMs"],
        "binding.runtime.stallTimeoutMs",
        0,
      ),
      containment: {
        provider: "systemd-user-scope",
        shutdownTimeoutMs: integer(
          containment["shutdownTimeoutMs"],
          "binding.runtime.containment.shutdownTimeoutMs",
          100,
        ),
        systemdRunExecutable: absolutePath(
          containment["systemdRunExecutable"],
          "binding.runtime.containment.systemdRunExecutable",
        ),
        systemctlExecutable: absolutePath(
          containment["systemctlExecutable"],
          "binding.runtime.containment.systemctlExecutable",
        ),
      },
    },
  };
}

function command(
  executable: string,
  args: readonly string[],
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      executable,
      [...args],
      {
        ...(cwd === undefined ? {} : { cwd }),
        encoding: "utf8",
        env: environment,
        maxBuffer: MAX_CONTEXT_FILE_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        resolve({
          exitCode: error === null ? 0 : typeof code === "number" ? code : 1,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

async function git(
  gitExecutable: string,
  sourceRoot: string,
  args: readonly string[],
): Promise<string> {
  const result = await new Promise<CommandResult>((resolve) => {
    execFile(
      gitExecutable,
      [...trustedGitArguments(sourceRoot, args)],
      {
        encoding: "utf8",
        env: trustedGitEnvironment(),
        maxBuffer: MAX_CONTEXT_FILE_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        resolve({
          exitCode: error === null ? 0 : typeof code === "number" ? code : 1,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
  if (result.exitCode !== 0) {
    refuse(
      `Git could not resolve accepted product context (${args[0] ?? "unknown"}): ${result.stderr.trim() || `exit ${result.exitCode}`}`,
    );
  }
  return result.stdout.trim();
}

function gitBytes(
  gitExecutable: string,
  sourceRoot: string,
  args: readonly string[],
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      gitExecutable,
      [...trustedGitArguments(sourceRoot, args)],
      {
        encoding: "buffer",
        env: trustedGitEnvironment(),
        maxBuffer: MAX_CONTEXT_FILE_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(
            new SymphonyError(
              "deployment_binding_refused",
              `Git could not read accepted product bytes (${args[0] ?? "unknown"}): ${Buffer.from(stderr).toString("utf8").trim() || error.message}`,
              { cause: error },
            ),
          );
          return;
        }
        resolve(Buffer.from(stdout));
      },
    );
  });
}

async function acceptedBlob(
  gitExecutable: string,
  sourceRoot: string,
  revision: string,
  repositoryPathValue: string,
): Promise<Buffer> {
  const tree = await git(gitExecutable, sourceRoot, [
    "ls-tree",
    revision,
    "--",
    repositoryPathValue,
  ]);
  const match = /^(100644|100755) blob [0-9a-f]{40}\t(.+)$/u.exec(tree);
  if (match === null || match[2] !== repositoryPathValue) {
    refuse(
      `Accepted context ${repositoryPathValue} must be one regular Git blob at ${revision}`,
    );
  }
  const bytes = await gitBytes(gitExecutable, sourceRoot, [
    "show",
    `${revision}:${repositoryPathValue}`,
  ]);
  if (bytes.byteLength > MAX_CONTEXT_FILE_BYTES) {
    refuse(
      `Accepted context ${repositoryPathValue} exceeds ${MAX_CONTEXT_FILE_BYTES} bytes`,
    );
  }
  return bytes;
}

function insideOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function assertExecutableOutsideGovernedRoots(
  label: string,
  executablePath: string,
  roots: {
    readonly sourceRoot: string;
    readonly stateRoot: string;
    readonly workspaceRoot: string;
  },
): void {
  if (
    insideOrEqual(roots.sourceRoot, executablePath) ||
    insideOrEqual(roots.stateRoot, executablePath) ||
    insideOrEqual(roots.workspaceRoot, executablePath)
  ) {
    refuse(
      `Deployment ${label} executable must be outside product, state, and workspace roots`,
    );
  }
}

async function regularFile(filePath: string, label: string): Promise<string> {
  try {
    const entry = await lstat(filePath);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      refuse(`${label} must be a regular non-symlink file`);
    }
    return await realpath(filePath);
  } catch (error) {
    if (error instanceof SymphonyError) throw error;
    refuse(`Could not inspect ${label}`, error);
  }
}

async function regularDirectory(
  directoryPath: string,
  label: string,
): Promise<string> {
  try {
    const entry = await lstat(directoryPath);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      refuse(`${label} must be a real non-symlink directory`);
    }
    return await realpath(directoryPath);
  } catch (error) {
    if (error instanceof SymphonyError) throw error;
    refuse(`Could not inspect ${label}`, error);
  }
}

async function executable(filePath: string, label: string): Promise<string> {
  const resolved = await regularFile(filePath, label);
  try {
    await access(resolved, fsConstants.X_OK);
  } catch (error) {
    refuse(`${label} must be executable`, error);
  }
  return resolved;
}

function dependencyPolicyDigest(
  policy: NonNullable<
    NormalizedDeploymentBindingDocument["preparation"]
  >["dependencyPolicy"],
): string {
  return sha256(
    JSON.stringify({
      schemaVersion: 1,
      id: policy.id,
      mode: policy.mode,
      registry: policy.registry,
      seedStoreRoot: policy.seedStoreRoot,
      pnpmVersion: policy.pnpmVersion,
    }),
  );
}

async function resolvePreparationAuthority(
  preparation: NonNullable<
    NormalizedDeploymentBindingDocument["preparation"]
  > | null,
  roots: {
    readonly sourceRoot: string;
    readonly stateRoot: string;
    readonly workspaceRoot: string;
  },
): Promise<ManagedPnpmPreparationAuthorityConfig | null> {
  if (preparation === null) return null;

  const nodeExecutable = await executable(
    preparation.nodeExecutable,
    "deployment preparation Node executable",
  );
  const pnpmEntryPoint = await regularFile(
    preparation.pnpmEntryPoint,
    "deployment pnpm entry point",
  );
  const sandboxExecutable = await executable(
    preparation.sandboxExecutable,
    "deployment preparation sandbox executable",
  );
  const seedStoreRoot = await regularDirectory(
    preparation.dependencyPolicy.seedStoreRoot,
    "deployment dependency seed store",
  );

  for (const [label, configuredPath, resolvedPath] of [
    ["preparation Node executable", preparation.nodeExecutable, nodeExecutable],
    ["pnpm entry point", preparation.pnpmEntryPoint, pnpmEntryPoint],
    [
      "preparation sandbox executable",
      preparation.sandboxExecutable,
      sandboxExecutable,
    ],
    [
      "dependency seed store",
      preparation.dependencyPolicy.seedStoreRoot,
      seedStoreRoot,
    ],
  ] as const) {
    if (configuredPath !== resolvedPath) {
      refuse(`Deployment ${label} must contain no symbolic-link components`);
    }
  }
  for (const [label, executablePath] of [
    ["preparation Node", nodeExecutable],
    ["pnpm", pnpmEntryPoint],
    ["preparation sandbox", sandboxExecutable],
  ] as const) {
    assertExecutableOutsideGovernedRoots(label, executablePath, roots);
  }
  for (const [label, root] of [
    ["product source", roots.sourceRoot],
    ["state", roots.stateRoot],
    ["workspace", roots.workspaceRoot],
  ] as const) {
    if (
      insideOrEqual(root, seedStoreRoot) ||
      insideOrEqual(seedStoreRoot, root)
    ) {
      refuse(`Deployment dependency seed store must be disjoint from ${label}`);
    }
  }

  const pnpmVersionResult = await command(
    nodeExecutable,
    [pnpmEntryPoint, "--version"],
    undefined,
    { LANG: "C", LC_ALL: "C" },
  );
  if (
    pnpmVersionResult.exitCode !== 0 ||
    pnpmVersionResult.stdout.trim() !== preparation.dependencyPolicy.pnpmVersion
  ) {
    refuse(
      `Deployment pnpm entry point must report version ${preparation.dependencyPolicy.pnpmVersion}`,
    );
  }

  return {
    nodeExecutable,
    pnpmEntryPoint,
    sandboxExecutable,
    dependencyPolicy: {
      ...preparation.dependencyPolicy,
      digest: dependencyPolicyDigest({
        ...preparation.dependencyPolicy,
        seedStoreRoot,
      }),
      seedStoreRoot,
    },
  };
}

function syntheticWorkflowConfig(
  binding: NormalizedDeploymentBindingDocument,
  profile: RepositoryProfileDocument,
): JsonObject {
  return {
    tracker: {
      kind: binding.tracker.kind,
      provider: binding.tracker.provider,
      required_labels: [...binding.tracker.requiredLabels],
      excluded_labels: [...binding.tracker.excludedLabels],
      active_states: [...binding.tracker.activeStates],
      terminal_states: [...binding.tracker.terminalStates],
      fresh_attempt_states: [...binding.tracker.freshAttemptStates],
      ...(binding.tracker.freshAttemptFailureState === null
        ? {}
        : {
            fresh_attempt_failure_state:
              binding.tracker.freshAttemptFailureState,
          }),
    },
    polling: { interval_ms: binding.polling.intervalMs },
    repository: {
      identity: profile.repositoryIdentity,
      base_ref: profile.baseRef,
      branch_prefix: binding.branchPrefix,
    },
    workspace: { provider: "git-worktree", root: binding.workspaceRoot },
    preparation: {
      driver: profile.preparationClass,
      frozen_lockfile: true,
      lifecycle_scripts: false,
      timeout_ms: binding.preparation?.timeoutMs ?? 300_000,
    },
    agent: {
      max_concurrent_agents: binding.agent.maxConcurrentAgents,
      max_turns: binding.agent.maxTurns,
      max_retry_backoff_ms: binding.agent.maxRetryBackoffMs,
      max_concurrent_agents_by_state: binding.agent.maxConcurrentAgentsByState,
    },
    codex: {
      turn_timeout_ms: binding.runtime.turnTimeoutMs,
      read_timeout_ms: binding.runtime.readTimeoutMs,
      stall_timeout_ms: binding.runtime.stallTimeoutMs,
    },
  };
}

export async function resolveDeploymentBinding(
  options: DeploymentResolutionOptions,
): Promise<ResolvedDeployment> {
  const bindingPath = await regularFile(
    path.resolve(options.bindingPath),
    "deployment binding",
  );
  const bindingBytes = await readFile(bindingPath);
  const binding = parseDeploymentBinding(bindingBytes);
  const bindingDigest = sha256(bindingBytes);
  const gitExecutable = await executable(
    binding.gitExecutable,
    "deployment Git executable",
  );
  if (gitExecutable !== binding.gitExecutable) {
    refuse(
      "Deployment Git executable must contain no symbolic-link components",
    );
  }

  let sourceRoot: string;
  try {
    sourceRoot = await realpath(binding.productProfile.sourceRoot);
    const entry = await lstat(sourceRoot);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      refuse("Deployment source root must be a real directory");
    }
  } catch (error) {
    if (error instanceof SymphonyError) throw error;
    refuse("Could not inspect deployment source root", error);
  }
  const governedRoots = {
    sourceRoot,
    stateRoot: binding.stateRoot,
    workspaceRoot: binding.workspaceRoot,
  };
  assertExecutableOutsideGovernedRoots("Git", gitExecutable, governedRoots);
  const actualRoot = path.resolve(
    await git(gitExecutable, sourceRoot, ["rev-parse", "--show-toplevel"]),
  );
  if (actualRoot !== sourceRoot) {
    refuse(`Deployment source root ${sourceRoot} is not the Git worktree root`);
  }
  if (insideOrEqual(sourceRoot, bindingPath)) {
    refuse("Deployment binding must be outside the product source root");
  }
  for (const [label, root] of [
    ["state", binding.stateRoot],
    ["workspace", binding.workspaceRoot],
  ] as const) {
    if (insideOrEqual(sourceRoot, root) || insideOrEqual(root, sourceRoot)) {
      refuse(`Deployment ${label} root must be disjoint from product source`);
    }
    if (insideOrEqual(root, bindingPath)) {
      refuse(`Deployment binding must be outside the ${label} root`);
    }
  }
  if (
    insideOrEqual(binding.stateRoot, binding.workspaceRoot) ||
    insideOrEqual(binding.workspaceRoot, binding.stateRoot)
  ) {
    refuse("Deployment state and workspace roots must be disjoint");
  }

  const resolvedRevision = await git(gitExecutable, sourceRoot, [
    "rev-parse",
    "--verify",
    `${binding.productProfile.revision}^{commit}`,
  ]);
  if (resolvedRevision !== binding.productProfile.revision) {
    refuse("Deployment product-profile revision did not resolve exactly");
  }
  const profileBytes = await acceptedBlob(
    gitExecutable,
    sourceRoot,
    resolvedRevision,
    binding.productProfile.path,
  );
  if (sha256(profileBytes) !== binding.productProfile.digest) {
    refuse("Accepted repository-profile digest does not match its Git bytes");
  }
  const profile = parseRepositoryProfile(profileBytes);
  if (
    profile.repositoryIdentity.toLowerCase() !==
    binding.productProfile.repositoryIdentity.toLowerCase()
  ) {
    refuse("Repository profile identity does not match its deployment binding");
  }
  if (
    (profile.preparationClass === "pnpm") !==
    (binding.preparation !== null)
  ) {
    refuse(
      "Deployment preparation authority must be present exactly when the accepted product profile selects 'pnpm'",
    );
  }
  if (
    (profile.deliveryGrant !== null) !==
    (binding.deliveryProvider !== null)
  ) {
    refuse(
      "Deployment delivery-provider authority must be present exactly when the accepted product profile contains a delivery grant",
    );
  }
  const baseSha = await git(gitExecutable, sourceRoot, [
    "rev-parse",
    "--verify",
    `${profile.baseRef}^{commit}`,
  ]);
  if (!/^[0-9a-f]{40}$/u.test(baseSha)) {
    refuse(
      `Product base ref ${profile.baseRef} did not resolve to a Git commit`,
    );
  }
  const ancestry = await command(
    gitExecutable,
    [
      ...trustedGitArguments(sourceRoot, [
        "merge-base",
        "--is-ancestor",
        resolvedRevision,
        baseSha,
      ]),
    ],
    undefined,
    trustedGitEnvironment(),
  );
  if (ancestry.exitCode !== 0) {
    refuse(
      "Accepted repository-profile revision is not an ancestor of the product base",
    );
  }

  const contextPaths = [
    profile.authoringContext.promptPath,
    ...profile.authoringContext.paths,
  ].sort();
  const contextBytes = new Map<string, Buffer>();
  let contextTotal = 0;
  for (const contextPath of contextPaths) {
    const bytes = await acceptedBlob(
      gitExecutable,
      sourceRoot,
      resolvedRevision,
      contextPath,
    );
    contextTotal += bytes.byteLength;
    if (contextTotal > MAX_CONTEXT_TOTAL_BYTES) {
      refuse(
        `Accepted authoring context exceeds ${MAX_CONTEXT_TOTAL_BYTES} bytes`,
      );
    }
    contextBytes.set(contextPath, bytes);
  }
  const entries = contextPaths.map((contextPath) => ({
    path: contextPath,
    digest: sha256(contextBytes.get(contextPath)!),
  }));
  const authoringContext = {
    repositoryIdentity: profile.repositoryIdentity,
    revision: resolvedRevision,
    manifestDigest: sha256(
      JSON.stringify({
        schemaVersion: 1,
        repositoryIdentity: profile.repositoryIdentity,
        revision: resolvedRevision,
        entries,
      }),
    ),
    entries,
  };
  const acceptedConfiguration: AcceptedConfigurationSnapshot = {
    productProfile: {
      repositoryIdentity: profile.repositoryIdentity,
      path: binding.productProfile.path,
      revision: resolvedRevision,
      digest: binding.productProfile.digest,
    },
    authoringContext,
    deploymentBinding: { id: binding.id, digest: bindingDigest },
    deliveryGrant: profile.deliveryGrant,
  };

  const codexExecutable = await executable(
    binding.runtime.codexExecutable,
    "deployment Codex executable",
  );
  const systemdRunExecutable = await executable(
    binding.runtime.containment.systemdRunExecutable,
    "deployment systemd-run executable",
  );
  const systemctlExecutable = await executable(
    binding.runtime.containment.systemctlExecutable,
    "deployment systemctl executable",
  );
  const deliveryProviderExecutable =
    binding.deliveryProvider === null
      ? null
      : await executable(
          binding.deliveryProvider.executable,
          "deployment delivery-provider executable",
        );
  for (const [label, executablePath] of [
    ["Codex", codexExecutable],
    ["systemd-run", systemdRunExecutable],
    ["systemctl", systemctlExecutable],
    ...(deliveryProviderExecutable === null
      ? []
      : [["delivery provider", deliveryProviderExecutable] as const]),
  ] as const) {
    assertExecutableOutsideGovernedRoots(label, executablePath, governedRoots);
  }
  if (
    deliveryProviderExecutable !== null &&
    deliveryProviderExecutable !== binding.deliveryProvider?.executable
  ) {
    refuse(
      "Deployment delivery-provider executable must contain no symbolic-link components",
    );
  }
  const sourceEnvironment = options.environment ?? process.env;
  for (const name of binding.deliveryProvider?.secretEnvironmentNames ?? []) {
    if ((sourceEnvironment[name] ?? "").trim() === "") {
      refuse(`Deployment delivery-provider secret ${name} is missing`);
    }
  }
  const preparationAuthority = await resolvePreparationAuthority(
    binding.preparation,
    {
      sourceRoot,
      stateRoot: binding.stateRoot,
      workspaceRoot: binding.workspaceRoot,
    },
  );

  const definition: WorkflowDefinition = {
    config: {},
    promptTemplate: utf8
      .decode(contextBytes.get(profile.authoringContext.promptPath)!)
      .trim(),
  };
  if (definition.promptTemplate === "") {
    refuse("Accepted product prompt must not be blank");
  }
  const baseConfig = resolveServiceConfig(
    {
      config: syntheticWorkflowConfig(binding, profile),
      promptTemplate: definition.promptTemplate,
    },
    {
      workflowPath: bindingPath,
      trackerProfiles: options.trackerProfiles,
      environment: options.environment ?? process.env,
    },
  );
  if (baseConfig.repository === null) {
    refuse("Resolved deployment did not produce a managed repository profile");
  }
  const serviceConfig: ServiceConfig = {
    ...baseConfig,
    tracker: {
      ...baseConfig.tracker,
      secretEnvironmentNames: [
        ...new Set([
          ...baseConfig.tracker.secretEnvironmentNames,
          ...(binding.deliveryProvider?.secretEnvironmentNames ?? []),
        ]),
      ],
    },
    deployment: {
      bindingId: binding.id,
      bindingDigest,
      bindingPath,
      sourceRoot,
      stateRoot: binding.stateRoot,
      acceptedConfiguration,
      codexExecutable,
      gitExecutable,
      deliveryProvider:
        binding.deliveryProvider === null || deliveryProviderExecutable === null
          ? null
          : {
              ...binding.deliveryProvider,
              executable: deliveryProviderExecutable,
            },
      preparation: preparationAuthority,
      processContainment: {
        provider: "systemd-user-scope",
        shutdownTimeoutMs: binding.runtime.containment.shutdownTimeoutMs,
        systemdRunExecutable,
        systemctlExecutable,
      },
    },
    repository: {
      ...baseConfig.repository,
      profileDigest: binding.productProfile.digest,
    },
  };
  const loadedAt = (options.now ?? (() => new Date()))();
  const workflow: WorkflowSnapshot = {
    config: serviceConfig,
    definition,
    loadedAt,
    path: bindingPath,
    sourceHash: bindingDigest.slice("sha256:".length),
  };
  return {
    binding,
    bindingDigest,
    bindingPath,
    acceptedConfiguration,
    profile,
    serviceConfig,
    workflow,
  };
}
