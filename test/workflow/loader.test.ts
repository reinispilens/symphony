import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadWorkflow, selectWorkflowPath } from "../../src/workflow/loader.js";
import { withTempDirectory } from "../support/factories.js";

describe("workflow path selection and loading", () => {
  it("uses the explicit path before the cwd default", () => {
    expect(selectWorkflowPath("config/agent.md", "/repo")).toBe(
      "/repo/config/agent.md",
    );
    expect(selectWorkflowPath(undefined, "/repo")).toBe("/repo/WORKFLOW.md");
  });

  it("loads the selected file and reports its absolute path", async () => {
    await withTempDirectory(async (directory) => {
      const configDirectory = path.join(directory, "config");
      await mkdir(configDirectory);
      const workflowPath = path.join(configDirectory, "agent.md");
      await writeFile(workflowPath, "Prompt\n", "utf8");

      const loaded = await loadWorkflow(workflowPath);
      expect(loaded.path).toBe(workflowPath);
      expect(loaded.definition.promptTemplate).toBe("Prompt");
    });
  });

  it("returns a typed error when the workflow cannot be read", async () => {
    await expect(
      loadWorkflow("/definitely/missing/WORKFLOW.md"),
    ).rejects.toMatchObject({
      code: "missing_workflow_file",
    });
  });
});
