import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Issue } from "../../src/domain/issue.js";
import { parseTrackerPolicy } from "../../src/governance/tracker-policy.js";
import type {
  TrackerConfigProfile,
  TrackerConfigProfiles,
} from "../../src/tracker/config-profile.js";

export const testTrackerProfile: TrackerConfigProfile = {
  kind: "test",
  defaultActiveStates: ["Todo"],
  defaultTerminalStates: ["Done"],
  secretEnvironmentNames: ["TEST_TRACKER_TOKEN"],
  resolveProvider: (provider) => provider,
};

export const testTrackerProfiles: TrackerConfigProfiles = new Map([
  [testTrackerProfile.kind, testTrackerProfile],
]);

export function acceptedGovernanceFixture() {
  const revision = "b".repeat(40);
  const repositoryIdentity = "reinispilens/.github";
  const trackerPolicySource = {
    repositoryIdentity,
    path: "agent-system/tracker-policy.json",
    revision,
    digest: `sha256:${"2".repeat(64)}`,
  };
  const noDelivery = {
    materialize: false,
    push: false,
    openPullRequest: false,
    observeChecks: false,
    mergePullRequest: false,
    releaseRemoteBranch: false,
    cleanupWorkspace: false,
  };
  const policy = {
    schemaVersion: 1,
    policyId: "reinispilens/test-tracker-v1",
    drivers: {
      exactlyOneRequired: true,
      changeOnlyInLane: "Backlog",
      labels: [
        {
          key: "direct",
          name: "driver:direct",
          color: "1D76DB",
          description: "Human-driven test work.",
        },
        {
          key: "symphony",
          name: "driver:symphony",
          color: "5319E7",
          description: "Symphony-driven test work.",
        },
      ],
    },
    lanes: [
      {
        name: "Backlog",
        writers: ["human"],
        active: false,
        terminal: false,
        authoring: false,
        freshAttempt: false,
        delivery: noDelivery,
      },
      {
        name: "Todo",
        writers: ["human"],
        active: true,
        terminal: false,
        authoring: true,
        freshAttempt: false,
        delivery: noDelivery,
      },
      {
        name: "In Progress",
        writers: ["agent", "human"],
        active: true,
        terminal: false,
        authoring: true,
        freshAttempt: false,
        delivery: noDelivery,
      },
      {
        name: "Human Review",
        writers: ["agent", "human"],
        active: false,
        terminal: false,
        authoring: false,
        freshAttempt: false,
        delivery: {
          ...noDelivery,
          materialize: true,
          push: true,
          openPullRequest: true,
          observeChecks: true,
          releaseRemoteBranch: true,
          cleanupWorkspace: true,
        },
      },
      {
        name: "Merging",
        writers: ["human"],
        active: true,
        terminal: false,
        authoring: false,
        freshAttempt: false,
        delivery: {
          ...noDelivery,
          materialize: true,
          push: true,
          openPullRequest: true,
          observeChecks: true,
          mergePullRequest: true,
          releaseRemoteBranch: true,
          cleanupWorkspace: true,
        },
      },
      {
        name: "Rework",
        writers: ["human"],
        active: true,
        terminal: false,
        authoring: true,
        freshAttempt: true,
        delivery: {
          ...noDelivery,
          releaseRemoteBranch: true,
          cleanupWorkspace: true,
        },
      },
      {
        name: "Done",
        writers: ["agent", "human"],
        active: false,
        terminal: true,
        authoring: false,
        freshAttempt: false,
        delivery: {
          ...noDelivery,
          releaseRemoteBranch: true,
          cleanupWorkspace: true,
        },
      },
      {
        name: "Cancelled",
        writers: ["agent", "human"],
        active: false,
        terminal: true,
        authoring: false,
        freshAttempt: false,
        delivery: {
          ...noDelivery,
          releaseRemoteBranch: true,
          cleanupWorkspace: true,
        },
      },
    ],
    deliveryProfiles: {
      "owner-gated": [
        "materialize",
        "push",
        "openPullRequest",
        "observeChecks",
        "observeMerge",
        "releaseRemoteBranch",
        "cleanupWorkspace",
      ],
      "full-in-scope": [
        "materialize",
        "push",
        "openPullRequest",
        "observeChecks",
        "mergePullRequest",
        "observeMerge",
        "releaseRemoteBranch",
        "cleanupWorkspace",
      ],
    },
    retry: {
      continuation: "same-work-session-and-workspace",
      failure: "same-work-session-with-bounded-backoff",
      rework: "fresh-attempt-discarding-prior-workspace-and-workpad",
      freshAttemptFailureLane: "Human Review",
    },
  };
  return {
    doctrine: {
      repositoryIdentity,
      path: "agent-system/golden-principles.md",
      revision,
      digest: `sha256:${"1".repeat(64)}`,
    },
    governanceManifest: {
      repositoryIdentity,
      path: "agent-system/accepted-governance.json",
      revision: "c".repeat(40),
      digest: `sha256:${"3".repeat(64)}`,
    },
    trackerPolicy: parseTrackerPolicy(
      Buffer.from(JSON.stringify(policy)),
      trackerPolicySource,
    ),
  };
}

export function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "opaque-1",
    native_ref: null,
    identifier: "SYM-123",
    title: "Build the safe foundation",
    description: "Implement the workflow and workspace boundaries.",
    priority: 1,
    state: "Todo",
    state_version: "state-version-1",
    branch_name: "feature/sym-123",
    url: "https://example.test/issues/123",
    assignee_id: null,
    labels: ["ready"],
    blocked_by: [],
    dispatchable: true,
    created_at: new Date("2026-08-23T08:00:00.000Z"),
    updated_at: new Date("2026-08-23T09:00:00.000Z"),
    ...overrides,
  };
}

export async function withTempDirectory<T>(
  run: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "symphony-test-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
