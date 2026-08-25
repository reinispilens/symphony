import type { Issue } from "../domain/issue.js";
import type {
  DeploymentAuthorityConfig,
  HooksConfig,
  PreparationConfig,
  RepositoryConfig,
  WorkspaceConfig,
} from "../workflow/config.js";

export interface Workspace {
  readonly createdNow: boolean;
  readonly path: string;
  readonly workspaceKey: string;
}

export interface WorkspaceLifecycleConfig {
  readonly deployment: DeploymentAuthorityConfig | null;
  readonly hooks: HooksConfig;
  readonly repository: RepositoryConfig | null;
  readonly preparation: PreparationConfig;
  readonly secretEnvironmentNames: readonly string[];
  readonly workflowPath: string;
  readonly workspace: WorkspaceConfig;
}

export interface RunHookContext {
  readonly attempt: number | null;
  readonly generation?: string;
  readonly status?: string;
  readonly authority?: RepositoryAttemptAuthority;
}

export interface RepositoryAttemptAuthority {
  readonly workSessionId: string;
  readonly attemptId: string;
  readonly runtimeLeaseToken: string;
  readonly controllerGeneration: number;
}

export interface RepositoryCleanupAuthority {
  readonly workSessionId: string;
  readonly controllerGeneration: number;
}

export interface FreshAttemptPreparation {
  readonly resetWorkpad: boolean;
  readonly workspace: Workspace;
}

/**
 * Symphony's repository-lifecycle boundary.
 *
 * Product repositories supply facts and product policy. Implementations of
 * this port own workspace creation, inspection, reuse, preparation hooks, and
 * guarded cleanup. The current WorkspaceManager is the compatibility driver;
 * new repositories must use a Symphony-owned managed driver.
 */
export interface RepositoryDriver {
  prepare(
    issue: Issue,
    config: WorkspaceLifecycleConfig,
    context?: RunHookContext,
  ): Promise<Workspace>;
  prepareFreshAttempt(
    issue: Issue,
    config: WorkspaceLifecycleConfig,
    generation: string,
    context?: RunHookContext,
  ): Promise<FreshAttemptPreparation>;
  markFreshAttemptReady(
    issue: Issue,
    config: WorkspaceLifecycleConfig,
    generation: string,
    context?: RunHookContext,
  ): Promise<void>;
  beforeRun(
    issue: Issue,
    workspace: Workspace,
    config: WorkspaceLifecycleConfig,
    context: RunHookContext,
  ): Promise<void>;
  afterRun(
    issue: Issue,
    workspace: Workspace,
    config: WorkspaceLifecycleConfig,
    context: RunHookContext,
  ): Promise<void>;
  remove(
    issue: Issue,
    config: WorkspaceLifecycleConfig,
    authority?: RepositoryCleanupAuthority,
  ): Promise<void>;
  assertAgentLaunchCwd(
    workspace: Workspace,
    config: WorkspaceLifecycleConfig,
    cwd: string,
  ): Promise<void>;
}
