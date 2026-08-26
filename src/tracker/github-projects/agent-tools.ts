import type { Issue } from "../../domain/issue.js";
import { errorMessage } from "../../errors.js";
import type {
  AgentToolResult,
  AgentToolRuntime,
  AgentToolSpec,
} from "../../agent/tools.js";
import { isRecord, type JsonValue } from "../../shared/json.js";
import { TrackerError } from "../errors.js";
import type { GraphqlClient } from "./gh-graphql-client.js";
import {
  CLOSE_PULL_REQUEST_MUTATION,
  CREATE_ISSUE_WORKPAD_MUTATION,
  DELETE_ISSUE_WORKPAD_MUTATION,
  ISSUE_WORKPAD_COMMENTS_QUERY,
  PULL_REQUEST_QUERY,
  PROJECT_STATUS_FIELD_QUERY,
  UPDATE_ISSUE_WORKPAD_MUTATION,
  UPDATE_PROJECT_STATUS_MUTATION,
} from "./graphql.js";
import type { GitHubProjectsConfig } from "./profile.js";

const WORKPAD_HEADING = "## Agent Workpad";
const WORKPAD_HEADING_PATTERN = /^## Agent Workpad\s*$/mu;
const MAX_AGENT_VISIBLE_COMMENTS = 300;

interface NativeIssueRef {
  readonly issueNodeId: string;
  readonly issueNumber: number;
  readonly projectItemId: string;
}

interface WorkpadComment {
  readonly author: string | null;
  readonly body: string;
  readonly createdAt: string | null;
  readonly id: string;
  readonly url: string | null;
}

interface CommentPage {
  readonly comments: readonly WorkpadComment[];
  readonly truncated: boolean;
}

export interface GitHubProjectsAgentToolRuntimeOptions {
  readonly freshAttempt?: boolean;
}

interface PageInfo {
  readonly endCursor: string | null;
  readonly hasNextPage: boolean;
}

function success(output: JsonValue): AgentToolResult {
  return { success: true, output };
}

function failure(
  code: string,
  message: string,
  details?: JsonValue,
): AgentToolResult {
  return {
    success: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TrackerError("tracker_response", `${label} must be an object`);
  }
  return value;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TrackerError(
      "tracker_response",
      `${label} must be a non-empty string`,
    );
  }
  return value;
}

function pageInfo(value: unknown, label: string): PageInfo {
  const raw = record(value, label);
  if (typeof raw["hasNextPage"] !== "boolean") {
    throw new TrackerError(
      "tracker_pagination",
      `${label}.hasNextPage must be a boolean`,
    );
  }
  const cursor = raw["endCursor"];
  if (cursor !== null && cursor !== undefined && typeof cursor !== "string") {
    throw new TrackerError(
      "tracker_pagination",
      `${label}.endCursor must be a string or null`,
    );
  }
  return {
    hasNextPage: raw["hasNextPage"],
    endCursor: typeof cursor === "string" ? cursor : null,
  };
}

function nextCursor(info: PageInfo, seen: Set<string>, label: string): string {
  if (info.endCursor === null || info.endCursor === "") {
    throw new TrackerError(
      "tracker_pagination",
      `${label} has another page but no end cursor`,
    );
  }
  if (seen.has(info.endCursor)) {
    throw new TrackerError(
      "tracker_pagination",
      `${label} repeated cursor ${info.endCursor}`,
    );
  }
  seen.add(info.endCursor);
  return info.endCursor;
}

function nativeIssueRef(
  issue: Issue,
  config: GitHubProjectsConfig,
): NativeIssueRef {
  const native = issue.native_ref;
  if (native === null) {
    throw new TrackerError(
      "tracker_response",
      `Issue ${issue.identifier} has no GitHub native_ref`,
    );
  }

  const owner = native["owner"];
  const repo = native["repo"];
  const projectItemId = native["project_item_id"];
  const issueNodeId = native["issue_node_id"];
  const issueNumber = native["number"];
  if (
    typeof owner !== "string" ||
    owner.toLowerCase() !== config.owner.toLowerCase() ||
    typeof repo !== "string" ||
    repo.toLowerCase() !== config.repo.toLowerCase() ||
    typeof projectItemId !== "string" ||
    projectItemId !== issue.id ||
    typeof issueNodeId !== "string" ||
    issueNodeId === "" ||
    !Number.isSafeInteger(issueNumber) ||
    (issueNumber as number) <= 0
  ) {
    throw new TrackerError(
      "tracker_response",
      `Issue ${issue.identifier} has an invalid or out-of-scope GitHub native_ref`,
    );
  }
  return {
    issueNodeId,
    issueNumber: issueNumber as number,
    projectItemId,
  };
}

