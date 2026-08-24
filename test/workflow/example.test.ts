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
  it("is a valid harness/GitHub workflow with a strictly renderable prompt", async () => {
    const loaded = await loadWorkflow(examplePath);
    const config = resolveServiceConfig(loaded.definition, {
      workflowPath: loaded.path,
      trackerProfiles: new Map([
        [githubProjectsConfigProfile.kind, githubProjectsConfigProfile],
      ]),
      environment: {},
    });

    expect(config.workspace).toMatchObject({
      provider: "harness",
      root: "/absolute/path/to/repository-workspaces",
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
