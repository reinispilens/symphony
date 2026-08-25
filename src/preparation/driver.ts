import type { Issue } from "../domain/issue.js";
import type {
  RepositoryAttemptAuthority,
  RepositoryCleanupAuthority,
  Workspace,
  WorkspaceLifecycleConfig,
} from "../repository/driver.js";

export interface PreparationInput {
  readonly authority: RepositoryAttemptAuthority | undefined;
  readonly config: WorkspaceLifecycleConfig;
  readonly issue: Issue;
  readonly signal?: AbortSignal;
  readonly workspace: Workspace;
}

export interface PreparationDriver {
  prepare(input: PreparationInput): Promise<void>;
  cleanup(
    authority: RepositoryCleanupAuthority | undefined,
    config: WorkspaceLifecycleConfig,
  ): Promise<void>;
}

export class NoopPreparationDriver implements PreparationDriver {
  async prepare(_input: PreparationInput): Promise<void> {}
  async cleanup(
    _authority: RepositoryCleanupAuthority | undefined,
    _config: WorkspaceLifecycleConfig,
  ): Promise<void> {}
}

export interface RoutingPreparationDriverOptions {
  readonly none?: PreparationDriver;
  readonly pnpm: PreparationDriver;
}

export class RoutingPreparationDriver implements PreparationDriver {
  readonly #none: PreparationDriver;
  readonly #pnpm: PreparationDriver;

  constructor(options: RoutingPreparationDriverOptions) {
    this.#none = options.none ?? new NoopPreparationDriver();
    this.#pnpm = options.pnpm;
  }

  prepare(input: PreparationInput): Promise<void> {
    return this.#driver(input.config).prepare(input);
  }

  cleanup(
    authority: RepositoryCleanupAuthority | undefined,
    config: WorkspaceLifecycleConfig,
  ): Promise<void> {
    return this.#driver(config).cleanup(authority, config);
  }

  #driver(config: WorkspaceLifecycleConfig): PreparationDriver {
    return config.preparation.driver === "pnpm" ? this.#pnpm : this.#none;
  }
}
