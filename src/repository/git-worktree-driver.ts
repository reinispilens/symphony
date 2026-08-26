import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

import type { Issue } from "../domain/issue.js";
import { SymphonyError, errorMessage } from "../errors.js";
import { nullLogger, type Logger } from "../observability/logger.js";
import { trustedGitArguments, trustedGitEnvironment } from "./git-process.js";
import { parseRemoteIdentity } from "./remote-identity.js";
import type {
  ManagedWorkspaceLease,
  WorkSessionSnapshot,
} from "../state/model.js";
import type { SymphonyStateStore } from "../state/store.js";
import {
  assertAgentCwd,
  assertSafeExistingWorkspace,
  workspaceLocation,
} from "../workspace/path-safety.js";
import type {
  FreshAttemptPreparation,
  RepositoryAttemptAuthority,
  RepositoryCleanupAuthority,
  RepositoryDriver,
  RunHookContext,
  Workspace,
  WorkspaceLifecycleConfig,
} from "./driver.js";

const DRIVER_VERSION = 1;

interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

interface WorktreeEntry {
  readonly branch: string | null;
  readonly path: string;
}

interface ManagedLeaseLocation {
  readonly attemptId: string;
  readonly lease: ManagedWorkspaceLease;
}

type RepositoryHostConfig = Pick<
  WorkspaceLifecycleConfig,
  "deployment" | "repository" | "workflowPath" | "workspace"
>;

interface ProvisionPlan {
  readonly authority: RepositoryAttemptAuthority;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly branch: string;
  readonly freshAttemptGeneration: string | null;
  readonly gitExecutable: string;
  readonly priorLease: ManagedLeaseLocation | null;
  readonly profileDigest: string;
  readonly repositoryIdentity: string;
  readonly session: WorkSessionSnapshot;
  readonly sourceRoot: string;
  readonly workspacePath: string;
  readonly workspaceRoot: string;
  readonly workspaceKey: string;
}

export interface GitWorktreeRepositoryDriverOptions {
  readonly logger?: Logger;
  readonly now?: () => Date;
  readonly stateStore: SymphonyStateStore;
}

function refuse(message: string, cause?: unknown): never {
  throw new SymphonyError("repository_driver_refused", message, {
    ...(cause === undefined ? {} : { cause }),
  });
}

