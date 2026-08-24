import { createHash } from "node:crypto";
import { watchFile, unwatchFile } from "node:fs";

import { errorMessage } from "../errors.js";
import { nullLogger, type Logger } from "../observability/logger.js";
import type { TrackerConfigProfiles } from "../tracker/config-profile.js";
import { resolveServiceConfig, type ServiceConfig } from "./config.js";
import type { WorkflowDefinition } from "./definition.js";
import { loadWorkflow } from "./loader.js";

export interface WorkflowSnapshot {
  readonly config: ServiceConfig;
  readonly definition: WorkflowDefinition;
  readonly loadedAt: Date;
  readonly path: string;
  readonly sourceHash: string;
}

export type ReloadResult =
  | { readonly status: "unchanged" }
  | { readonly status: "reloaded"; readonly snapshot: WorkflowSnapshot }
  | { readonly status: "rejected"; readonly error: unknown };

export interface WorkflowStoreOptions {
  readonly workflowPath: string;
  readonly trackerProfiles: TrackerConfigProfiles;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory?: string;
  readonly temporaryDirectory?: string;
  readonly logger?: Logger;
  readonly watchIntervalMs?: number;
  readonly onReload?: (snapshot: WorkflowSnapshot) => void;
  readonly onReloadError?: (error: unknown) => void;
}

function hash(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

export class WorkflowStore {
  readonly #options: WorkflowStoreOptions;
  readonly #logger: Logger;
  #current: WorkflowSnapshot | null = null;
  #lastObservedHash: string | null = null;
  #reloadInFlight: Promise<ReloadResult> | null = null;
  #watchListener: (() => void) | null = null;
  #watching = false;

  constructor(options: WorkflowStoreOptions) {
    this.#options = options;
    this.#logger = options.logger ?? nullLogger;
  }

  get current(): WorkflowSnapshot {
    if (this.#current === null)
      throw new Error("WorkflowStore has not completed its initial load");
    return this.#current;
  }

  async loadInitial(): Promise<WorkflowSnapshot> {
    const loaded = await loadWorkflow(this.#options.workflowPath);
    const sourceHash = hash(loaded.source);
    const snapshot = this.#resolveSnapshot(
      loaded.definition,
      loaded.path,
      sourceHash,
    );
    this.#current = snapshot;
    this.#lastObservedHash = sourceHash;
    return snapshot;
  }

  async checkForUpdates(): Promise<ReloadResult> {
    if (this.#reloadInFlight !== null) return this.#reloadInFlight;
    this.#reloadInFlight = this.#performReload().finally(() => {
      this.#reloadInFlight = null;
    });
    return this.#reloadInFlight;
  }

  startWatching(): void {
    if (this.#watching) return;
    this.#watching = true;
    this.#watchListener = () => void this.checkForUpdates();
    watchFile(
      this.#options.workflowPath,
      { interval: this.#options.watchIntervalMs ?? 500, persistent: false },
      this.#watchListener,
    );
  }

  close(): void {
    if (!this.#watching) return;
    if (this.#watchListener !== null)
      unwatchFile(this.#options.workflowPath, this.#watchListener);
    this.#watchListener = null;
    this.#watching = false;
  }

  async #performReload(): Promise<ReloadResult> {
    try {
      const loaded = await loadWorkflow(this.#options.workflowPath);
      const sourceHash = hash(loaded.source);
      if (sourceHash === this.#lastObservedHash) return { status: "unchanged" };

      const snapshot = this.#resolveSnapshot(
        loaded.definition,
        loaded.path,
        sourceHash,
      );
      this.#lastObservedHash = sourceHash;
      this.#current = snapshot;
      this.#logger.info("Workflow configuration reloaded", {
        workflow_path: loaded.path,
        workflow_hash: sourceHash,
      });
      try {
        this.#options.onReload?.(snapshot);
      } catch (error) {
        this.#logger.error("Workflow reload callback failed", {
          workflow_path: loaded.path,
          error: errorMessage(error),
        });
      }
      return { status: "reloaded", snapshot };
    } catch (error) {
      this.#logger.error(
        "Workflow reload rejected; retaining the last known good configuration",
        {
          workflow_path: this.#options.workflowPath,
          error: errorMessage(error),
        },
      );
      try {
        this.#options.onReloadError?.(error);
      } catch (callbackError) {
        this.#logger.error("Workflow reload-error callback failed", {
          workflow_path: this.#options.workflowPath,
          error: errorMessage(callbackError),
        });
      }
      return { status: "rejected", error };
    }
  }

  #resolveSnapshot(
    definition: WorkflowDefinition,
    workflowPath: string,
    sourceHash: string,
  ): WorkflowSnapshot {
    const config = resolveServiceConfig(definition, {
      workflowPath,
      trackerProfiles: this.#options.trackerProfiles,
      ...(this.#options.environment === undefined
        ? {}
        : { environment: this.#options.environment }),
      ...(this.#options.homeDirectory === undefined
        ? {}
        : { homeDirectory: this.#options.homeDirectory }),
      ...(this.#options.temporaryDirectory === undefined
        ? {}
        : { temporaryDirectory: this.#options.temporaryDirectory }),
    });
    return {
      config,
      definition,
      loadedAt: new Date(),
      path: workflowPath,
      sourceHash,
    };
  }
}
