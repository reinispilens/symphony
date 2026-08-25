import type { Issue } from "../domain/issue.js";
import type {
  FreshAttemptPreparation,
  RepositoryCleanupAuthority,
  RepositoryDriver,
  RunHookContext,
  Workspace,
  WorkspaceLifecycleConfig,
} from "./driver.js";

export interface RoutingRepositoryDriverOptions {
  readonly compatibility: RepositoryDriver;
  readonly managedGit: RepositoryDriver;
}

/** Routes trusted configuration to one implementation without product-owned dispatch code. */
export class RoutingRepositoryDriver implements RepositoryDriver {
  readonly #compatibility: RepositoryDriver;
  readonly #managedGit: RepositoryDriver;

  constructor(options: RoutingRepositoryDriverOptions) {
    this.#compatibility = options.compatibility;
    this.#managedGit = options.managedGit;
  }

  prepare(
    issue: Issue,
    config: WorkspaceLifecycleConfig,
    context?: RunHookContext,
  ): Promise<Workspace> {
    return this.#driver(config).prepare(issue, config, context);
  }

  prepareFreshAttempt(
    issue: Issue,
    config: WorkspaceLifecycleConfig,
    generation: string,
    context?: RunHookContext,
  ): Promise<FreshAttemptPreparation> {
    return this.#driver(config).prepareFreshAttempt(
      issue,
      config,
      generation,
      context,
    );
  }

  markFreshAttemptReady(
    issue: Issue,
    config: WorkspaceLifecycleConfig,
    generation: string,
    context?: RunHookContext,
  ): Promise<void> {
    return this.#driver(config).markFreshAttemptReady(
      issue,
      config,
      generation,
      context,
    );
  }

  beforeRun(
    issue: Issue,
    workspace: Workspace,
    config: WorkspaceLifecycleConfig,
    context: RunHookContext,
  ): Promise<void> {
    return this.#driver(config).beforeRun(issue, workspace, config, context);
  }

  afterRun(
    issue: Issue,
    workspace: Workspace,
    config: WorkspaceLifecycleConfig,
    context: RunHookContext,
  ): Promise<void> {
    return this.#driver(config).afterRun(issue, workspace, config, context);
  }

  remove(
    issue: Issue,
    config: WorkspaceLifecycleConfig,
    authority?: RepositoryCleanupAuthority,
  ): Promise<void> {
    return this.#driver(config).remove(issue, config, authority);
  }

  assertAgentLaunchCwd(
    workspace: Workspace,
    config: WorkspaceLifecycleConfig,
    cwd: string,
  ): Promise<void> {
    return this.#driver(config).assertAgentLaunchCwd(workspace, config, cwd);
  }

  #driver(config: WorkspaceLifecycleConfig): RepositoryDriver {
    return config.workspace.provider === "git-worktree"
      ? this.#managedGit
      : this.#compatibility;
  }
}
