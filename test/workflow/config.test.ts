import path from "node:path";

import { describe, expect, it } from "vitest";

import type { JsonObject } from "../../src/shared/json.js";
import type { TrackerConfigProfile } from "../../src/tracker/config-profile.js";
import { resolveServiceConfig } from "../../src/workflow/config.js";
import type { WorkflowDefinition } from "../../src/workflow/definition.js";
import {
  testTrackerProfile,
  testTrackerProfiles,
} from "../support/factories.js";

function definition(config: JsonObject): WorkflowDefinition {
  return { config, promptTemplate: "Prompt" };
}

function resolve(
  config: JsonObject,
  overrides: Partial<Parameters<typeof resolveServiceConfig>[1]> = {},
) {
  return resolveServiceConfig(definition(config), {
    workflowPath: "/repo/config/WORKFLOW.md",
    trackerProfiles: testTrackerProfiles,
    environment: {},
    homeDirectory: "/users/tester",
    temporaryDirectory: "/var/tmp",
    ...overrides,
  });
}

describe("resolveServiceConfig", () => {
  it("applies every core default", () => {
    const config = resolve({ tracker: { kind: "test" } });

    expect(config).toMatchObject({
      tracker: {
        kind: "test",
        provider: {},
        requiredLabels: [],
        excludedLabels: [],
        activeStates: ["Todo"],
        terminalStates: ["Done"],
        freshAttemptStates: [],
        freshAttemptFailureState: null,
        secretEnvironmentNames: ["TEST_TRACKER_TOKEN"],
      },
      repository: null,
      preparation: {
        driver: "none",
        frozenLockfile: true,
        lifecycleScripts: false,
        timeoutMs: 300_000,
      },
      polling: { intervalMs: 30_000 },
      workspace: {
        provider: "directory",
        root: path.resolve("/var/tmp/symphony_workspaces"),
      },
      hooks: {
        afterCreate: null,
        beforeRun: null,
        afterRun: null,
        beforeRemove: null,
        timeoutMs: 60_000,
      },
      agent: {
        maxConcurrentAgents: 10,
        maxTurns: 20,
        maxRetryBackoffMs: 300_000,
      },
      codex: {
        command: "codex app-server",
        approvalPolicy: null,
        threadSandbox: null,
        turnSandboxPolicy: null,
        turnTimeoutMs: 3_600_000,
        readTimeoutMs: 5_000,
        stallTimeoutMs: 300_000,
      },
    });
    expect(config.agent.maxConcurrentAgentsByState).toEqual(new Map());
  });

  it("preserves adapter-owned provider keys and lets the profile resolve them", () => {
    const profile: TrackerConfigProfile = {
      ...testTrackerProfile,
      resolveProvider: (provider, environment) => ({
        ...provider,
        resolved_token: environment["TOKEN"] ?? null,
      }),
    };
    const profiles = new Map([[profile.kind, profile]]);

    const config = resolve(
      {
        tracker: {
          kind: "test",
          provider: { project: 28, custom: { mode: "strict" } },
        },
      },
      { trackerProfiles: profiles, environment: { TOKEN: "host-only" } },
    );

    expect(config.tracker.provider).toEqual({
      project: 28,
      custom: { mode: "strict" },
      resolved_token: "host-only",
    });
  });

  it("accepts disjoint label selectors and rejects ambiguous selector configuration", () => {
    expect(
      resolve({
        tracker: {
          kind: "test",
          required_labels: ["driver:symphony"],
          excluded_labels: ["driver:direct"],
        },
      }).tracker,
    ).toMatchObject({
      requiredLabels: ["driver:symphony"],
      excludedLabels: ["driver:direct"],
    });

    for (const tracker of [
      { kind: "test", excluded_labels: [" "] },
      { kind: "test", required_labels: ["Ready", " ready "] },
      {
        kind: "test",
        required_labels: ["driver:symphony"],
        excluded_labels: [" DRIVER:SYMPHONY "],
      },
    ]) {
      expect(() => resolve({ tracker })).toThrowError(
        expect.objectContaining({ code: "config_validation_error" }),
      );
    }
  });

  it("resolves environment, home, and relative workspace paths only in workspace.root", () => {
    expect(
      resolve(
        {
          tracker: { kind: "test" },
          workspace: { root: "$ESTATE/core" },
          codex: { command: "run $DO_NOT_EXPAND" },
        },
        { environment: { ESTATE: "/worktrees" } },
      ),
    ).toMatchObject({
      workspace: { root: "/worktrees/core" },
      codex: { command: "run $DO_NOT_EXPAND" },
    });
    expect(
      resolve({ tracker: { kind: "test" }, workspace: { root: "~/work" } })
        .workspace.root,
    ).toBe("/users/tester/work");
    expect(
      resolve({ tracker: { kind: "test" }, workspace: { root: "../work" } })
        .workspace.root,
    ).toBe("/repo/work");
  });

  it("fails when a path references a missing environment variable", () => {
    expect(() =>
      resolve({
        tracker: { kind: "test" },
        workspace: { root: "$MISSING/work" },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "config_validation_error" }),
    );
  });

  it("requires lifecycle ownership hooks for the harness workspace provider", () => {
    expect(() =>
      resolve({
        tracker: { kind: "test" },
        workspace: { provider: "harness" },
      }),
    ).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining("after_create"),
      }),
    );
    expect(() =>
      resolve({
        tracker: { kind: "test" },
        workspace: { provider: "harness" },
        hooks: { after_create: "prepare" },
      }),
    ).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining("before_remove"),
      }),
    );

    expect(
      resolve({
        tracker: { kind: "test" },
        workspace: { provider: "harness" },
        hooks: { after_create: "prepare", before_remove: "remove" },
      }).workspace.provider,
    ).toBe("harness");
    expect(() =>
      resolve({
        tracker: { kind: "test" },
        workspace: { provider: "magical" },
      }),
    ).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining("workspace.provider"),
      }),
    );
  });

  it("accepts a thin managed-repository profile and rejects lifecycle scripts", () => {
    const managed = resolve({
      tracker: { kind: "test", provider: { hostname: "github.com" } },
      repository: {
        identity: "acme/widgets",
        base_ref: "refs/remotes/origin/main",
        branch_prefix: "symphony/",
      },
      workspace: { provider: "git-worktree", root: "/worktrees/widgets" },
      preparation: {
        driver: "pnpm",
        frozen_lockfile: true,
        lifecycle_scripts: false,
        timeout_ms: 120_000,
      },
    });
    expect(managed).toMatchObject({
      repository: {
        identity: "acme/widgets",
        hostname: "github.com",
        baseRef: "refs/remotes/origin/main",
        branchPrefix: "symphony/",
      },
      workspace: { provider: "git-worktree", root: "/worktrees/widgets" },
      preparation: {
        driver: "pnpm",
        frozenLockfile: true,
        lifecycleScripts: false,
        timeoutMs: 120_000,
      },
      hooks: {
        afterCreate: null,
        beforeRun: null,
        afterRun: null,
        beforeRemove: null,
      },
      codex: {
        command: "codex app-server",
        approvalPolicy: "never",
        threadSandbox: "workspace-write",
        turnSandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [],
          networkAccess: false,
          excludeSlashTmp: true,
          excludeTmpdirEnvVar: true,
        },
      },
    });

    expect(() =>
      resolve({
        tracker: { kind: "test" },
        repository: {
          identity: "acme/widgets",
          base_ref: "refs/remotes/origin/main",
          branch_prefix: "symphony/",
        },
        workspace: { provider: "git-worktree" },
      }),
    ).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining("tracker.provider.hostname"),
      }),
    );

    expect(() =>
      resolve({
        tracker: { kind: "test" },
        workspace: { provider: "git-worktree" },
      }),
    ).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining("repository.identity"),
      }),
    );
    expect(() =>
      resolve({
        tracker: { kind: "test" },
        repository: {
          identity: "acme/widgets",
          base_ref: "refs/remotes/origin/main",
          branch_prefix: "symphony/",
        },
        workspace: { provider: "git-worktree" },
        hooks: { before_run: "pnpm install" },
      }),
    ).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining("must not define lifecycle commands"),
      }),
    );
    expect(() =>
      resolve({
        tracker: { kind: "test" },
        preparation: { driver: "pnpm" },
      }),
    ).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining(
          "requires workspace.provider 'git-worktree'",
        ),
      }),
    );
    for (const preparation of [
      { driver: "shell" },
      { driver: "pnpm", frozen_lockfile: false },
      { driver: "pnpm", lifecycle_scripts: true },
    ]) {
      expect(() =>
        resolve({ tracker: { kind: "test" }, preparation }),
      ).toThrowError(
        expect.objectContaining({ code: "config_validation_error" }),
      );
    }

    const managedBase = {
      tracker: { kind: "test", provider: { hostname: "github.com" } },
      repository: {
        identity: "acme/widgets",
        base_ref: "refs/remotes/origin/main",
        branch_prefix: "symphony/",
      },
      workspace: { provider: "git-worktree" },
    } satisfies JsonObject;
    for (const codex of [
      { command: "candidate-wrapper app-server" },
      { approval_policy: "on-request" },
      { thread_sandbox: "danger-full-access" },
      { turn_sandbox_policy: null },
      { turn_sandbox_policy: { type: "workspaceWrite" } },
    ]) {
      expect(() => resolve({ ...managedBase, codex })).toThrowError(
        expect.objectContaining({ code: "config_validation_error" }),
      );
    }
  });

  it("keeps Codex protocol overrides available only to compatibility workspace modes", () => {
    const config = resolve({
      tracker: { kind: "test" },
      codex: {
        command: "custom app-server",
        approval_policy: "on-request",
        thread_sandbox: "danger-full-access",
        turn_sandbox_policy: { type: "dangerFullAccess" },
      },
    });

    expect(config.codex).toMatchObject({
      command: "custom app-server",
      approvalPolicy: "on-request",
      threadSandbox: "danger-full-access",
      turnSandboxPolicy: { type: "dangerFullAccess" },
    });
  });

  it("normalizes valid per-state limits and ignores invalid entries", () => {
    const config = resolve({
      tracker: { kind: "test" },
      agent: {
        max_concurrent_agents_by_state: {
          " In Progress ": 2,
          Todo: 0,
          Rework: "three",
          "": 4,
        },
      },
    });

    expect(config.agent.maxConcurrentAgentsByState).toEqual(
      new Map([["in progress", 2]]),
    );
  });

  it("requires an implementation-supported tracker adapter", () => {
    expect(() =>
      resolve({
        tracker: {
          kind: "not-installed",
          active_states: [],
          terminal_states: [],
        },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "config_validation_error" }),
    );
  });

  it("requires states when an adapter does not publish defaults", () => {
    const profile: TrackerConfigProfile = {
      kind: "without-defaults",
      secretEnvironmentNames: [],
      resolveProvider: (provider) => provider,
    };
    expect(() =>
      resolve(
        { tracker: { kind: "without-defaults" } },
        { trackerProfiles: new Map([[profile.kind, profile]]) },
      ),
    ).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining("active_states"),
      }),
    );
  });

  it("validates fresh-attempt states and their non-active failure lane", () => {
    const config = resolve({
      tracker: {
        kind: "test",
        active_states: ["Todo", "Rework"],
        terminal_states: ["Done"],
        fresh_attempt_states: ["Rework"],
        fresh_attempt_failure_state: "Human Review",
      },
    });
    expect(config.tracker).toMatchObject({
      freshAttemptStates: ["Rework"],
      freshAttemptFailureState: "Human Review",
    });

    expect(() =>
      resolve({
        tracker: {
          kind: "test",
          active_states: ["Todo"],
          fresh_attempt_states: ["Rework"],
          fresh_attempt_failure_state: "Human Review",
        },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "config_validation_error" }),
    );
    expect(() =>
      resolve({
        tracker: {
          kind: "test",
          active_states: ["Todo", "Rework"],
          fresh_attempt_states: ["Rework"],
        },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "config_validation_error" }),
    );
    expect(() =>
      resolve({
        tracker: {
          kind: "test",
          active_states: ["Todo", "Rework"],
          fresh_attempt_states: ["Rework"],
          fresh_attempt_failure_state: "Todo",
        },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "config_validation_error" }),
    );
  });

  it("does not silently accept pre-spec aliases", () => {
    const config = resolve({
      tracker: { kind: "test" },
      polling: { interval_seconds: 45 },
      agent: { max_concurrent: 1 },
    });
    expect(config.polling.intervalMs).toBe(30_000);
    expect(config.agent.maxConcurrentAgents).toBe(10);
  });
});
