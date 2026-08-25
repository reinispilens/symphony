import type { JsonObject } from "../shared/json.js";
import type { AcceptedConfigurationSnapshot } from "../state/model.js";
import type { ServiceConfig } from "../workflow/config.js";
import type { WorkflowSnapshot } from "../workflow/store.js";

export const REPOSITORY_PROFILE_SCHEMA_VERSION = 1;
export const DEPLOYMENT_BINDING_SCHEMA_VERSION = 1;

export interface RepositoryProfileDocument {
  readonly schemaVersion: typeof REPOSITORY_PROFILE_SCHEMA_VERSION;
  readonly repositoryIdentity: string;
  readonly baseRef: string;
  readonly authoringContext: {
    readonly promptPath: string;
    readonly paths: readonly string[];
  };
  readonly preparationClass: "none" | "pnpm";
}

export interface DeploymentBindingDocument {
  readonly schemaVersion: typeof DEPLOYMENT_BINDING_SCHEMA_VERSION;
  readonly id: string;
  readonly productProfile: {
    readonly repositoryIdentity: string;
    readonly sourceRoot: string;
    readonly path: string;
    readonly revision: string;
    readonly digest: string;
  };
  readonly stateRoot: string;
  readonly workspaceRoot: string;
  readonly branchPrefix: string;
  readonly gitExecutable: string;
  readonly tracker: {
    readonly kind: string;
    readonly provider: JsonObject;
    readonly requiredLabels: readonly string[];
    readonly excludedLabels: readonly string[];
    readonly activeStates: readonly string[];
    readonly terminalStates: readonly string[];
    readonly freshAttemptStates: readonly string[];
    readonly freshAttemptFailureState: string | null;
  };
  readonly polling: {
    readonly intervalMs: number;
  };
  readonly preparation: {
    readonly timeoutMs: number;
    readonly nodeExecutable: string;
    readonly pnpmEntryPoint: string;
    readonly sandboxExecutable: string;
    readonly dependencyPolicy: {
      readonly id: string;
      readonly mode: "offline";
      readonly registry: string;
      readonly seedStoreRoot: string;
      readonly pnpmVersion: string;
    };
  } | null;
  readonly agent: {
    readonly maxConcurrentAgents: number;
    readonly maxTurns: number;
    readonly maxRetryBackoffMs: number;
    readonly maxConcurrentAgentsByState: Readonly<Record<string, number>>;
  };
  readonly runtime: {
    readonly codexExecutable: string;
    readonly turnTimeoutMs: number;
    readonly readTimeoutMs: number;
    readonly stallTimeoutMs: number;
    readonly containment: {
      readonly provider: "systemd-user-scope";
      readonly shutdownTimeoutMs: number;
      readonly systemdRunExecutable: string;
      readonly systemctlExecutable: string;
    };
  };
}

export interface ResolvedDeployment {
  readonly binding: DeploymentBindingDocument;
  readonly bindingDigest: string;
  readonly bindingPath: string;
  readonly acceptedConfiguration: AcceptedConfigurationSnapshot;
  readonly profile: RepositoryProfileDocument;
  readonly serviceConfig: ServiceConfig;
  readonly workflow: WorkflowSnapshot;
}