function command(
  file: string,
  args: readonly string[],
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        ...(cwd === undefined ? {} : { cwd }),
        encoding: "utf8",
        env: environment,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const exitCode =
          error === null
            ? 0
            : typeof (error as NodeJS.ErrnoException & { code?: unknown })
                  .code === "number"
              ? ((error as NodeJS.ErrnoException & { code: number }).code ?? 1)
              : 1;
        resolve({
          exitCode,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

async function gitResult(
  gitExecutable: string,
  sourceRoot: string,
  args: readonly string[],
): Promise<CommandResult> {
  return command(
    gitExecutable,
    trustedGitArguments(sourceRoot, args),
    undefined,
    trustedGitEnvironment(),
  );
}

async function git(
  gitExecutable: string,
  sourceRoot: string,
  args: readonly string[],
): Promise<string> {
  const result = await gitResult(gitExecutable, sourceRoot, args);
  if (result.exitCode !== 0) {
    throw new SymphonyError(
      "repository_driver_failed",
      `Git command failed (${args[0] ?? "unknown"}): ${result.stderr.trim() || `exit ${result.exitCode}`}`,
      {
        context: {
          git_operation: args[0] ?? "unknown",
          source_root: sourceRoot,
        },
      },
    );
  }
  return result.stdout.trim();
}

async function entryType(
  entryPath: string,
): Promise<"absent" | "directory" | "other"> {
  try {
    const entry = await lstat(entryPath);
    return entry.isDirectory() && !entry.isSymbolicLink()
      ? "directory"
      : "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function prospectiveRealPath(candidate: string): Promise<string> {
  let cursor = path.resolve(candidate);
  const suffix: string[] = [];
  while (true) {
    try {
      const entry = await lstat(cursor);
      if (!entry.isDirectory()) {
        refuse(`Workspace-root ancestor ${cursor} must be a directory`);
      }
      return path.resolve(await realpath(cursor), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function profileDigest(config: WorkspaceLifecycleConfig): string {
  if (config.repository === null) {
    refuse("Managed Git worktrees require a trusted repository profile");
  }
  if (config.repository.profileDigest !== null) {
    return config.repository.profileDigest;
  }
  const encoded = JSON.stringify({
    schemaVersion: 1,
    identity: config.repository.identity,
    hostname: config.repository.hostname,
    baseRef: config.repository.baseRef,
    branchPrefix: config.repository.branchPrefix,
    driver: "git-worktree",
    driverVersion: DRIVER_VERSION,
  });
  return `sha256:${createHash("sha256").update(encoded).digest("hex")}`;
}

function managedGitExecutable(config: RepositoryHostConfig): string {
  return config.deployment?.gitExecutable ?? "git";
}

async function resolvedSourceRoot(
  config: RepositoryHostConfig,
): Promise<string> {
  if (config.deployment !== null) {
    const configured = path.resolve(config.deployment.sourceRoot);
    const resolved = await realpath(configured);
    const root = await git(managedGitExecutable(config), resolved, [
      "rev-parse",
      "--show-toplevel",
    ]);
    if (path.resolve(root) !== resolved) {
      refuse(`Deployment source root ${resolved} is not the Git worktree root`);
    }
    return resolved;
  }
  const root = await git(
    managedGitExecutable(config),
    path.dirname(path.resolve(config.workflowPath)),
    ["rev-parse", "--show-toplevel"],
  );
  const resolved = await realpath(root);
  if (resolved.includes("\n") || resolved.includes("\0")) {
    refuse("Source root contains unsupported control characters");
  }
  return resolved;
}

async function verifyRepositoryIdentity(
  sourceRoot: string,
  config: RepositoryHostConfig,
): Promise<void> {
  if (config.repository === null) {
    refuse("Managed Git worktrees require a repository profile");
  }
  const executableFilters = await gitResult(
    managedGitExecutable(config),
    sourceRoot,
    ["config", "--get-regexp", "^filter\\..*\\.(clean|smudge|process)$"],
  );
  if (executableFilters.exitCode !== 0 && executableFilters.exitCode !== 1) {
    refuse(
      `Could not inspect repository filter configuration: ${executableFilters.stderr.trim() || `exit ${executableFilters.exitCode}`}`,
    );
  }
  if (executableFilters.stdout.trim() !== "") {
    refuse(
      "Managed repository lifecycle refuses executable Git clean/smudge/process filters",
    );
  }
  const remote = await git(managedGitExecutable(config), sourceRoot, [
    "config",
    "--get",
    "remote.origin.url",
  ]);
  const actual = parseRemoteIdentity(remote);
  if (
    actual?.hostname !== config.repository.hostname.toLowerCase() ||
    actual.repositoryIdentity.toLowerCase() !==
      config.repository.identity.toLowerCase()
  ) {
    refuse(
      `Repository origin identity does not match ${config.repository.hostname}/${config.repository.identity}`,
    );
  }
}

/** Read-only host validation that runs before Symphony creates its state directory. */
export async function preflightManagedGitHost(
  config: RepositoryHostConfig,
): Promise<void> {
  if (config.workspace.provider !== "git-worktree") return;
  if (config.repository === null) {
    refuse("Managed Git worktrees require a trusted repository profile");
  }
  const sourceRoot = await resolvedSourceRoot(config);
  const configuredWorkspaceRoot = path.resolve(config.workspace.root);
  if (
    configuredWorkspaceRoot.includes("\n") ||
    configuredWorkspaceRoot.includes("\0")
  ) {
    refuse("Workspace root contains unsupported control characters");
  }
  const workspaceRoot = await prospectiveRealPath(configuredWorkspaceRoot);
  if (
    sourceRoot === workspaceRoot ||
    isWithin(sourceRoot, workspaceRoot) ||
    isWithin(workspaceRoot, sourceRoot)
  ) {
    refuse("Source and managed-workspace roots must be disjoint");
  }
  if (config.deployment !== null) {
    const stateRoot = await prospectiveRealPath(config.deployment.stateRoot);
    if (
      sourceRoot === stateRoot ||
      workspaceRoot === stateRoot ||
      isWithin(sourceRoot, stateRoot) ||
      isWithin(stateRoot, sourceRoot) ||
      isWithin(workspaceRoot, stateRoot) ||
      isWithin(stateRoot, workspaceRoot)
    ) {
      refuse("Source, state, and managed-workspace roots must be disjoint");
    }
  }
  await verifyRepositoryIdentity(sourceRoot, config);
  const baseSha = await git(managedGitExecutable(config), sourceRoot, [
    "rev-parse",
    "--verify",
    `${config.repository.baseRef}^{commit}`,
  ]);
  if (!/^[0-9a-f]{40}$/u.test(baseSha)) {
    refuse(
      `Base ref ${config.repository.baseRef} did not resolve to a full Git SHA-1`,
    );
  }
}

function safeBranchComponent(identifier: string): string {
  const normalized = identifier
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return normalized === "" ? "work" : normalized;
}

function generationKey(generation: string): string {
  return createHash("sha256").update(generation).digest("hex").slice(0, 10);
}

function latestManagedLease(
  session: WorkSessionSnapshot,
  predicate: (lease: ManagedWorkspaceLease) => boolean = () => true,
): ManagedLeaseLocation | null {
  for (const attempt of [...session.attempts].reverse()) {
    const lease = attempt.workspaceLease;
    if (
      lease?.mode === "managed" &&
      lease.phase !== "removed" &&
      lease.phase !== "superseded" &&
      predicate(lease)
    ) {
      return { attemptId: attempt.id, lease };
    }
  }
  return null;
}

function pinnedManagedLease(
  session: WorkSessionSnapshot,
): ManagedLeaseLocation | null {
  for (const attempt of session.attempts) {
    if (attempt.workspaceLease?.mode === "managed") {
      return { attemptId: attempt.id, lease: attempt.workspaceLease };
    }
  }
  return null;
}

function parseWorktrees(source: string): readonly WorktreeEntry[] {
  return source
    .split(/\n\n+/u)
    .map((block) => block.split("\n"))
    .flatMap((lines) => {
      const worktree = lines.find((line) => line.startsWith("worktree "));
      if (worktree === undefined) return [];
      const branch = lines.find((line) => line.startsWith("branch "));
      return [
        {
          path: path.resolve(worktree.slice("worktree ".length)),
          branch: branch?.slice("branch ".length) ?? null,
        },
      ];
    });
}

/** Symphony-owned, candidate-independent Git worktree lifecycle. */
export class GitWorktreeRepositoryDriver implements RepositoryDriver {
  readonly #logger: Logger;
  readonly #now: () => Date;
  readonly #stateStore: SymphonyStateStore;

  constructor(options: GitWorktreeRepositoryDriverOptions) {
    this.#logger = options.logger ?? nullLogger;
    this.#now = options.now ?? (() => new Date());
    this.#stateStore = options.stateStore;
  }

  async prepare(
    issue: Issue,
    config: WorkspaceLifecycleConfig,
    context: RunHookContext = { attempt: null },
  ): Promise<Workspace> {
    return (await this.#provision(issue, config, null, context, true))
      .workspace;
  }

  async prepareFreshAttempt(
    issue: Issue,
    config: WorkspaceLifecycleConfig,
    generation: string,
    context: RunHookContext = { attempt: null },
  ): Promise<FreshAttemptPreparation> {
    if (generation.trim() === "") {
      refuse("Fresh-attempt generation must not be blank");
    }
    return this.#provision(issue, config, generation, context, false);
  }

  async markFreshAttemptReady(
    _issue: Issue,
    _config: WorkspaceLifecycleConfig,
    _generation: string,
    context: RunHookContext = { attempt: null },
  ): Promise<void> {
    const authority = this.#authority(context);
    const session = this.#requiredSession(authority.workSessionId);
    const attempt = session.attempts.find(
      (candidate) => candidate.id === authority.attemptId,
    );
    const lease = attempt?.workspaceLease;
    if (lease?.mode !== "managed") {
      refuse(`Attempt ${authority.attemptId} has no managed workspace lease`);
    }
    this.#stateStore.transitionManagedWorkspace({
      sessionId: session.id,
      attemptId: authority.attemptId,
      workspaceLeaseToken: lease.leaseToken,
      controllerGeneration: authority.controllerGeneration,
      runtimeLeaseToken: authority.runtimeLeaseToken,
      expectedPhases: ["provisioned", "ready"],
      phase: "ready",
      error: null,
      now: this.#timestamp(),
    });
  }

  async beforeRun(
    _issue: Issue,
    workspace: Workspace,
    config: WorkspaceLifecycleConfig,
    context: RunHookContext,
  ): Promise<void> {
    const authority = this.#authority(context);
    const session = this.#requiredSession(authority.workSessionId);
    const attempt = session.attempts.find(
      (candidate) => candidate.id === authority.attemptId,
    );
    const lease = attempt?.workspaceLease;
    if (
      lease?.mode !== "managed" ||
      lease.phase !== "ready" ||
      lease.path !== path.resolve(workspace.path)
    ) {
      refuse(`Attempt ${authority.attemptId} has no ready managed workspace`);
    }
    await assertAgentCwd(config.workspace.root, lease.path, workspace.path);
  }

  async afterRun(
    _issue: Issue,
    _workspace: Workspace,
    _config: WorkspaceLifecycleConfig,
    _context: RunHookContext,
  ): Promise<void> {
    // Product lifecycle commands are intentionally unavailable in managed mode.
  }

  async remove(
    _issue: Issue,
    config: WorkspaceLifecycleConfig,
    authority?: RepositoryCleanupAuthority,
  ): Promise<void> {
    if (authority === undefined) {
      refuse("Managed workspace cleanup requires fenced WorkSession authority");
    }
    const session = this.#requiredSession(authority.workSessionId);
    if (session.controller.generation !== authority.controllerGeneration) {
      refuse(
        `Managed workspace cleanup has stale controller generation ${authority.controllerGeneration}`,
      );
    }
    const target = latestManagedLease(
      session,
      (lease) => lease.phase !== "removed",
    );
    if (target === null) return;
    await this.#removeLease(session, target, config, null, false);
  }

  async assertAgentLaunchCwd(
    workspace: Workspace,
    config: WorkspaceLifecycleConfig,
    cwd: string,
  ): Promise<void> {
    await assertAgentCwd(config.workspace.root, workspace.path, cwd);
  }

  async #provision(
    issue: Issue,
    config: WorkspaceLifecycleConfig,
    requestedGeneration: string | null,
    context: RunHookContext,
    ordinaryReady: boolean,
  ): Promise<FreshAttemptPreparation> {
    if (config.workspace.provider !== "git-worktree") {
      refuse("Git worktree driver received a non-managed workspace profile");
    }
    const authority = this.#authority(context);
    let session = this.#requiredSession(authority.workSessionId);
    const digest = profileDigest(config);
    const gitExecutable = managedGitExecutable(config);
    const sourceRoot = await this.#sourceRoot(config);
    await this.#verifyRepositoryIdentity(sourceRoot, config);
    const workspaceRoot = await this.#workspaceRoot(config.workspace.root);
    if (
      isWithin(sourceRoot, workspaceRoot) ||
      isWithin(workspaceRoot, sourceRoot) ||
      sourceRoot === workspaceRoot
    ) {
      refuse("Source and managed-workspace roots must be disjoint");
    }
    const pinned = pinnedManagedLease(session);
    if (pinned !== null && pinned.lease.profileDigest !== digest) {
      refuse(
        `WorkSession ${session.id} is pinned to repository profile ${pinned.lease.profileDigest}, not ${digest}`,
      );
    }
    if (
      pinned !== null &&
      (pinned.lease.sourceRoot !== sourceRoot ||
        pinned.lease.workspaceRoot !== workspaceRoot)
    ) {
      refuse(
        `WorkSession ${session.id} is pinned to different repository host paths`,
      );
    }

    let prior = latestManagedLease(
      session,
      (lease) => lease.phase !== "removed",
    );

    const effectiveGeneration =
      requestedGeneration === null && prior !== null
        ? prior.lease.freshAttemptGeneration
        : requestedGeneration;
    if (
      requestedGeneration !== null &&
      prior !== null &&
      prior.lease.freshAttemptGeneration !== requestedGeneration
    ) {
      await this.#removeLease(session, prior, config, authority, true);
      session = this.#requiredSession(authority.workSessionId);
      prior = null;
    }

    const location = workspaceLocation(workspaceRoot, issue.identifier);
    const matchingPrior = latestManagedLease(
      session,
      (lease) =>
        lease.phase !== "removed" &&
        lease.path === location.path &&
        lease.freshAttemptGeneration === effectiveGeneration,
    );
    const baseRef = pinned?.lease.baseRef ?? config.repository!.baseRef;
    const baseSha =
      pinned?.lease.baseSha ??
      (await git(gitExecutable, sourceRoot, [
        "rev-parse",
        "--verify",
        `${baseRef}^{commit}`,
      ]));
    if (!/^[0-9a-f]{40}$/u.test(baseSha)) {
      refuse(`Base ref ${baseRef} did not resolve to a full Git SHA-1`);
    }
    const branch =
      matchingPrior?.lease.branch ??
      `${config.repository!.branchPrefix}${safeBranchComponent(issue.identifier)}-${session.id.slice(0, 8)}${effectiveGeneration === null ? "" : `-${generationKey(effectiveGeneration)}`}`;
    await git(gitExecutable, sourceRoot, [
      "check-ref-format",
      `refs/heads/${branch}`,
    ]);

    const plan: ProvisionPlan = {
      authority,
      baseRef,
      baseSha,
      branch,
      freshAttemptGeneration: effectiveGeneration,
      gitExecutable,
      priorLease: matchingPrior,
      profileDigest: digest,
      repositoryIdentity: config.repository!.identity,
      session,
      sourceRoot,
      workspacePath: location.path,
      workspaceRoot,
      workspaceKey: location.workspaceKey,
    };
    const begun = this.#stateStore.beginManagedWorkspace({
      sessionId: session.id,
      attemptId: authority.attemptId,
      runtimeLeaseToken: authority.runtimeLeaseToken,
      controllerGeneration: authority.controllerGeneration,
      path: plan.workspacePath,
      workspaceKey: plan.workspaceKey,
      repositoryIdentity: plan.repositoryIdentity,
      profileDigest: plan.profileDigest,
      sourceRoot: plan.sourceRoot,
      workspaceRoot: plan.workspaceRoot,
      baseRef: plan.baseRef,
      baseSha: plan.baseSha,
      branch: plan.branch,
      freshAttemptGeneration: plan.freshAttemptGeneration,
      now: this.#timestamp(),
    });

    const priorReady =
      matchingPrior?.lease.phase === "ready" &&
      matchingPrior.lease.freshAttemptGeneration === effectiveGeneration;
    const createdNow = await this.#createOrInspect(plan);
    this.#stateStore.transitionManagedWorkspace({
      sessionId: session.id,
      attemptId: authority.attemptId,
      workspaceLeaseToken: begun.workspaceLeaseToken,
      controllerGeneration: authority.controllerGeneration,
      runtimeLeaseToken: authority.runtimeLeaseToken,
      expectedPhases: ["allocating", "provisioned"],
      phase: "provisioned",
      error: null,
      now: this.#timestamp(),
    });
    if (ordinaryReady || priorReady) {
      this.#stateStore.transitionManagedWorkspace({
        sessionId: session.id,
        attemptId: authority.attemptId,
        workspaceLeaseToken: begun.workspaceLeaseToken,
        controllerGeneration: authority.controllerGeneration,
        runtimeLeaseToken: authority.runtimeLeaseToken,
        expectedPhases: ["provisioned", "ready"],
        phase: "ready",
        error: null,
        now: this.#timestamp(),
      });
    }

    return {
      resetWorkpad: !ordinaryReady && !priorReady,
      workspace: {
        createdNow,
        path: plan.workspacePath,
        workspaceKey: plan.workspaceKey,
      },
    };
  }

  async #createOrInspect(plan: ProvisionPlan): Promise<boolean> {
    const effect = this.#stateStore.enqueueEffect({
      sessionId: plan.session.id,
      controllerGeneration: plan.authority.controllerGeneration,
      kind: "git.create_worktree",
      idempotencyKey: `workspace:create:${plan.branch}`,
      payload: {
        source_root: plan.sourceRoot,
        workspace_path: plan.workspacePath,
        branch: plan.branch,
        base_sha: plan.baseSha,
      },
      now: this.#timestamp(),
    });
    if (effect.status === "failed") {
      refuse(`Managed workspace creation effect ${effect.id} is failed`);
    }

    const inspection = await this.#inspect(
      plan.gitExecutable,
      plan.sourceRoot,
      plan.workspacePath,
    );
    let createdNow = false;
    if (inspection.type === "absent") {
      if (effect.status === "applied") {
        refuse(
          `Applied creation effect ${effect.id} no longer has workspace ${plan.workspacePath}`,
        );
      }
      const branchExists =
        (
          await gitResult(plan.gitExecutable, plan.sourceRoot, [
            "show-ref",
            "--verify",
            "--quiet",
            `refs/heads/${plan.branch}`,
          ])
        ).exitCode === 0;
      if (branchExists && plan.priorLease === null) {
        refuse(
          `Branch ${plan.branch} exists without a matching Symphony workspace lease`,
        );
      }
      await git(
        plan.gitExecutable,
        plan.sourceRoot,
        branchExists
          ? ["worktree", "add", plan.workspacePath, plan.branch]
          : [
              "worktree",
              "add",
              "-b",
              plan.branch,
              plan.workspacePath,
              plan.baseSha,
            ],
      );
      createdNow = true;
    } else if (inspection.type === "other") {
      refuse(`Workspace path ${plan.workspacePath} is not a real directory`);
    } else if (plan.priorLease === null) {
      refuse(
        `Workspace ${plan.workspacePath} exists without matching Symphony authority`,
      );
    }

    await this.#assertMatchingWorktree(
      plan.gitExecutable,
      plan.sourceRoot,
      plan.workspaceRoot,
      plan.workspacePath,
      plan.branch,
    );
    if (effect.status === "pending") {
      this.#stateStore.finishEffect({
        effectId: effect.id,
        controllerGeneration: plan.authority.controllerGeneration,
        status: "applied",
        result: { workspace_path: plan.workspacePath, branch: plan.branch },
        now: this.#timestamp(),
      });
    }
    return createdNow;
  }

  async #removeLease(
    session: WorkSessionSnapshot,
    target: ManagedLeaseLocation,
    config: WorkspaceLifecycleConfig,
    actor: RepositoryAttemptAuthority | null,
    force: boolean,
  ): Promise<void> {
    const lease = target.lease;
    if (
      config.repository === null ||
      profileDigest(config) !== lease.profileDigest
    ) {
      refuse(
        `Cleanup profile does not match workspace lease ${lease.leaseToken}`,
      );
    }
    const gitExecutable = managedGitExecutable(config);
    const sourceRoot = await this.#sourceRoot(config);
    const workspaceRoot = await this.#workspaceRoot(config.workspace.root);
    if (
      sourceRoot !== lease.sourceRoot ||
      workspaceRoot !== lease.workspaceRoot ||
      workspaceLocation(workspaceRoot, path.basename(lease.path)).path !==
        lease.path
    ) {
      refuse(`Host paths no longer match workspace lease ${lease.leaseToken}`);
    }
    await this.#verifyRepositoryIdentity(sourceRoot, config);

    this.#stateStore.transitionManagedWorkspace({
      sessionId: session.id,
      attemptId: target.attemptId,
      workspaceLeaseToken: lease.leaseToken,
      controllerGeneration: session.controller.generation,
      runtimeLeaseToken: actor?.runtimeLeaseToken ?? null,
      ...(actor === null ? {} : { runtimeAttemptId: actor.attemptId }),
      expectedPhases: [
        "allocating",
        "provisioned",
        "ready",
        "removal_pending",
        "retained",
      ],
      phase: "removal_pending",
      error: null,
      now: this.#timestamp(),
    });
    const effect = this.#stateStore.enqueueEffect({
      sessionId: session.id,
      controllerGeneration: session.controller.generation,
      kind: "git.remove_worktree",
      idempotencyKey: `workspace:remove:${lease.branch}`,
      payload: {
        source_root: lease.sourceRoot,
        workspace_path: lease.path,
        branch: lease.branch,
        force,
      },
      now: this.#timestamp(),
    });
    try {
      let inspection = await this.#inspect(
        gitExecutable,
        lease.sourceRoot,
        lease.path,
      );
      if (effect.status === "failed") {
        refuse(`Managed workspace removal effect ${effect.id} is failed`);
      }
      if (effect.status === "applied" && inspection.type !== "absent") {
        refuse(
          `Applied removal effect ${effect.id} still has workspace ${lease.path}`,
        );
      }
      if (effect.status === "applied") {
        const branchStillExists =
          (
            await gitResult(gitExecutable, lease.sourceRoot, [
              "show-ref",
              "--verify",
              "--quiet",
              `refs/heads/${lease.branch}`,
            ])
          ).exitCode === 0;
        if (branchStillExists) {
          refuse(
            `Applied removal effect ${effect.id} still has branch ${lease.branch}`,
          );
        }
      }
      if (inspection.type === "other") {
        refuse(
          `Refusing to remove non-directory workspace entry ${lease.path}`,
        );
      }
      if (inspection.type === "directory") {
        await this.#assertMatchingWorktree(
          gitExecutable,
          lease.sourceRoot,
          lease.workspaceRoot,
          lease.path,
          lease.branch,
        );
        if (!force) {
          const dirty = await git(gitExecutable, lease.path, [
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
          ]);
          if (dirty !== "") {
            refuse(
              `Managed workspace ${lease.path} is dirty; retaining it for operator review`,
            );
          }
        }
      }
      if (inspection.type !== "absent" || inspection.registered) {
        await git(gitExecutable, lease.sourceRoot, [
          "worktree",
          "remove",
          ...(force || inspection.type === "absent" ? ["--force"] : []),
          lease.path,
        ]);
      }
      inspection = await this.#inspect(
        gitExecutable,
        lease.sourceRoot,
        lease.path,
      );
      if (inspection.type !== "absent" || inspection.registered) {
        refuse(`Git did not fully remove managed workspace ${lease.path}`);
      }

      const branchRef = `refs/heads/${lease.branch}`;
      const branchExists =
        (
          await gitResult(gitExecutable, lease.sourceRoot, [
            "show-ref",
            "--verify",
            "--quiet",
            branchRef,
          ])
        ).exitCode === 0;
      if (branchExists) {
        const worktrees = parseWorktrees(
          await git(gitExecutable, lease.sourceRoot, [
            "worktree",
            "list",
            "--porcelain",
          ]),
        );
        if (worktrees.some((entry) => entry.branch === branchRef)) {
          refuse(
            `Branch ${lease.branch} is still checked out in another worktree`,
          );
        }
        await git(gitExecutable, lease.sourceRoot, [
          "branch",
          "-D",
          lease.branch,
        ]);
      }
      if (effect.status === "pending") {
        this.#stateStore.finishEffect({
          effectId: effect.id,
          controllerGeneration: session.controller.generation,
          status: "applied",
          result: { workspace_path: lease.path, branch_removed: true },
          now: this.#timestamp(),
        });
      }
      this.#stateStore.transitionManagedWorkspace({
        sessionId: session.id,
        attemptId: target.attemptId,
        workspaceLeaseToken: lease.leaseToken,
        controllerGeneration: session.controller.generation,
        runtimeLeaseToken: actor?.runtimeLeaseToken ?? null,
        ...(actor === null ? {} : { runtimeAttemptId: actor.attemptId }),
        expectedPhases: ["removal_pending", "removed"],
        phase: "removed",
        error: null,
        now: this.#timestamp(),
      });
      this.#logger.info("managed_workspace outcome=removed", {
        work_session_id: session.id,
        workspace_path: lease.path,
        branch: lease.branch,
      });
    } catch (error) {
      try {
        this.#stateStore.transitionManagedWorkspace({
          sessionId: session.id,
          attemptId: target.attemptId,
          workspaceLeaseToken: lease.leaseToken,
          controllerGeneration: session.controller.generation,
          runtimeLeaseToken: actor?.runtimeLeaseToken ?? null,
          ...(actor === null ? {} : { runtimeAttemptId: actor.attemptId }),
          expectedPhases: ["removal_pending", "retained"],
          phase: "retained",
          error: errorMessage(error),
          now: this.#timestamp(),
        });
      } catch {
        // Preserve the original refusal; a stale fence is already observable.
      }
      throw error;
    }
  }

  async #inspect(
    gitExecutable: string,
    sourceRoot: string,
    workspacePath: string,
  ): Promise<
    | { readonly type: "absent"; readonly registered: boolean }
    | {
        readonly type: "directory";
        readonly branch: string | null;
        readonly registered: true;
      }
    | { readonly type: "other"; readonly registered: boolean }
  > {
    const type = await entryType(workspacePath);
    const worktrees = parseWorktrees(
      await git(gitExecutable, sourceRoot, ["worktree", "list", "--porcelain"]),
    );
    const registered = worktrees.find(
      (entry) => entry.path === path.resolve(workspacePath),
    );
    if (type === "absent") {
      return { type, registered: registered !== undefined };
    }
    if (type === "other") {
      return { type, registered: registered !== undefined };
    }
    if (registered === undefined) {
      return { type: "other", registered: false };
    }
    return { type, registered: true, branch: registered.branch };
  }

  async #assertMatchingWorktree(
    gitExecutable: string,
    sourceRoot: string,
    workspaceRoot: string,
    workspacePath: string,
    branch: string,
  ): Promise<void> {
    await assertSafeExistingWorkspace(workspaceRoot, workspacePath);
    const inspection = await this.#inspect(
      gitExecutable,
      sourceRoot,
      workspacePath,
    );
    if (
      inspection.type !== "directory" ||
      inspection.branch !== `refs/heads/${branch}`
    ) {
      refuse(
        `Workspace ${workspacePath} is not the registered ${branch} Git worktree`,
      );
    }
    const [workspaceTop, workspaceCommon, sourceCommon] = await Promise.all([
      git(gitExecutable, workspacePath, ["rev-parse", "--show-toplevel"]),
      git(gitExecutable, workspacePath, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]),
      git(gitExecutable, sourceRoot, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]),
    ]);
    if (
      path.resolve(workspaceTop) !== path.resolve(workspacePath) ||
      path.resolve(workspaceCommon) !== path.resolve(sourceCommon)
    ) {
      refuse(`Workspace ${workspacePath} does not belong to ${sourceRoot}`);
    }
  }

  async #sourceRoot(config: WorkspaceLifecycleConfig): Promise<string> {
    return resolvedSourceRoot(config);
  }

  async #workspaceRoot(configuredRoot: string): Promise<string> {
    const normalized = path.resolve(configuredRoot);
    if (normalized.includes("\n") || normalized.includes("\0")) {
      refuse("Workspace root contains unsupported control characters");
    }
    await mkdir(normalized, { recursive: true, mode: 0o700 });
    const entry = await lstat(normalized);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      refuse(`Workspace root ${normalized} must be a real directory`);
    }
    return realpath(normalized);
  }

  async #verifyRepositoryIdentity(
    sourceRoot: string,
    config: WorkspaceLifecycleConfig,
  ): Promise<void> {
    await verifyRepositoryIdentity(sourceRoot, config);
  }

  #authority(context: RunHookContext): RepositoryAttemptAuthority {
    if (context.authority === undefined) {
      refuse("Managed Git worktrees require a fenced attempt authority");
    }
    return context.authority;
  }

  #requiredSession(sessionId: string): WorkSessionSnapshot {
    const session = this.#stateStore.getSession(sessionId);
    if (session === null) refuse(`WorkSession ${sessionId} does not exist`);
    return session;
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }
}
