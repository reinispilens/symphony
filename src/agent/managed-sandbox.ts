import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  realpath,
  rm,
  rmdir,
} from "node:fs/promises";
import path from "node:path";

import { SymphonyError } from "../errors.js";
import type {
  RepositoryAttemptAuthority,
  RepositoryCleanupAuthority,
  WorkspaceLifecycleConfig,
} from "../repository/driver.js";
import { managedCodexTurnSandboxPolicy } from "../security/managed-codex-policy.js";
import type { JsonObject } from "../shared/json.js";
import type { ManagedProcessContainmentConfig } from "../workflow/config.js";
import type { DirectAppServerCommand } from "./process-transport.js";
import {
  openSystemdUserScope,
  quiesceSystemdUserScope,
  type SystemdUserScope,
} from "./systemd-user-scope.js";

const RUNTIME_DIRECTORY = "agent-runtime";

export interface ManagedCodexSandbox {
  readonly command: DirectAppServerCommand;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly turnSandboxPolicy: JsonObject;
  quiesce(): Promise<void>;
  cleanup(): Promise<void>;
}

function component(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function strictChild(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function refusal(message: string, cause?: unknown): SymphonyError {
  return new SymphonyError("agent_sandbox_refused", message, {
    ...(cause === undefined ? {} : { cause }),
  });
}

async function realDirectory(
  directory: string,
  label: string,
): Promise<string> {
  try {
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw refusal(`${label} must be a real directory`);
    }
    return await realpath(directory);
  } catch (error) {
    if (error instanceof SymphonyError) throw error;
    throw refusal(`Could not inspect ${label}`, error);
  }
}

async function privateChild(
  realParent: string,
  name: string,
  label: string,
  fresh = false,
): Promise<string> {
  const candidate = path.join(realParent, name);
  try {
    await mkdir(candidate, { mode: 0o700 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" || fresh) {
      throw refusal(`Could not create ${label}`, error);
    }
  }
  const resolved = await realDirectory(candidate, label);
  if (!strictChild(realParent, resolved)) {
    throw refusal(`${label} escaped its Symphony-owned parent`);
  }
  await chmod(resolved, 0o700);
  return resolved;
}

async function runtimeRoot(config: WorkspaceLifecycleConfig): Promise<string> {
  if (config.deployment !== null) {
    const stateRoot = await realDirectory(
      config.deployment.stateRoot,
      "Symphony state root",
    );
    return privateChild(stateRoot, RUNTIME_DIRECTORY, "agent runtime root");
  }
  const workspaceRoot = await realDirectory(
    path.resolve(config.workspace.root),
    "managed workspace root",
  );
  const stateRoot = await realDirectory(
    path.join(workspaceRoot, ".symphony"),
    "Symphony state directory",
  );
  if (!strictChild(workspaceRoot, stateRoot)) {
    throw refusal(
      "Symphony state directory escaped the managed workspace root",
    );
  }
  return privateChild(stateRoot, RUNTIME_DIRECTORY, "agent runtime root");
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

async function resolveManagedCodexCommand(
  config: WorkspaceLifecycleConfig,
  workspacePath: string,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<DirectAppServerCommand> {
  const sourceRoot =
    config.deployment?.sourceRoot ?? path.dirname(config.workflowPath);
  const forbiddenRoots = await Promise.all([
    realDirectory(sourceRoot, "trusted product source root"),
    realDirectory(config.workspace.root, "managed workspace root"),
    realDirectory(workspacePath, "managed Attempt workspace"),
    ...(config.deployment === null
      ? []
      : [realDirectory(config.deployment.stateRoot, "Symphony state root")]),
  ]);
  if (config.deployment !== null) {
    const configured = path.resolve(config.deployment.codexExecutable);
    try {
      await access(configured, fsConstants.X_OK);
      const resolved = await realpath(configured);
      const entry = await lstat(resolved);
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw refusal("Deployment Codex executable must be a regular file");
      }
      if (forbiddenRoots.some((root) => insideOrEqual(root, resolved))) {
        throw refusal(
          "Deployment Codex executable must be outside product, state, and workspace roots",
        );
      }
      return { executable: resolved, args: ["app-server"] };
    } catch (error) {
      if (error instanceof SymphonyError) throw error;
      throw refusal("Could not use the deployment Codex executable", error);
    }
  }

  const searchPath = environment["PATH"] ?? "";
  for (const directory of searchPath.split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, "codex");
    try {
      await access(candidate, fsConstants.X_OK);
      const resolved = await realpath(candidate);
      const entry = await lstat(resolved);
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      if (forbiddenRoots.some((root) => insideOrEqual(root, resolved))) {
        continue;
      }
      return { executable: resolved, args: ["app-server"] };
    } catch {
      // Try the next absolute PATH directory.
    }
  }
  throw refusal(
    "Could not resolve a trusted Codex executable outside the workflow source and managed workspace roots",
  );
}

async function resolveManagedProcessContainment(
  config: WorkspaceLifecycleConfig,
  workspacePath: string,
): Promise<ManagedProcessContainmentConfig | null> {
  if (config.deployment === null) return null;
  const forbiddenRoots = await Promise.all([
    realDirectory(config.deployment.sourceRoot, "trusted product source root"),
    realDirectory(config.workspace.root, "managed workspace root"),
    realDirectory(workspacePath, "managed Attempt workspace"),
    realDirectory(config.deployment.stateRoot, "Symphony state root"),
  ]);
  const trustedExecutable = async (
    configuredPath: string,
    label: string,
  ): Promise<string> => {
    const configured = path.resolve(configuredPath);
    try {
      await access(configured, fsConstants.X_OK);
      const resolved = await realpath(configured);
      const entry = await lstat(resolved);
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw refusal(`${label} must be a regular file`);
      }
      if (forbiddenRoots.some((root) => insideOrEqual(root, resolved))) {
        throw refusal(
          `${label} must be outside product, state, and workspace roots`,
        );
      }
      return resolved;
    } catch (error) {
      if (error instanceof SymphonyError) throw error;
      throw refusal(`Could not use ${label}`, error);
    }
  };
  const [systemdRunExecutable, systemctlExecutable] = await Promise.all([
    trustedExecutable(
      config.deployment.processContainment.systemdRunExecutable,
      "Deployment systemd-run executable",
    ),
    trustedExecutable(
      config.deployment.processContainment.systemctlExecutable,
      "Deployment systemctl executable",
    ),
  ]);
  return {
    ...config.deployment.processContainment,
    systemdRunExecutable,
    systemctlExecutable,
  };
}

async function removeEmpty(directory: string): Promise<void> {
  try {
    await rmdir(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
  }
}

export async function openManagedCodexSandbox(
  config: WorkspaceLifecycleConfig,
  authority: RepositoryAttemptAuthority | undefined,
  sourceEnvironment: Readonly<Record<string, string | undefined>>,
  workspacePath: string,
): Promise<ManagedCodexSandbox | null> {
  if (config.workspace.provider !== "git-worktree") return null;
  if (authority === undefined) {
    throw refusal("Managed Codex execution requires fenced Attempt authority");
  }

  const [root, command, containment] = await Promise.all([
    runtimeRoot(config),
    resolveManagedCodexCommand(config, workspacePath, sourceEnvironment),
    resolveManagedProcessContainment(config, workspacePath),
  ]);
  const session = await privateChild(
    root,
    component(authority.workSessionId),
    "agent runtime session directory",
  );
  const attempt = await privateChild(
    session,
    component(authority.attemptId),
    "agent runtime attempt directory",
  );
  const runtime = await privateChild(
    attempt,
    component(authority.runtimeLeaseToken),
    "agent runtime lease directory",
    true,
  );
  let processScope: SystemdUserScope | null = null;
  try {
    processScope =
      containment === null
        ? null
        : await openSystemdUserScope(
            containment,
            authority,
            command,
            sourceEnvironment,
          );
  } catch (error) {
    await rm(runtime, { recursive: true, force: true });
    await removeEmpty(attempt);
    await removeEmpty(session);
    await removeEmpty(root);
    throw error;
  }
  let cleaned = false;
  let quiesced = processScope === null;

  return {
    command: processScope?.command ?? command,
    environment: {
      ...sourceEnvironment,
      TMPDIR: runtime,
      TEMP: runtime,
      TMP: runtime,
    },
    turnSandboxPolicy: managedCodexTurnSandboxPolicy([runtime]),
    quiesce: async () => {
      if (quiesced) return;
      await processScope!.quiesce();
      quiesced = true;
    },
    cleanup: async () => {
      if (cleaned) return;
      if (!quiesced) {
        throw new SymphonyError(
          "runtime_quiescence_refused",
          "Managed Codex runtime state cannot be removed before its process scope is quiescent",
        );
      }
      cleaned = true;
      await rm(runtime, { recursive: true, force: true });
      await removeEmpty(attempt);
      await removeEmpty(session);
      await removeEmpty(root);
    },
  };
}

export async function cleanupManagedCodexSandboxSession(
  config: WorkspaceLifecycleConfig,
  authority: RepositoryCleanupAuthority | undefined,
  sourceEnvironment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  if (config.workspace.provider !== "git-worktree" || authority === undefined) {
    return;
  }
  if (config.deployment !== null) {
    await quiesceSystemdUserScope(
      config.deployment.processContainment,
      authority,
      sourceEnvironment,
    );
  }
  const root = await runtimeRoot(config);
  const session = path.join(root, component(authority.workSessionId));
  try {
    const entry = await lstat(session);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw refusal("Agent runtime session path must remain a real directory");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if (error instanceof SymphonyError) throw error;
    throw refusal("Could not inspect agent runtime session path", error);
  }
  await rm(session, { recursive: true, force: true });
  await removeEmpty(root);
}
