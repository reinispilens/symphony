import { parseDocument } from "yaml";

import { SymphonyError, errorMessage } from "../errors.js";
import { isRecord, toJsonObject, type JsonObject } from "../shared/json.js";

export interface WorkflowDefinition {
  readonly config: JsonObject;
  readonly promptTemplate: string;
}

function parseFrontMatter(source: string): JsonObject {
  let document;
  try {
    document = parseDocument(source, { prettyErrors: false });
  } catch (error) {
    throw new SymphonyError(
      "workflow_parse_error",
      `Could not parse workflow YAML: ${errorMessage(error)}`,
      {
        cause: error,
      },
    );
  }

  if (document.errors.length > 0) {
    const message = document.errors.map((error) => error.message).join("; ");
    throw new SymphonyError(
      "workflow_parse_error",
      `Could not parse workflow YAML: ${message}`,
    );
  }

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 100 });
  } catch (error) {
    throw new SymphonyError(
      "workflow_parse_error",
      `Could not decode workflow YAML: ${errorMessage(error)}`,
      {
        cause: error,
      },
    );
  }

  if (!isRecord(value)) {
    throw new SymphonyError(
      "workflow_front_matter_not_a_map",
      "Workflow YAML front matter must decode to an object",
    );
  }

  try {
    return toJsonObject(value, "workflow front matter");
  } catch (error) {
    throw new SymphonyError("workflow_parse_error", errorMessage(error), {
      cause: error,
    });
  }
}

export function parseWorkflow(source: string): WorkflowDefinition {
  const lines = source.split(/\r?\n/u);
  if (lines[0] !== "---") {
    return { config: {}, promptTemplate: source.trim() };
  }

  const closingOffset = lines.slice(1).findIndex((line) => line === "---");
  if (closingOffset === -1) {
    throw new SymphonyError(
      "workflow_parse_error",
      "Workflow YAML front matter starts with '---' but has no closing '---' line",
    );
  }

  const closingIndex = closingOffset + 1;
  const config = parseFrontMatter(lines.slice(1, closingIndex).join("\n"));
  const promptTemplate = lines
    .slice(closingIndex + 1)
    .join("\n")
    .trim();
  return { config, promptTemplate };
}
