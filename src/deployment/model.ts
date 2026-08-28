import type { JsonObject } from "../shared/json.js";
import type {
  AcceptedConfigurationSnapshot,
  DeliveryGrantSnapshot,
} from "../state/model.js";
import type { ResolvedGovernance } from "../governance/model.js";
import type { ServiceConfig } from "../workflow/config.js";
import type { WorkflowSnapshot } from "../workflow/store.js";

export const REPOSITORY_PROFILE_SCHEMA_VERSION = 2;
export const LEGACY_REPOSITORY_PROFILE_SCHEMA_VERSION = 1;
export const DEPLOYMENT_BINDING_SCHEMA_VERSION = 3;
export const DELIVERY_DEPLOYMENT_BINDING_SCHEMA_VERSION = 2;
export const LEGACY_DEPLOYMENT_BINDING_SCHEMA_VERSION = 1;

export interface RepositoryProfileDocument {
  readonly schemaVersion:
    | typeof LEGACY_REPOSITORY_PROFILE_SCHEMA_VERSION
    | typeof REPOSITORY_PROFILE_SCHEMA_VERSION;
  readonly repositoryIdentity: string;
  readonly baseRef: string;
  readonly authoringContext: {
    readonly promptPath: string;
    readonly paths: readonly string[];
  };
  readonly preparationClass: "none" | "pnpm";
  /** Null only when reading the version-1 compatibility schema. */
  readonly deliveryGrant: DeliveryGrantSnapshot | null;
}

export interface DeliveryProviderBinding {
  readonly protocolVersion: 1;
  readonly executable: string;
  readonly timeoutMs: number;
  readonly secretEnvironmentNames: readonly string[];
}

export interface LegacyTrackerBinding {
  readonly kind: string;
  readonly provider: JsonObject;
  readonly requiredLabels: readonly string[];
  readonly excludedLabels: readonly string[];
  readonly activeStates: readonly string[];
  readonly terminalStates: readonly string[];
  readonly freshAttemptStates: readonly string[];
  readonly freshAttemptFailureState: string | null;
}

export interface GovernanceBinding {
  readonly repositoryIdentity: string;
  readonly sourceRoot: string;
  readonly manifest: {
    readonly path: string;
    readonly revision: string;
    readonly digest: string;
  };
}

interface DeploymentBindingFields {
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

interface ThinTrackerBinding {
  readonly kind: string;
  readonly provider: JsonObject;
}

/** Exact operator-authored JSON contract. */
export type DeploymentBindingDocument = DeploymentBindingFields &
  (
    | {
        readonly schemaVersion: typeof LEGACY_DEPLOYMENT_BINDING_SCHEMA_VERSION;
        readonly tracker: LegacyTrackerBinding;
        readonly governance?: never;
        readonly deliveryProvider?: never;
      }
    | {
        readonly schemaVersion: typeof DELIVERY_DEPLOYMENT_BINDING_SCHEMA_VERSION;
        readonly tracker: LegacyTrackerBinding;
        readonly governance?: never;
        readonly deliveryProvider: DeliveryProviderBinding | null;
      }
    | {
        readonly schemaVersion: typeof DEPLOYMENT_BINDING_SCHEMA_VERSION;
        readonly tracker: ThinTrackerBinding;
        readonly governance: GovernanceBinding;
        readonly deliveryProvider: DeliveryProviderBinding | null;
      }
  );

/** Strictly parsed form used internally after compatibility normalization. */
export interface NormalizedDeploymentBindingDocument extends DeploymentBindingFields {
  readonly schemaVersion:
    | typeof LEGACY_DEPLOYMENT_BINDING_SCHEMA_VERSION
    | typeof DELIVERY_DEPLOYMENT_BINDING_SCHEMA_VERSION
    | typeof DEPLOYMENT_BINDING_SCHEMA_VERSION;
  readonly tracker: LegacyTrackerBinding;
  /** Null only for the version-1 and version-2 compatibility schemas. */
  readonly governance: GovernanceBinding | null;
  readonly deliveryProvider: DeliveryProviderBinding | null;
}

export interface ResolvedDeployment {
  readonly binding: NormalizedDeploymentBindingDocument;
  readonly bindingDigest: string;
  readonly bindingPath: string;
  readonly acceptedConfiguration: AcceptedConfigurationSnapshot;
  /** Null only for the version-1 and version-2 compatibility schemas. */
  readonly governance: ResolvedGovernance | null;
  readonly profile: RepositoryProfileDocument;
  readonly serviceConfig: ServiceConfig;
  readonly workflow: WorkflowSnapshot;
}
