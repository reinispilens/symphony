import os from "node:os";
import path from "node:path";

import { SymphonyError } from "../errors.js";
import {
  isRecord,
  toJsonObject,
  type JsonObject,
  type JsonValue,
} from "../shared/json.js";
import {
  MANAGED_CODEX_APPROVAL_POLICY,
  MANAGED_CODEX_COMMAND,
  MANAGED_CODEX_THREAD_SANDBOX,
  managedCodexTurnSandboxPolicy,
} from "../security/managed-codex-policy.js";
import type { AcceptedConfigurationSnapshot } from "../state/model.js";
import type { TrackerConfigProfiles } from "../tracker/config-profile.js";
import type { WorkflowDefinition } from "./definition.js";

export interface TrackerConfig {
  readonly kind: string;
  readonly provider: JsonObject;
  readonly requiredLabels: readonly string[];
  readonly excludedLabels: readonly string[];
  readonly activeStates: readonly string[];
  readonly terminalStates: readonly string[];
  readonly freshAttemptStates: readonly string[];
  readonly freshAttemptFailureState: string | null;
  readonly secretEnvironmentNames: readonly string[];
}

export interface PollingConfig {
  readonly intervalMs: number;
}

export interface WorkspaceConfig {
  readonly provider: "directory" | "git-worktree" | "harness";
  readonly root: string;
}

export interface RepositoryConfig {
  readonly identity: string;
  readonly hostname: string;
  readonly baseRef: string;
  readonly branchPrefix: string;
  /** Exact accepted product-profile digest; null only on the workflow compatibility path. */
  readonly profileDigest: string | null;
}

export interface ManagedProcessContainmentConfig {
  readonly provider: "systemd-user-scope";
  readonly shutdownTimeoutMs: number;
  readonly systemdRunExecutable: string;
  readonly systemctlExecutable: string;
}

/**
 * Operator-owned package preparation authority. Product repositories select
 * only the portable preparation class; they cannot select host executables,
 * cache roots, registry identity, or network behavior.
 */
export interface ManagedPnpmPreparationAuthorityConfig {
  readonly nodeExecutable: string;
  readonly pnpmEntryPoint: string;
  readonly sandboxExecutable: string;
  readonly dependencyPolicy: {
    readonly id: string;
    readonly digest: string;
    readonly mode: "offline";
    readonly registry: string;
    readonly seedStoreRoot: string;
    readonly pnpmVersion: string;
  };
}

export interface DeploymentAuthorityConfig {
  readonly bindingId: string;
  readonly bindingDigest: string;
  readonly bindingPath: string;
  readonly sourceRoot: string;
  readonly stateRoot: string;
  readonly acceptedConfiguration: AcceptedConfigurationSnapshot;
  readonly codexExecutable: string;
  readonly gitExecutable: string;
  readonly deliveryProvider: {
    readonly protocolVersion: 1;
    readonly executable: string;
    readonly timeoutMs: number;
    readonly secretEnvironmentNames: readonly string[];
  } | null;
  readonly preparation: ManagedPnpmPreparationAuthorityConfig | null;
  readonly processContainment: ManagedProcessContainmentConfig;
}

export interface PreparationConfig {
  readonly driver: "none" | "pnpm";
  readonly frozenLockfile: true;
  readonly lifecycleScripts: false;
  readonly timeoutMs: number;
}

export interface HooksConfig {
  readonly afterCreate: string | null;
  readonly beforeRun: string | null;
  readonly afterRun: string | null;
  readonly beforeRemove: string | null;
  readonly timeoutMs: number;
}

export interface AgentConfig {
  readonly maxConcurrentAgents: number;
  readonly maxTurns: number;
  readonly maxRetryBackoffMs: number;
  readonly maxConcurrentAgentsByState: ReadonlyMap<string, number>;
}

export interface CodexConfig {
  readonly command: string;
  readonly approvalPolicy: JsonValue | null;
  readonly threadSandbox: JsonValue | null;
  readonly turnSandboxPolicy: JsonValue | null;
  readonly turnTimeoutMs: number;
  readonly readTimeoutMs: number;
  readonly stallTimeoutMs: number;
}

export interface ServiceConfig {
  readonly deployment: DeploymentAuthorityConfig | null;
  readonly tracker: TrackerConfig;
  readonly repository: RepositoryConfig | null;
  readonly preparation: PreparationConfig;
  readonly polling: PollingConfig;
  readonly workspace: WorkspaceConfig;
  readonly hooks: HooksConfig;
  readonly agent: AgentConfig;
  readonly codex: CodexConfig;
}

