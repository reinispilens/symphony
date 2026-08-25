import { mkdir, lstat, rm } from "node:fs/promises";
import path from "node:path";

import type { Issue } from "../domain/issue.js";
import { SymphonyError } from "../errors.js";
import { nullLogger, type Logger } from "../observability/logger.js";
import type {
  FreshAttemptPreparation,
  RepositoryDriver,
  RunHookContext,
  Workspace,
  WorkspaceLifecycleConfig,
} from "../repository/driver.js";
import { redactEnvironmentSecrets } from "../security/secrets.js";
import { HookRunner, type HookName, type HookResult } from "./hook-runner.js";
import {
  assertAgentCwd,
  assertSafeExistingWorkspace,
  workspaceLocation,
} from "./path-safety.js";
import {
  readFreshAttemptReceipt,
  removeFreshAttemptReceipt,
  writeFreshAttemptReceipt,
  type FreshAttemptReceipt,
} from "./fresh-attempt.js";

export type {
  FreshAttemptPreparation,
  RunHookContext,
  Workspace,
  WorkspaceLifecycleConfig,
} from "../repository/driver.js";

export interface WorkspaceManagerOptions {
  readonly hookRunner?: HookRunner;
  readonly logger?: Logger;
  readonly processEnvironment?: Readonly<Record<string, string | undefined>>;
}

function processEnvironment(
  base: Readonly<Record<string, string | undefined>>,
  additions: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries({ ...base, ...additions }).filter(
      (entry): entry is [string, string] => {
        return entry[1] !== undefined;
      },
    ),
  );
}