function workpadBody(argumentsValue: JsonValue): string | null {
  if (!isRecord(argumentsValue)) return null;
  const content = argumentsValue["content"];
  if (typeof content !== "string" || content.trim() === "") return null;
  return `${WORKPAD_HEADING}\n\n${content.trim()}\n`;
}

function requestedStatus(argumentsValue: JsonValue): string | null {
  if (!isRecord(argumentsValue)) return null;
  const status = argumentsValue["status"];
  return typeof status === "string" && status.trim() !== ""
    ? status.trim()
    : null;
}

function requestedPullRequest(argumentsValue: JsonValue): number | null {
  if (!isRecord(argumentsValue)) return null;
  const number = argumentsValue["number"];
  return Number.isSafeInteger(number) && (number as number) > 0
    ? (number as number)
    : null;
}

function trackerFailure(error: unknown): AgentToolResult {
  if (error instanceof TrackerError) {
    return failure(error.category, error.message, {
      retryable: error.retryable,
    });
  }
  return failure("tool_execution_failed", errorMessage(error));
}

export class GitHubProjectsAgentToolRuntime implements AgentToolRuntime {
  readonly specs: readonly AgentToolSpec[];
  readonly #client: GraphqlClient;
  readonly #config: GitHubProjectsConfig;
  readonly #issue: Issue;
  readonly #statusTargets: ReadonlyMap<string, string>;

  constructor(
    client: GraphqlClient,
    config: GitHubProjectsConfig,
    issue: Issue,
    options: GitHubProjectsAgentToolRuntimeOptions = {},
  ) {
    this.#client = client;
    this.#config = config;
    this.#issue = issue;
    this.#statusTargets = new Map(
      config.agentStatusTargets.map((status) => [status.toLowerCase(), status]),
    );

