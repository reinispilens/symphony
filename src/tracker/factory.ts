import type { Logger } from "../observability/logger.js";
import type { WorkflowSnapshot } from "../workflow/store.js";
import type { TrackerAdapter } from "./adapter.js";
import { GitHubProjectsAdapter } from "./github-projects/adapter.js";
import { GhGraphqlClient } from "./github-projects/gh-graphql-client.js";
import {
  GITHUB_PROJECTS_TRACKER_KIND,
  parseGitHubProjectsConfig,
} from "./github-projects/profile.js";
import { TrackerError } from "./errors.js";

export interface DefaultTrackerFactoryOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly ghCommand?: string;
  readonly logger?: Logger;
}

/** Caches only the current workflow adapter; old workers retain their own instance. */
export class DefaultTrackerFactory {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #ghCommand: string;
  readonly #logger: Logger | undefined;
  #cached: { readonly adapter: TrackerAdapter; readonly hash: string } | null =
    null;

  constructor(options: DefaultTrackerFactoryOptions = {}) {
    this.#environment = options.environment ?? process.env;
    this.#ghCommand = options.ghCommand ?? "gh";
    this.#logger = options.logger;
  }

  create(workflow: WorkflowSnapshot): TrackerAdapter {
    if (this.#cached?.hash === workflow.sourceHash) return this.#cached.adapter;
    if (workflow.config.tracker.kind !== GITHUB_PROJECTS_TRACKER_KIND) {
      throw new TrackerError(
        "invalid_tracker_config",
        `No runtime adapter is registered for tracker kind '${workflow.config.tracker.kind}'`,
      );
    }

    const config = parseGitHubProjectsConfig(workflow.config.tracker.provider);
    const client = new GhGraphqlClient({
      command: this.#ghCommand,
      environment: this.#environment,
      hostname: config.hostname,
      timeoutMs: config.timeoutMs,
    });
    const adapter = new GitHubProjectsAdapter({
      activeStates: workflow.config.tracker.activeStates,
      freshAttemptStates: workflow.config.tracker.freshAttemptStates,
      client,
      config,
      ...(this.#logger === undefined ? {} : { logger: this.#logger }),
    });
    this.#cached = { adapter, hash: workflow.sourceHash };
    return adapter;
  }
}