async function pathType(
  workspacePath: string,
): Promise<"absent" | "directory" | "other"> {
  try {
    const entry = await lstat(workspacePath);
    return entry.isDirectory() && !entry.isSymbolicLink()
      ? "directory"
      : "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
}

/** Transitional directory and repository-hook compatibility driver. */
export class WorkspaceManager implements RepositoryDriver {
  readonly #hookRunner: HookRunner;
  readonly #logger: Logger;
  readonly #processEnvironment: Readonly<Record<string, string | undefined>>;

  constructor(options: WorkspaceManagerOptions = {}) {
    this.#logger = options.logger ?? nullLogger;
    this.#hookRunner =
      options.hookRunner ?? new HookRunner({ logger: this.#logger });
    this.#processEnvironment = options.processEnvironment ?? process.env;
  }

  async prepare(
    issue: Issue,
    config: WorkspaceLifecycleConfig,
    context: RunHookContext = { attempt: null },
  ): Promise<Workspace> {
    await mkdir(config.workspace.root, { recursive: true });
    const location = workspaceLocation(config.workspace.root, issue.identifier);
    const existingType = await pathType(location.path);
    if (existingType === "other") {
      throw new SymphonyError(
        "workspace_not_directory",
        `Workspace path ${location.path} already exists and is not a directory`,
        {
          context: {
            issue_id: issue.id,
            issue_identifier: issue.identifier,
            workspace_path: location.path,
          },
        },
      );
    }

    let createdNow = false;
    if (existingType === "absent") {
      try {
        await mkdir(location.path);
        createdNow = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }

    await assertSafeExistingWorkspace(location.root, location.path);
    const workspace: Workspace = {
      createdNow,
      path: location.path,
      workspaceKey: location.workspaceKey,
    };

    if (createdNow && config.hooks.afterCreate !== null) {
      try {
        await this.#runRequiredHook(
          "after_create",
          config.hooks.afterCreate,
          issue,
          workspace,
          config,
          context,
        );
      } catch (error) {
        const failedPathType = await pathType(location.path);
        if (
          config.workspace.provider === "harness" &&
          failedPathType === "directory"
        ) {
          if (config.hooks.beforeRemove !== null) {
            await this.#runIgnoredHook(
              "before_remove",
              config.hooks.beforeRemove,
              issue,
              workspace,
              config,
              {
                ...context,
                status: "after_create_failed",
              },
            );
          }
          if ((await pathType(location.path)) !== "absent") {
            this.#logger.warn(
              "Retaining harness-owned workspace after failed creation",
              {
                issue_id: issue.id,
                issue_identifier: issue.identifier,
                workspace_path: location.path,
              },
            );
          }
        } else if (failedPathType === "directory") {
          await assertSafeExistingWorkspace(location.root, location.path);
          await rm(location.path, { recursive: true, force: false });
        } else if (failedPathType === "other") {
          this.#logger.error(
            "Failed after_create hook left an unsafe workspace entry; retaining it",
            {
              issue_id: issue.id,
              issue_identifier: issue.identifier,
              workspace_path: location.path,
            },
          );
        }
        throw error;
      }
    }

    return workspace;
  }

  async prepareFreshAttempt(
    issue: Issue,
    config: WorkspaceLifecycleConfig,
    generation: string,
    _context?: RunHookContext,
  ): Promise<FreshAttemptPreparation> {
    if (generation.trim() === "") {
      throw new SymphonyError(
        "fresh_attempt_invalid",
        "Fresh-attempt generation must be a non-empty string",
      );
    }
    const location = workspaceLocation(config.workspace.root, issue.identifier);
    const receipt = await readFreshAttemptReceipt(
      config.workspace.root,
      issue.id,
    );
    if (receipt !== null) this.#assertReceiptIdentity(receipt, issue, location);

    if (receipt?.generation === generation) {
      if ((await pathType(location.path)) !== "directory") {
        throw new SymphonyError(
          "fresh_attempt_invalid",
          `Fresh-attempt receipt exists but workspace ${location.path} is unavailable`,
        );
      }
      await assertSafeExistingWorkspace(location.root, location.path);
      return {
        resetWorkpad: receipt.phase === "provisioned",
        workspace: {
          createdNow: false,
          path: location.path,
          workspaceKey: location.workspaceKey,
        },
      };
    }

    await this.#resetForFreshAttempt(issue, config, generation);
    const workspace = await this.prepare(issue, config, {
      attempt: null,
      generation,
      status: "fresh_attempt_provision",
    });
    await writeFreshAttemptReceipt(config.workspace.root, {
      schema_version: 1,
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      workspace_key: workspace.workspaceKey,
      generation,
      phase: "provisioned",
    });
    return { resetWorkpad: true, workspace };
  }

  async markFreshAttemptReady(
    issue: Issue,
    config: WorkspaceLifecycleConfig,
    generation: string,
    _context?: RunHookContext,
  ): Promise<void> {
    const location = workspaceLocation(config.workspace.root, issue.identifier);
    const receipt = await readFreshAttemptReceipt(
      config.workspace.root,
      issue.id,
    );
    if (receipt === null) {
      throw new SymphonyError(
        "fresh_attempt_invalid",
        "Cannot mark a fresh attempt ready without a provisioning receipt",
      );
    }
    this.#assertReceiptIdentity(receipt, issue, location);
    if (receipt.generation !== generation) {
      throw new SymphonyError(
        "fresh_attempt_invalid",
        "Cannot mark a different fresh-attempt generation ready",
      );
    }
    if ((await pathType(location.path)) !== "directory") {
      throw new SymphonyError(
        "fresh_attempt_invalid",
        `Cannot mark fresh attempt ready because ${location.path} is unavailable`,
      );
    }
    await writeFreshAttemptReceipt(config.workspace.root, {
      ...receipt,
      phase: "ready",
    });
  }

  async beforeRun(
    issue: Issue,
    workspace: Workspace,
    config: WorkspaceLifecycleConfig,
    context: RunHookContext,
  ): Promise<void> {
    await assertSafeExistingWorkspace(config.workspace.root, workspace.path);
    if (config.hooks.beforeRun !== null) {
      await this.#runRequiredHook(
        "before_run",
        config.hooks.beforeRun,
        issue,
        workspace,
        config,
        context,
      );
    }
  }

  async afterRun(
    issue: Issue,
    workspace: Workspace,
    config: WorkspaceLifecycleConfig,
    context: RunHookContext,
  ): Promise<void> {
    await assertSafeExistingWorkspace(config.workspace.root, workspace.path);
    if (config.hooks.afterRun !== null) {
      await this.#runIgnoredHook(
        "after_run",
        config.hooks.afterRun,
        issue,
        workspace,
        config,
        context,
      );
    }
  }

  async remove(issue: Issue, config: WorkspaceLifecycleConfig): Promise<void> {
    const location = workspaceLocation(config.workspace.root, issue.identifier);
    if ((await pathType(location.path)) === "absent") {
      await removeFreshAttemptReceipt(config.workspace.root, issue.id);
      return;
    }
    await assertSafeExistingWorkspace(location.root, location.path);
    const workspace: Workspace = {
      createdNow: false,
      path: location.path,
      workspaceKey: location.workspaceKey,
    };
    let beforeRemoveSucceeded = true;
    if (config.hooks.beforeRemove !== null) {
      beforeRemoveSucceeded = await this.#runIgnoredHook(
        "before_remove",
        config.hooks.beforeRemove,
        issue,
        workspace,
        config,
        { attempt: null },
      );
    }

    if (config.workspace.provider === "harness") {
      const remaining = await pathType(location.path);
      if (!beforeRemoveSucceeded || remaining !== "absent") {
        this.#logger.warn(
          "Harness-owned workspace was retained because teardown did not remove it",
          {
            issue_id: issue.id,
            issue_identifier: issue.identifier,
            workspace_path: location.path,
            workspace_entry_type: remaining,
          },
        );
      }
      if (remaining === "absent") {
        await removeFreshAttemptReceipt(config.workspace.root, issue.id);
      }
      return;
    }

    if ((await pathType(location.path)) === "absent") return;
    await assertSafeExistingWorkspace(location.root, location.path);
    await rm(location.path, { recursive: true, force: false });
    await removeFreshAttemptReceipt(config.workspace.root, issue.id);
  }

  async assertAgentLaunchCwd(
    workspace: Workspace,
    config: WorkspaceLifecycleConfig,
    cwd: string,
  ): Promise<void> {
    await assertAgentCwd(config.workspace.root, workspace.path, cwd);
  }

  async #runRequiredHook(
    name: HookName,
    command: string,
    issue: Issue,
    workspace: Workspace,
    config: WorkspaceLifecycleConfig,
    context: RunHookContext,
  ): Promise<HookResult> {
    const result = await this.#runHook(
      name,
      command,
      issue,
      workspace,
      config,
      context,
    );
    if (result.timedOut) {
      throw new SymphonyError(
        "hook_timeout",
        `${name} hook timed out after ${config.hooks.timeoutMs}ms`,
        {
          context: this.#errorContext(name, issue, workspace, result, config),
        },
      );
    }
    if (result.exitCode !== 0) {
      throw new SymphonyError(
        "hook_failed",
        `${name} hook exited with status ${String(result.exitCode)}`,
        {
          context: this.#errorContext(name, issue, workspace, result, config),
        },
      );
    }
    return result;
  }

  async #runIgnoredHook(
    name: HookName,
    command: string,
    issue: Issue,
    workspace: Workspace,
    config: WorkspaceLifecycleConfig,
    context: RunHookContext,
  ): Promise<boolean> {
    try {
      const result = await this.#runHook(
        name,
        command,
        issue,
        workspace,
        config,
        context,
      );
      if (result.timedOut || result.exitCode !== 0) {
        this.#logger.warn("Ignoring non-fatal workspace hook failure", {
          ...this.#errorContext(name, issue, workspace, result, config),
        });
        return false;
      }
      return true;
    } catch (error) {
      this.#logger.warn("Ignoring non-fatal workspace hook launch failure", {
        hook: name,
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        workspace_path: workspace.path,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async #runHook(
    name: HookName,
    command: string,
    issue: Issue,
    workspace: Workspace,
    config: WorkspaceLifecycleConfig,
    context: RunHookContext,
  ): Promise<HookResult> {
    const workflowPath = path.resolve(config.workflowPath);
    return this.#hookRunner.run({
      command,
      cwd: workspace.path,
      environment: processEnvironment(this.#processEnvironment, {
        SYMPHONY_ATTEMPT:
          context.attempt === null ? "" : String(context.attempt),
        SYMPHONY_ATTEMPT_GENERATION: context.generation ?? "",
        SYMPHONY_ISSUE_BRANCH_NAME: issue.branch_name ?? "",
        SYMPHONY_ISSUE_ID: issue.id,
        SYMPHONY_ISSUE_IDENTIFIER: issue.identifier,
        SYMPHONY_RUN_STATUS: context.status ?? "",
        SYMPHONY_WORKFLOW_DIR: path.dirname(workflowPath),
        SYMPHONY_WORKFLOW_PATH: workflowPath,
        SYMPHONY_WORKSPACE_KEY: workspace.workspaceKey,
        SYMPHONY_WORKSPACE_PATH: workspace.path,
      }),
      logFields: {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
      },
      name,
      timeoutMs: config.hooks.timeoutMs,
    });
  }

  async #resetForFreshAttempt(
    issue: Issue,
    config: WorkspaceLifecycleConfig,
    generation: string,
  ): Promise<void> {
    const location = workspaceLocation(config.workspace.root, issue.identifier);
    const existing = await pathType(location.path);
    if (existing === "absent") return;
    if (existing === "other") {
      throw new SymphonyError(
        "workspace_not_directory",
        `Workspace path ${location.path} already exists and is not a directory`,
      );
    }
    await assertSafeExistingWorkspace(location.root, location.path);
    const workspace: Workspace = {
      createdNow: false,
      path: location.path,
      workspaceKey: location.workspaceKey,
    };
    if (config.hooks.beforeRemove !== null) {
      await this.#runRequiredHook(
        "before_remove",
        config.hooks.beforeRemove,
        issue,
        workspace,
        config,
        {
          attempt: null,
          generation,
          status: "fresh_attempt_reset",
        },
      );
    }

    if (config.workspace.provider === "harness") {
      if ((await pathType(location.path)) !== "absent") {
        throw new SymphonyError(
          "fresh_attempt_reset_failed",
          `Repository harness did not remove ${location.path} for the fresh attempt`,
        );
      }
      return;
    }
    if ((await pathType(location.path)) === "absent") return;
    await assertSafeExistingWorkspace(location.root, location.path);
    await rm(location.path, { recursive: true, force: false });
  }

  #assertReceiptIdentity(
    receipt: FreshAttemptReceipt,
    issue: Issue,
    location: ReturnType<typeof workspaceLocation>,
  ): void {
    if (
      receipt.issue_id !== issue.id ||
      receipt.issue_identifier !== issue.identifier ||
      receipt.workspace_key !== location.workspaceKey
    ) {
      throw new SymphonyError(
        "fresh_attempt_invalid",
        "Fresh-attempt receipt identity does not match the tracker issue",
      );
    }
  }

  #errorContext(
    name: HookName,
    issue: Issue,
    workspace: Workspace,
    result: HookResult,
    config: WorkspaceLifecycleConfig,
  ) {
    return {
      hook: name,
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      workspace_path: workspace.path,
      duration_ms: result.durationMs,
      exit_code: result.exitCode,
      timed_out: result.timedOut,
      output: redactEnvironmentSecrets(
        result.output,
        this.#processEnvironment,
        config.secretEnvironmentNames,
      ),
      output_truncated: result.outputTruncated,
    };
  }
}
