import { describe, expect, it } from "vitest";

import { DefaultTrackerFactory } from "../../src/tracker/factory.js";
import type { ServiceConfig } from "../../src/workflow/config.js";
import type { WorkflowSnapshot } from "../../src/workflow/store.js";

function snapshot(hash = "hash-1", kind = "github-projects"): WorkflowSnapshot {
  const config: ServiceConfig = {
    tracker: {
      kind,
      provider: {
        owner: "acme",
        repo: "widgets",
        project: 28,
        hostname: "github.com",
        status_field: "Status",
        priority_field: "Priority",
        timeout_ms: 30_000,
        agent_status_targets: [],
      },
      activeStates: ["Todo"],
      terminalStates: ["Done"],
      freshAttemptStates: [],
      freshAttemptFailureState: null,
      requiredLabels: [],
      excludedLabels: [],
      secretEnvironmentNames: [],
    },
    polling: { intervalMs: 30_000 },
    workspace: { provider: "directory", root: "/tmp/workspaces" },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 60_000,
    },
    agent: {
      maxConcurrentAgents: 1,
      maxTurns: 3,
      maxRetryBackoffMs: 300_000,
      maxConcurrentAgentsByState: new Map(),
    },
    codex: {
      command: "codex app-server",
      approvalPolicy: null,
      threadSandbox: null,
      turnSandboxPolicy: null,
      readTimeoutMs: 5_000,
      turnTimeoutMs: 60_000,
      stallTimeoutMs: 300_000,
    },
  };
  return {
    config,
    definition: { config: {}, promptTemplate: "Prompt" },
    loadedAt: new Date(0),
    path: "/repo/WORKFLOW.md",
    sourceHash: hash,
  };
}

describe("DefaultTrackerFactory", () => {
  it("reuses the current workflow adapter but replaces it after reload", () => {
    const factory = new DefaultTrackerFactory({ environment: {} });
    const first = factory.create(snapshot("one"));
    expect(factory.create(snapshot("one"))).toBe(first);
    expect(factory.create(snapshot("two"))).not.toBe(first);
  });

  it("fails loudly for an unregistered adapter kind", () => {
    const factory = new DefaultTrackerFactory({ environment: {} });
    expect(() => factory.create(snapshot("one", "mystery"))).toThrowError(
      expect.objectContaining({ category: "invalid_tracker_config" }),
    );
  });
});
