import { readFile } from "node:fs/promises";
import path from "node:path";

import { SymphonyError, errorMessage } from "../errors.js";
import { parseWorkflow, type WorkflowDefinition } from "./definition.js";

export interface LoadedWorkflow {
  readonly definition: WorkflowDefinition;
  readonly path: string;
  readonly source: string;
}

export function selectWorkflowPath(
  explicitPath: string | undefined,
  cwd = process.cwd(),
): string {
  return path.resolve(cwd, explicitPath ?? "WORKFLOW.md");
}

export async function loadWorkflow(
  workflowPath: string,
): Promise<LoadedWorkflow> {
  const absolutePath = path.resolve(workflowPath);
  let source: string;
  try {
    source = await readFile(absolutePath, "utf8");
  } catch (error) {
    throw new SymphonyError(
      "missing_workflow_file",
      `Could not read workflow file at ${absolutePath}: ${errorMessage(error)}`,
      { cause: error, context: { workflow_path: absolutePath } },
    );
  }

  return { definition: parseWorkflow(source), path: absolutePath, source };
}
