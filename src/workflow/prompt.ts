import { Liquid } from "liquidjs";

import type { Issue } from "../domain/issue.js";
import { issueForTemplate } from "../domain/issue.js";
import { SymphonyError, errorMessage } from "../errors.js";

const FALLBACK_PROMPT =
  "You are working on an issue from the configured tracker.";

const engine = new Liquid({
  ownPropertyOnly: true,
  strictFilters: true,
  strictVariables: true,
});

export async function renderPrompt(
  promptTemplate: string,
  issue: Issue,
  attempt: number | null,
): Promise<string> {
  const source =
    promptTemplate.trim() === "" ? FALLBACK_PROMPT : promptTemplate;

  let template;
  try {
    template = engine.parse(source);
  } catch (error) {
    throw new SymphonyError(
      "template_parse_error",
      `Could not parse workflow prompt: ${errorMessage(error)}`,
      {
        cause: error,
        context: { issue_id: issue.id, issue_identifier: issue.identifier },
      },
    );
  }

  try {
    return await engine.render(template, {
      issue: issueForTemplate(issue),
      attempt,
    });
  } catch (error) {
    throw new SymphonyError(
      "template_render_error",
      `Could not render workflow prompt: ${errorMessage(error)}`,
      {
        cause: error,
        context: { issue_id: issue.id, issue_identifier: issue.identifier },
      },
    );
  }
}