    const specs: AgentToolSpec[] = [
      {
        name: "github_issue_workpad_upsert",
        description:
          "Create or replace this issue's single Agent Workpad comment. Supply only the Markdown below the managed heading.",
        inputSchema: {
          type: "object",
          properties: {
            content: {
              type: "string",
              minLength: 1,
              description:
                "Markdown for Plan, Acceptance Criteria, Validation, Notes, Confusions, and the environment stamp.",
            },
          },
          required: ["content"],
          additionalProperties: false,
        },
      },
      {
        name: "github_issue_comments_list",
        description:
          "List this issue's ordinary comments, excluding the managed Agent Workpad. Use this to read reviewer findings that survive a fresh attempt.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    ];
    if (options.freshAttempt === true) {
      specs.push({
        name: "github_pull_request_close",
        description:
          "Close one stale pull request in this configured repository while handling a fresh-attempt issue.",
        inputSchema: {
          type: "object",
          properties: {
            number: {
              type: "integer",
              minimum: 1,
              description: "Repository-local pull request number.",
            },
          },
          required: ["number"],
          additionalProperties: false,
        },
      });
    }
    if (config.agentStatusTargets.length > 0) {
      specs.push({
        name: "github_project_status_update",
        description:
          "Move this issue's existing Project card to one of the workflow-authorized agent status targets.",
        inputSchema: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: [...config.agentStatusTargets],
            },
          },
          required: ["status"],
          additionalProperties: false,
        },
      });
    }
    this.specs = specs;
  }

  async execute(
    name: string,
    argumentsValue: JsonValue,
  ): Promise<AgentToolResult> {
    try {
      switch (name) {
        case "github_issue_workpad_upsert":
          return await this.#upsertWorkpad(argumentsValue);
        case "github_issue_comments_list":
          return await this.#listComments(argumentsValue);
        case "github_pull_request_close":
          return await this.#closePullRequest(argumentsValue);
        case "github_project_status_update":
          return await this.#updateStatus(argumentsValue);
        default:
          return failure(
            "unsupported_tool",
            `GitHub Projects adapter does not implement tool '${name}'`,
          );
      }
    } catch (error) {
      return trackerFailure(error);
    }
  }

  async resetWorkpad(): Promise<void> {
    const native = nativeIssueRef(this.#issue, this.#config);
    const current = await this.#findWorkpad(native.issueNodeId);
    if (current === null) return;
    const data = await this.#client.request(DELETE_ISSUE_WORKPAD_MUTATION, {
      commentId: current.id,
    });
    const root = record(data, "workpad deletion data");
    record(root["deleteIssueComment"], "deleteIssueComment");
  }

  async setStatusForOrchestration(target: string): Promise<void> {
    const result = await this.#setStatus(target);
    if (!result.success) {
      throw new TrackerError(
        "tracker_response",
        `Could not select orchestration status '${target}': ${result.error.message}`,
      );
    }
  }

  async refuse(reason: string, failureState: string): Promise<void> {
    const cleanReason = reason.trim();
    if (cleanReason === "" || failureState.trim() === "") {
      throw new TrackerError(
        "tracker_response",
        "Fresh-attempt refusal requires a reason and failure state",
      );
    }
    const result = await this.#upsertWorkpad({
      content: [
        "### Fresh-attempt provisioning blocker",
        "",
        cleanReason,
        "",
        "Symphony refused this attempt before launching Codex. The rejected workspace was not reused.",
      ].join("\n"),
    });
    if (!result.success) {
      throw new TrackerError(
        "tracker_response",
        `Could not persist fresh-attempt blocker: ${result.error.message}`,
      );
    }
    await this.#setStatus(failureState.trim());
  }

  async #upsertWorkpad(argumentsValue: JsonValue): Promise<AgentToolResult> {
    const body = workpadBody(argumentsValue);
    if (body === null) {
      return failure(
        "invalid_arguments",
        "github_issue_workpad_upsert requires non-empty string content",
      );
    }
    const native = nativeIssueRef(this.#issue, this.#config);
    const current = await this.#findWorkpad(native.issueNodeId);
    const data =
      current === null
        ? await this.#client.request(CREATE_ISSUE_WORKPAD_MUTATION, {
            issueId: native.issueNodeId,
            body,
          })
        : await this.#client.request(UPDATE_ISSUE_WORKPAD_MUTATION, {
            commentId: current.id,
            body,
          });

    const root = record(data, "workpad mutation data");
    const comment =
      current === null
        ? record(
            record(
              record(root["addComment"], "addComment")["commentEdge"],
              "addComment.commentEdge",
            )["node"],
            "created workpad comment",
          )
        : record(
            record(root["updateIssueComment"], "updateIssueComment")[
              "issueComment"
            ],
            "updated workpad comment",
          );
    const commentId = nonEmptyString(comment["id"], "workpad comment id");
    if (comment["body"] !== body) {
      throw new TrackerError(
        "tracker_response",
        "GitHub workpad mutation did not return the requested body",
      );
    }
    return success({
      action: current === null ? "created" : "updated",
      comment_id: commentId,
      issue_number: native.issueNumber,
      url: typeof comment["url"] === "string" ? comment["url"] : null,
    });
  }

  async #comments(
    issueNodeId: string,
    limit: number | null,
  ): Promise<CommentPage> {
    const found: WorkpadComment[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    let truncated = false;

    for (;;) {
      const data = await this.#client.request(ISSUE_WORKPAD_COMMENTS_QUERY, {
        id: issueNodeId,
        cursor,
      });
      const root = record(data, "workpad comments data");
      const node = record(root["node"], "workpad issue");
      if (node["__typename"] !== "Issue") {
        throw new TrackerError(
          "tracker_response",
          `GitHub node ${issueNodeId} is not an Issue`,
        );
      }
      const comments = record(node["comments"], "issue comments");
      if (!Array.isArray(comments["nodes"])) {
        throw new TrackerError(
          "tracker_response",
          "GitHub issue comments must be a list",
        );
      }
      for (const candidate of comments["nodes"]) {
        if (!isRecord(candidate) || typeof candidate["body"] !== "string") {
          continue;
        }
        if (limit !== null && found.length >= limit) {
          truncated = true;
          break;
        }
        const author = candidate["author"];
        found.push({
          id: nonEmptyString(candidate["id"], "workpad comment id"),
          body: candidate["body"],
          author:
            isRecord(author) && typeof author["login"] === "string"
              ? author["login"]
              : null,
          createdAt:
            typeof candidate["createdAt"] === "string"
              ? candidate["createdAt"]
              : null,
          url: typeof candidate["url"] === "string" ? candidate["url"] : null,
        });
      }

      const info = pageInfo(comments["pageInfo"], "issue comments pageInfo");
      if (limit !== null && found.length >= limit) {
        truncated ||= info.hasNextPage;
        break;
      }
      if (!info.hasNextPage) break;
      cursor = nextCursor(info, seenCursors, "issue comments");
    }

    return { comments: found, truncated };
  }

  async #findWorkpad(issueNodeId: string): Promise<WorkpadComment | null> {
    const page = await this.#comments(issueNodeId, null);
    const found = page.comments.filter((comment) =>
      WORKPAD_HEADING_PATTERN.test(comment.body),
    );

    if (found.length > 1) {
      throw new TrackerError(
        "tracker_response",
        `Issue ${this.#issue.identifier} has multiple Agent Workpad comments`,
      );
    }
    return found[0] ?? null;
  }

  async #listComments(argumentsValue: JsonValue): Promise<AgentToolResult> {
    if (!isRecord(argumentsValue) || Object.keys(argumentsValue).length > 0) {
      return failure(
        "invalid_arguments",
        "github_issue_comments_list accepts an empty object",
      );
    }
    const native = nativeIssueRef(this.#issue, this.#config);
    const page = await this.#comments(
      native.issueNodeId,
      MAX_AGENT_VISIBLE_COMMENTS,
    );
    return success({
      comments: page.comments
        .filter((comment) => !WORKPAD_HEADING_PATTERN.test(comment.body))
        .map((comment) => ({
          author: comment.author,
          body: comment.body,
          created_at: comment.createdAt,
          id: comment.id,
          url: comment.url,
        })),
      truncated: page.truncated,
    });
  }

  async #updateStatus(argumentsValue: JsonValue): Promise<AgentToolResult> {
    const requested = requestedStatus(argumentsValue);
    if (requested === null) {
      return failure(
        "invalid_arguments",
        "github_project_status_update requires a non-empty string status",
      );
    }
    const target = this.#statusTargets.get(requested.toLowerCase());
    if (target === undefined) {
      return failure(
        "status_not_authorized",
        `Status '${requested}' is not an agent-authorized target`,
        { allowed_statuses: [...this.#statusTargets.values()] },
      );
    }
    return await this.#setStatus(target);
  }

  async #setStatus(target: string): Promise<AgentToolResult> {
    const native = nativeIssueRef(this.#issue, this.#config);
    const data = await this.#client.request(PROJECT_STATUS_FIELD_QUERY, {
      owner: this.#config.owner,
      repo: this.#config.repo,
      projectNumber: this.#config.projectNumber,
      statusField: this.#config.statusField,
    });
    const root = record(data, "project status-field data");
    const repository = record(root["repository"], "status-field repository");
    const owner = record(repository["owner"], "status-field owner");
    const project = record(owner["projectV2"], "status-field project");
    const projectId = nonEmptyString(project["id"], "project id");
    if (project["number"] !== this.#config.projectNumber) {
      throw new TrackerError(
        "tracker_response",
        "GitHub returned the wrong Project for a status mutation",
      );
    }
    const field = record(project["field"], "Status field");
    if (field["__typename"] !== "ProjectV2SingleSelectField") {
      throw new TrackerError(
        "tracker_response",
        `Configured field '${this.#config.statusField}' is not single-select`,
      );
    }
    const fieldId = nonEmptyString(field["id"], "Status field id");
    const options = field["options"];
    if (!Array.isArray(options)) {
      throw new TrackerError(
        "tracker_response",
        "GitHub Status field options must be a list",
      );
    }
    const option = options.find(
      (candidate) =>
        isRecord(candidate) &&
        typeof candidate["name"] === "string" &&
        candidate["name"].toLowerCase() === target.toLowerCase(),
    );
    if (!isRecord(option)) {
      return failure(
        "status_not_found",
        `Configured agent status target '${target}' is absent from the Project`,
      );
    }
    const optionId = nonEmptyString(option["id"], "Status option id");

    const mutation = await this.#client.request(
      UPDATE_PROJECT_STATUS_MUTATION,
      {
        projectId,
        itemId: native.projectItemId,
        fieldId,
        optionId,
        statusField: this.#config.statusField,
      },
    );
    const mutationRoot = record(mutation, "status mutation data");
    const payload = record(
      mutationRoot["updateProjectV2ItemFieldValue"],
      "status mutation payload",
    );
    const item = record(payload["projectV2Item"], "updated project item");
    if (item["id"] !== native.projectItemId) {
      throw new TrackerError(
        "tracker_response",
        "GitHub status mutation returned the wrong Project item",
      );
    }
    const value = record(item["statusValue"], "updated Status value");
    if (
      value["__typename"] !== "ProjectV2ItemFieldSingleSelectValue" ||
      typeof value["name"] !== "string" ||
      value["name"].toLowerCase() !== target.toLowerCase()
    ) {
      throw new TrackerError(
        "tracker_response",
        "GitHub status mutation did not return the requested Status",
      );
    }
    return success({
      project_item_id: native.projectItemId,
      status: value["name"],
    });
  }

  async #closePullRequest(argumentsValue: JsonValue): Promise<AgentToolResult> {
    if (!this.specs.some((spec) => spec.name === "github_pull_request_close")) {
      return failure(
        "tool_not_authorized",
        "github_pull_request_close is available only for a configured fresh-attempt state",
      );
    }
    const number = requestedPullRequest(argumentsValue);
    if (number === null) {
      return failure(
        "invalid_arguments",
        "github_pull_request_close requires a positive integer number",
      );
    }
    nativeIssueRef(this.#issue, this.#config);
    const data = await this.#client.request(PULL_REQUEST_QUERY, {
      owner: this.#config.owner,
      repo: this.#config.repo,
      number,
    });
    const root = record(data, "pull-request data");
    const repository = record(root["repository"], "pull-request repository");
    const pullRequest = record(
      repository["pullRequest"],
      `pull request #${number}`,
    );
    if (pullRequest["number"] !== number) {
      throw new TrackerError(
        "tracker_response",
        "GitHub returned the wrong pull request",
      );
    }
    const state = nonEmptyString(pullRequest["state"], "pull request state");
    if (state.toUpperCase() === "CLOSED" || state.toUpperCase() === "MERGED") {
      return success({
        action: "unchanged",
        number,
        state,
        url: typeof pullRequest["url"] === "string" ? pullRequest["url"] : null,
      });
    }
    const pullRequestId = nonEmptyString(pullRequest["id"], "pull request id");
    const mutation = await this.#client.request(CLOSE_PULL_REQUEST_MUTATION, {
      pullRequestId,
    });
    const mutationRoot = record(mutation, "close-pull-request data");
    const payload = record(
      mutationRoot["closePullRequest"],
      "closePullRequest",
    );
    const closed = record(payload["pullRequest"], "closed pull request");
    if (
      closed["number"] !== number ||
      typeof closed["state"] !== "string" ||
      closed["state"].toUpperCase() !== "CLOSED"
    ) {
      throw new TrackerError(
        "tracker_response",
        "GitHub did not return the requested pull request as closed",
      );
    }
    return success({
      action: "closed",
      number,
      state: closed["state"],
      url: typeof closed["url"] === "string" ? closed["url"] : null,
    });
  }
}