export interface ConfigResolutionOptions {
  readonly workflowPath: string;
  readonly trackerProfiles: TrackerConfigProfiles;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory?: string;
  readonly temporaryDirectory?: string;
}

function fail(pathLabel: string, expectation: string): never {
  throw new SymphonyError(
    "config_validation_error",
    `${pathLabel} ${expectation}`,
  );
}

function optionalObject(
  root: JsonObject,
  key: string,
  pathLabel: string,
): JsonObject {
  const value = root[key];
  if (value === undefined) return {};
  if (!isRecord(value)) fail(pathLabel, "must be an object");
  return toJsonObject(value, pathLabel);
}

function optionalString(
  root: JsonObject,
  key: string,
  pathLabel: string,
  fallback: string | null,
): string | null {
  const value = root[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string") fail(pathLabel, "must be a string");
  return value;
}

function optionalBoolean(
  root: JsonObject,
  key: string,
  pathLabel: string,
  fallback: boolean,
): boolean {
  const value = root[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") fail(pathLabel, "must be a boolean");
  return value;
}

function requiredNonEmptyString(
  root: JsonObject,
  key: string,
  pathLabel: string,
): string {
  const value = root[key];
  if (typeof value !== "string" || value.trim() === "") {
    fail(pathLabel, "must be a non-empty string");
  }
  return value;
}

function integer(
  root: JsonObject,
  key: string,
  pathLabel: string,
  fallback: number,
  predicate: (value: number) => boolean,
  expectation: string,
): number {
  const value = root[key];
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || !predicate(value as number))
    fail(pathLabel, expectation);
  return value as number;
}

function stringList(
  root: JsonObject,
  key: string,
  pathLabel: string,
  fallback: readonly string[],
): readonly string[] {
  const value = root[key];
  if (value === undefined) return [...fallback];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    fail(pathLabel, "must be a list of strings");
  }
  return [...(value as string[])];
}

function selectorLabels(
  root: JsonObject,
  key: string,
  pathLabel: string,
): readonly string[] {
  const labels = stringList(root, key, pathLabel, []);
  const seen = new Set<string>();
  for (const label of labels) {
    const normalized = label.trim().toLowerCase();
    if (normalized === "") fail(pathLabel, "must not contain blank labels");
    if (seen.has(normalized))
      fail(pathLabel, `contains duplicate label '${label}'`);
    seen.add(normalized);
  }
  return labels;
}

function resolveEnvironmentInPath(
  rawPath: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  return rawPath.replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/gu,
    (_, braced, plain) => {
      const name = (braced ?? plain) as string;
      const value = environment[name];
      if (value === undefined || value === "") {
        fail(
          "workspace.root",
          `references missing environment variable ${name}`,
        );
      }
      return value;
    },
  );
}

function resolveWorkspaceRoot(
  rawPath: string | null,
  workflowPath: string,
  environment: Readonly<Record<string, string | undefined>>,
  homeDirectory: string,
  temporaryDirectory: string,
): string {
  if (rawPath === null)
    return path.resolve(temporaryDirectory, "symphony_workspaces");
  if (rawPath.trim() === "") fail("workspace.root", "must not be blank");

  let expanded = resolveEnvironmentInPath(rawPath, environment);
  if (expanded === "~") expanded = homeDirectory;
  else if (expanded.startsWith(`~${path.sep}`) || expanded.startsWith("~/")) {
    expanded = path.join(homeDirectory, expanded.slice(2));
  } else if (expanded.startsWith("~")) {
    fail(
      "workspace.root",
      "supports '~' only for the current user's home directory",
    );
  }

  return path.resolve(path.dirname(workflowPath), expanded);
}

function perStateLimits(agent: JsonObject): ReadonlyMap<string, number> {
  const raw = agent["max_concurrent_agents_by_state"];
  if (raw === undefined) return new Map();
  if (!isRecord(raw))
    fail("agent.max_concurrent_agents_by_state", "must be an object");

  const result = new Map<string, number>();
  for (const [state, value] of Object.entries(raw)) {
    const normalized = state.trim().toLowerCase();
    if (
      normalized !== "" &&
      Number.isSafeInteger(value) &&
      (value as number) > 0
    ) {
      result.set(normalized, value as number);
    }
  }
  return result;
}

