import { Liquid } from "liquidjs";

import type { Issue } from "../domain/issue.js";
import { issueForTemplate } from "../domain/issue.js";
import { SymphonyError, errorMessage } from "../errors.js";
import type { RepositoryContentSnapshot } from "../state/model.js";

export interface PromptAuthorityContext {
  readonly workSessionId: string;
  readonly doctrine: RepositoryContentSnapshot | null;
  readonly governanceManifest: RepositoryContentSnapshot | null;
  readonly trackerPolicy: RepositoryContentSnapshot | null;
}

function contentReference(reference: RepositoryContentSnapshot | null) {
  return reference === null
    ? null
    : {
        repository_identity: reference.repositoryIdentity,
        path: reference.path,
        revision: reference.revision,
        digest: reference.digest,
      };
}

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
  authority: PromptAuthorityContext | null = null,
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
      work_session: authority === null ? null : { id: authority.workSessionId },
      governance:
        authority === null
          ? null
          : {
              doctrine: contentReference(authority.doctrine),
              manifest: contentReference(authority.governanceManifest),
              tracker_policy: contentReference(authority.trackerPolicy),
            },
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
