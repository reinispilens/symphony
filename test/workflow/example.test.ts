import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { issue } from "../support/factories.js";
import { githubProjectsConfigProfile } from "../../src/tracker/github-projects/profile.js";
import { resolveServiceConfig } from "../../src/workflow/config.js";
import { loadWorkflow } from "../../src/workflow/loader.js";
import { renderPrompt } from "../../src/workflow/prompt.js";

const examplePath = fileURLToPath(
  new URL("../../WORKFLOW.example.md", import.meta.url),
);

describe("WORKFLOW.example.md", () => {
  it("remains a parseable migration reference with a strictly renderable prompt", async () => {
    const loaded = await loadWorkflow(examplePath);
    const config = resolveServiceConfig(loaded.definition, {
      workflowPath: loaded.path,
      trackerProfiles: new Map([
        [githubProjectsConfigProfile.kind, githubProjectsConfigProfile],
      ]),
      environment: {},
    });

    expect(config.deployment).toBeNull();

    expect(config.workspace).toMatchObject({
      provider: "git-worktree",
      root: "/absolute/path/to/repository-workspaces",
    });
    expect(config.repository).toEqual({
      identity: "your-owner/your-repository",
      hostname: "github.com",
      baseRef: "refs/remotes/origin/main",
      branchPrefix: "symphony/",
      profileDigest: null,
    });
    expect(config.preparation).toEqual({
      driver: "pnpm",
      frozenLockfile: true,
      lifecycleScripts: false,
      timeoutMs: 300_000,
    });
    expect(config.hooks).toMatchObject({
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
    });
    expect(config.agent.maxConcurrentAgents).toBe(1);
    expect(config.tracker.provider["agent_status_targets"]).toEqual([
      "In Progress",
      "Human Review",
      "Done",
    ]);
    await expect(
      renderPrompt(loaded.definition.promptTemplate, issue(), null),
    ).resolves.toContain("SYM-123: Build the safe foundation");
  });
});
