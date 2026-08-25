import { describe, expect, it } from "vitest";

import type { ServiceConfig } from "../../src/workflow/config.js";
import {
  compareIssuesForDispatch,
  failureRetryDelayMs,
  issueEligibleByConfig,
  issueRoutable,
} from "../../src/orchestrator/eligibility.js";
import { issue } from "../support/factories.js";

function config(): ServiceConfig {
  return {
    deployment: null,
    tracker: {
      kind: "test",
      provider: {},
      activeStates: ["Todo", "In Progress"],
      terminalStates: ["Done"],
      freshAttemptStates: [],
      freshAttemptFailureState: null,
      requiredLabels: ["ready", "Agent"],
      excludedLabels: ["blocked"],
      secretEnvironmentNames: [],
    },
    repository: null,
    preparation: {
      driver: "none",
      frozenLockfile: true,
      lifecycleScripts: false,
      timeoutMs: 300_000,
    },
    polling: { intervalMs: 30_000 },
    workspace: { provider: "directory", root: "/tmp/symphony-tests" },
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
}

describe("orchestrator eligibility", () => {
  it("keeps adapter routing separate from state and label-selector checks", () => {
    expect(
      issueRoutable(issue({ labels: [" READY ", "agent"] }), [
        "ready",
        "Agent",
      ]),
    ).toBe(true);
    expect(issueRoutable(issue({ dispatchable: false }), ["ready"])).toBe(
      false,
    );
    expect(issueRoutable(issue({ labels: [""] }), [" "])).toBe(false);
    expect(
      issueRoutable(
        issue({ labels: ["ready", "driver:direct"] }),
        ["ready"],
        [" DRIVER:DIRECT "],
      ),
    ).toBe(false);
    expect(
      issueEligibleByConfig(
        issue({ labels: ["ready", "agent"], state: " todo " }),
        config(),
      ),
    ).toBe(true);
    expect(
      issueEligibleByConfig(
        issue({ labels: ["ready", "agent"], state: "Done" }),
        config(),
      ),
    ).toBe(false);
    expect(
      issueEligibleByConfig(
        issue({ labels: ["ready", "agent", "blocked"] }),
        config(),
      ),
    ).toBe(false);
    expect(
      issueEligibleByConfig(
        issue({ identifier: "", labels: ["ready", "agent"] }),
        config(),
      ),
    ).toBe(false);
  });

  it("sorts valid P0-P3 priorities, then age, then identifier", () => {
    const issues = [
      issue({ identifier: "D", priority: null, created_at: new Date(0) }),
      issue({ identifier: "B", priority: 1, created_at: new Date(20) }),
      issue({ identifier: "A", priority: 1, created_at: new Date(20) }),
      issue({ identifier: "C", priority: 2, created_at: new Date(10) }),
      issue({ identifier: "E", priority: 99, created_at: new Date(1) }),
    ];
    expect(
      issues.sort(compareIssuesForDispatch).map((item) => item.identifier),
    ).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("computes capped exponential failure backoff without overflow", () => {
    expect(failureRetryDelayMs(1, 300_000)).toBe(10_000);
    expect(failureRetryDelayMs(2, 300_000)).toBe(20_000);
    expect(failureRetryDelayMs(6, 300_000)).toBe(300_000);
    expect(failureRetryDelayMs(1000, 300_000)).toBe(300_000);
    expect(failureRetryDelayMs(1, 0)).toBe(0);
  });
});