export function resolveServiceConfig(
  definition: WorkflowDefinition,
  options: ConfigResolutionOptions,
): ServiceConfig {
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const temporaryDirectory = options.temporaryDirectory ?? os.tmpdir();
  const workflowPath = path.resolve(options.workflowPath);

  const tracker = optionalObject(definition.config, "tracker", "tracker");
  const kind = requiredNonEmptyString(tracker, "kind", "tracker.kind");
  const profile = options.trackerProfiles.get(kind);
  if (profile === undefined) {
    fail("tracker.kind", `selects unsupported adapter '${kind}'`);
  }

  const rawProvider = optionalObject(tracker, "provider", "tracker.provider");
  const provider = profile.resolveProvider(rawProvider, environment);
  const requiredLabels = selectorLabels(
    tracker,
    "required_labels",
    "tracker.required_labels",
  );
  const excludedLabels = selectorLabels(
    tracker,
    "excluded_labels",
    "tracker.excluded_labels",
  );
  const normalizedRequiredLabels = new Set(
    requiredLabels.map((label) => label.trim().toLowerCase()),
  );
  for (const excluded of excludedLabels) {
    if (normalizedRequiredLabels.has(excluded.trim().toLowerCase())) {
      fail(
        "tracker.excluded_labels",
        `overlaps tracker.required_labels at '${excluded}'`,
      );
    }
  }
  const activeStates = stringList(
    tracker,
    "active_states",
    "tracker.active_states",
    profile.defaultActiveStates ?? [],
  );
  const terminalStates = stringList(
    tracker,
    "terminal_states",
    "tracker.terminal_states",
    profile.defaultTerminalStates ?? [],
  );
  const freshAttemptStates = stringList(
    tracker,
    "fresh_attempt_states",
    "tracker.fresh_attempt_states",
    [],
  );
  const freshAttemptFailureState = optionalString(
    tracker,
    "fresh_attempt_failure_state",
    "tracker.fresh_attempt_failure_state",
    null,
  );
  if (
    tracker["active_states"] === undefined &&
    profile.defaultActiveStates === undefined
  ) {
    fail(
      "tracker.active_states",
      "is required because this adapter has no default",
    );
  }
  const normalizedActiveStates = new Set(
    activeStates.map((state) => state.trim().toLowerCase()),
  );
  const normalizedTerminalStates = new Set(
    terminalStates.map((state) => state.trim().toLowerCase()),
  );
  for (const state of freshAttemptStates) {
    if (!normalizedActiveStates.has(state.trim().toLowerCase())) {
      fail(
        "tracker.fresh_attempt_states",
        `contains '${state}', which is not in tracker.active_states`,
      );
    }
  }
  if (freshAttemptStates.length > 0) {
    if (
      freshAttemptFailureState === null ||
      freshAttemptFailureState.trim() === ""
    ) {
      fail(
        "tracker.fresh_attempt_failure_state",
        "is required when tracker.fresh_attempt_states is not empty",
      );
    }
    const normalizedFailureState = freshAttemptFailureState
      .trim()
      .toLowerCase();
    if (
      normalizedActiveStates.has(normalizedFailureState) ||
      normalizedTerminalStates.has(normalizedFailureState)
    ) {
      fail(
        "tracker.fresh_attempt_failure_state",
        "must not be an active or terminal state",
      );
    }
  } else if (
    freshAttemptFailureState !== null &&
    freshAttemptFailureState.trim() !== ""
  ) {
    fail(
      "tracker.fresh_attempt_failure_state",
      "requires at least one tracker.fresh_attempt_states entry",
    );
  }
  if (
    tracker["terminal_states"] === undefined &&
    profile.defaultTerminalStates === undefined
  ) {
    fail(
      "tracker.terminal_states",
      "is required because this adapter has no default",
    );
  }

  const polling = optionalObject(definition.config, "polling", "polling");
  const preparation = optionalObject(
    definition.config,
    "preparation",
    "preparation",
  );
  const repository = optionalObject(
    definition.config,
    "repository",
    "repository",
  );
  const workspace = optionalObject(definition.config, "workspace", "workspace");
  const hooks = optionalObject(definition.config, "hooks", "hooks");
  const agent = optionalObject(definition.config, "agent", "agent");
  const codex = optionalObject(definition.config, "codex", "codex");
  const codexCommand = optionalString(
    codex,
    "command",
    "codex.command",
    "codex app-server",
  );
  if (codexCommand === null || codexCommand.trim() === "") {
    fail("codex.command", "must be a non-empty string");
  }
  const workspaceProvider = optionalString(
    workspace,
    "provider",
    "workspace.provider",
    "directory",
  );
  if (
    workspaceProvider !== "directory" &&
    workspaceProvider !== "git-worktree" &&
    workspaceProvider !== "harness"
  ) {
    fail(
      "workspace.provider",
      "must be 'directory', 'git-worktree', or 'harness'",
    );
  }
  let approvalPolicy = codex["approval_policy"] ?? null;
  let threadSandbox = codex["thread_sandbox"] ?? null;
  let turnSandboxPolicy = codex["turn_sandbox_policy"] ?? null;
  if (workspaceProvider === "git-worktree") {
    if (codexCommand !== MANAGED_CODEX_COMMAND) {
      fail(
        "codex.command",
        `must remain '${MANAGED_CODEX_COMMAND}' for workspace.provider 'git-worktree'`,
      );
    }
    if (
      approvalPolicy !== null &&
      approvalPolicy !== MANAGED_CODEX_APPROVAL_POLICY
    ) {
      fail(
        "codex.approval_policy",
        `must remain '${MANAGED_CODEX_APPROVAL_POLICY}' for workspace.provider 'git-worktree'`,
      );
    }
    if (
      threadSandbox !== null &&
      threadSandbox !== MANAGED_CODEX_THREAD_SANDBOX
    ) {
      fail(
        "codex.thread_sandbox",
        `must remain '${MANAGED_CODEX_THREAD_SANDBOX}' for workspace.provider 'git-worktree'`,
      );
    }
    if (Object.hasOwn(codex, "turn_sandbox_policy")) {
      fail(
        "codex.turn_sandbox_policy",
        "is owned by Symphony for workspace.provider 'git-worktree' and must be omitted",
      );
    }
    approvalPolicy = MANAGED_CODEX_APPROVAL_POLICY;
    threadSandbox = MANAGED_CODEX_THREAD_SANDBOX;
    turnSandboxPolicy = managedCodexTurnSandboxPolicy();
  }
  const afterCreate = optionalString(
    hooks,
    "after_create",
    "hooks.after_create",
    null,
  );
  const beforeRun = optionalString(
    hooks,
    "before_run",
    "hooks.before_run",
    null,
  );
  const afterRun = optionalString(hooks, "after_run", "hooks.after_run", null);
  const beforeRemove = optionalString(
    hooks,
    "before_remove",
    "hooks.before_remove",
    null,
  );
  if (workspaceProvider === "harness") {
    if (afterCreate === null || afterCreate.trim() === "") {
      fail(
        "hooks.after_create",
        "is required for workspace.provider 'harness'",
      );
    }
    if (beforeRemove === null || beforeRemove.trim() === "") {
      fail(
        "hooks.before_remove",
        "is required for workspace.provider 'harness'",
      );
    }
  }
  if (
    workspaceProvider === "git-worktree" &&
    [afterCreate, beforeRun, afterRun, beforeRemove].some(
      (command) => command !== null,
    )
  ) {
    fail(
      "hooks",
      "must not define lifecycle commands for workspace.provider 'git-worktree'",
    );
  }

  let repositoryConfig: RepositoryConfig | null = null;
  if (
    Object.keys(repository).length > 0 ||
    workspaceProvider === "git-worktree"
  ) {
    const identity = requiredNonEmptyString(
      repository,
      "identity",
      "repository.identity",
    );
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(identity)) {
      fail("repository.identity", "must have the form owner/repository");
    }
    const hostname = requiredNonEmptyString(
      provider,
      "hostname",
      "tracker.provider.hostname",
    ).toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/u.test(hostname)) {
      fail(
        "tracker.provider.hostname",
        "must be a hostname with an optional port",
      );
    }
    const baseRef = requiredNonEmptyString(
      repository,
      "base_ref",
      "repository.base_ref",
    );
    if (
      !baseRef.startsWith("refs/heads/") &&
      !baseRef.startsWith("refs/remotes/")
    ) {
      fail(
        "repository.base_ref",
        "must be a full refs/heads/* or refs/remotes/* ref",
      );
    }
    const branchPrefix = requiredNonEmptyString(
      repository,
      "branch_prefix",
      "repository.branch_prefix",
    );
    if (
      !branchPrefix.endsWith("/") ||
      branchPrefix.startsWith("/") ||
      branchPrefix.includes("..") ||
      branchPrefix.includes("@{") ||
      branchPrefix.includes("\\")
    ) {
      fail(
        "repository.branch_prefix",
        "must be a safe relative Git namespace ending in '/'",
      );
    }
    repositoryConfig = {
      identity,
      hostname,
      baseRef,
      branchPrefix,
      profileDigest: null,
    };
    const trackerOwner = provider["owner"];
    const trackerRepository = provider["repo"];
    if (
      typeof trackerOwner === "string" &&
      typeof trackerRepository === "string" &&
      `${trackerOwner}/${trackerRepository}`.toLowerCase() !==
        identity.toLowerCase()
    ) {
      fail(
        "repository.identity",
        "must match tracker.provider owner/repo for this workflow",
      );
    }
  }

  const preparationDriver = optionalString(
    preparation,
    "driver",
    "preparation.driver",
    "none",
  );
  if (preparationDriver !== "none" && preparationDriver !== "pnpm") {
    fail("preparation.driver", "must be 'none' or 'pnpm'");
  }
  const frozenLockfile = optionalBoolean(
    preparation,
    "frozen_lockfile",
    "preparation.frozen_lockfile",
    true,
  );
  if (!frozenLockfile) {
    fail("preparation.frozen_lockfile", "must remain true");
  }
  const lifecycleScripts = optionalBoolean(
    preparation,
    "lifecycle_scripts",
    "preparation.lifecycle_scripts",
    false,
  );
  if (lifecycleScripts) {
    fail("preparation.lifecycle_scripts", "must remain false");
  }
  if (preparationDriver === "pnpm" && workspaceProvider !== "git-worktree") {
    fail(
      "preparation.driver",
      "'pnpm' requires workspace.provider 'git-worktree'",
    );
  }

  return {
    deployment: null,
    tracker: {
      kind,
      provider,
      requiredLabels,
      excludedLabels,
      activeStates,
      terminalStates,
      freshAttemptStates,
      freshAttemptFailureState,
      secretEnvironmentNames: [...profile.secretEnvironmentNames],
    },
    repository: repositoryConfig,
    preparation: {
      driver: preparationDriver,
      frozenLockfile: true,
      lifecycleScripts: false,
      timeoutMs: integer(
        preparation,
        "timeout_ms",
        "preparation.timeout_ms",
        300_000,
        (value) => value > 0,
        "must be a positive integer",
      ),
    },
    polling: {
      intervalMs: integer(
        polling,
        "interval_ms",
        "polling.interval_ms",
        30_000,
        (value) => value > 0,
        "must be a positive integer",
      ),
    },
    workspace: {
      provider: workspaceProvider,
      root: resolveWorkspaceRoot(
        optionalString(workspace, "root", "workspace.root", null),
        workflowPath,
        environment,
        homeDirectory,
        temporaryDirectory,
      ),
    },
    hooks: {
      afterCreate,
      beforeRun,
      afterRun,
      beforeRemove,
      timeoutMs: integer(
        hooks,
        "timeout_ms",
        "hooks.timeout_ms",
        60_000,
        (value) => value > 0,
        "must be a positive integer",
      ),
    },
    agent: {
      maxConcurrentAgents: integer(
        agent,
        "max_concurrent_agents",
        "agent.max_concurrent_agents",
        10,
        (value) => value > 0,
        "must be a positive integer",
      ),
      maxTurns: integer(
        agent,
        "max_turns",
        "agent.max_turns",
        20,
        (value) => value > 0,
        "must be a positive integer",
      ),
      maxRetryBackoffMs: integer(
        agent,
        "max_retry_backoff_ms",
        "agent.max_retry_backoff_ms",
        300_000,
        (value) => value >= 0,
        "must be a non-negative integer",
      ),
      maxConcurrentAgentsByState: perStateLimits(agent),
    },
    codex: {
      command: codexCommand,
      approvalPolicy,
      threadSandbox,
      turnSandboxPolicy,
      turnTimeoutMs: integer(
        codex,
        "turn_timeout_ms",
        "codex.turn_timeout_ms",
        3_600_000,
        (value) => value > 0,
        "must be a positive integer",
      ),
      readTimeoutMs: integer(
        codex,
        "read_timeout_ms",
        "codex.read_timeout_ms",
        5_000,
        (value) => value > 0,
        "must be a positive integer",
      ),
      stallTimeoutMs: integer(
        codex,
        "stall_timeout_ms",
        "codex.stall_timeout_ms",
        300_000,
        () => true,
        "must be an integer",
      ),
    },
  };
}
