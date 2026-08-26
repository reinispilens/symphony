import path from "node:path";

import type { ResolvedDeployment } from "../../src/deployment/model.js";
import type { AcceptedConfigurationSnapshot } from "../../src/state/model.js";
import { acceptedGovernanceFixture } from "../support/factories.js";

export const TEST_ACTOR = "local-user:1000:reinis";
export const TEST_BINDING_DIGEST = `sha256:${"4".repeat(64)}`;

export function interactiveAcceptedConfiguration(): AcceptedConfigurationSnapshot {
  const governance = acceptedGovernanceFixture();
  return {
    productProfile: {
      repositoryIdentity: "reinispilens/symphony",
      path: ".symphony/repository-profile.json",
      revision: "a".repeat(40),
      digest: `sha256:${"5".repeat(64)}`,
    },
    authoringContext: {
      repositoryIdentity: "reinispilens/symphony",
      revision: "a".repeat(40),
      manifestDigest: `sha256:${"6".repeat(64)}`,
      entries: [
        { path: ".symphony/prompt.md", digest: `sha256:${"7".repeat(64)}` },
        { path: "AGENTS.md", digest: `sha256:${"8".repeat(64)}` },
      ],
    },
    deploymentBinding: {
      id: "personal-symphony",
      digest: TEST_BINDING_DIGEST,
    },
    governanceManifest: governance.governanceManifest,
    trackerPolicy: governance.trackerPolicy,
    deliveryGrant: null,
    proofAuthority: null,
  };
}

/**
 * Manual-service tests need only the already-resolved authority projection.
 * The resolver's complete document validation has its own suite, so this
 * fixture deliberately fills non-consumed runtime fields with inert values.
 */
export function resolvedDeploymentFixture(
  directory: string,
  overrides: {
    readonly bindingDigest?: string;
    readonly gitExecutable?: string;
    readonly governanceRoot?: string;
    readonly repositoryIdentity?: string;
    readonly stateRoot?: string;
    readonly workspaceRoot?: string;
  } = {},
): ResolvedDeployment {
  const repositoryIdentity =
    overrides.repositoryIdentity ?? "reinispilens/symphony";
  const stateRoot = overrides.stateRoot ?? path.join(directory, "state");
  const workspaceRoot =
    overrides.workspaceRoot ?? path.join(directory, "managed-workspaces");
  const governanceRoot =
    overrides.governanceRoot ?? path.join(directory, "governance");
  const bindingDigest = overrides.bindingDigest ?? TEST_BINDING_DIGEST;
  const acceptedConfiguration = {
    ...interactiveAcceptedConfiguration(),
    productProfile: {
      ...interactiveAcceptedConfiguration().productProfile,
      repositoryIdentity,
    },
    authoringContext: {
      ...interactiveAcceptedConfiguration().authoringContext,
      repositoryIdentity,
    },
    deploymentBinding: {
      id: "personal-symphony",
      digest: bindingDigest,
    },
  };
  const governance = acceptedGovernanceFixture();
  return {
    binding: {
      schemaVersion: 3,
      id: "personal-symphony",
      productProfile: {
        repositoryIdentity,
        sourceRoot: path.join(directory, "accepted-source"),
        path: ".symphony/repository-profile.json",
        revision: "a".repeat(40),
        digest: acceptedConfiguration.productProfile.digest,
      },
      stateRoot,
      workspaceRoot,
      branchPrefix: "symphony/",
      gitExecutable: overrides.gitExecutable ?? "/usr/bin/git",
      polling: { intervalMs: 30_000 },
      preparation: null,
      agent: {
        maxConcurrentAgents: 1,
        maxTurns: 1,
        maxRetryBackoffMs: 1_000,
        maxConcurrentAgentsByState: {},
      },
      runtime: {
        codexExecutable: "/usr/bin/false",
        turnTimeoutMs: 1_000,
        readTimeoutMs: 1_000,
        stallTimeoutMs: 1_000,
        containment: {
          provider: "systemd-user-scope",
          shutdownTimeoutMs: 1_000,
          systemdRunExecutable: "/usr/bin/false",
          systemctlExecutable: "/usr/bin/false",
        },
      },
      tracker: {
        kind: "github-projects",
        provider: {
          hostname: "github.com",
          owner: "reinispilens",
          repo: "symphony",
          project: 1,
        },
        requiredLabels: [],
        excludedLabels: [],
        activeStates: ["Todo"],
        terminalStates: ["Done"],
        freshAttemptStates: [],
        freshAttemptFailureState: "Human Review",
      },
      governance: {
        repositoryIdentity: governance.doctrine.repositoryIdentity,
        sourceRoot: governanceRoot,
        manifest: {
          path: governance.governanceManifest.path,
          revision: governance.governanceManifest.revision,
          digest: governance.governanceManifest.digest,
        },
      },
      deliveryProvider: null,
    },
    bindingDigest,
    bindingPath: path.join(directory, "operator", "binding.json"),
    acceptedConfiguration,
    governance: {
      manifest: {
        schemaVersion: 1,
        repositoryIdentity: governance.doctrine.repositoryIdentity,
        acceptedRevision: governance.doctrine.revision,
        artifacts: {
          doctrine: {
            path: governance.doctrine.path,
            digest: governance.doctrine.digest,
          },
          trackerPolicy: {
            path: governance.trackerPolicy.source.path,
            digest: governance.trackerPolicy.source.digest,
          },
        },
      },
      manifestReference: governance.governanceManifest,
      doctrineReference: governance.doctrine,
      trackerPolicy: governance.trackerPolicy,
    },
    profile: {
      schemaVersion: 2,
      repositoryIdentity,
      baseRef: "refs/remotes/origin/main",
      authoringContext: {
        promptPath: ".symphony/prompt.md",
        paths: ["AGENTS.md"],
      },
      preparationClass: "none",
      deliveryGrant: null,
    },
    serviceConfig: {
      repository: {
        identity: repositoryIdentity,
        hostname: "github.com",
        baseRef: "refs/remotes/origin/main",
        branchPrefix: "symphony/",
        profileDigest: acceptedConfiguration.productProfile.digest,
      },
    },
    workflow: {},
  } as unknown as ResolvedDeployment;
}
