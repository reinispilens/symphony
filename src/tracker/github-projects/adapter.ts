import { createHash } from "node:crypto";

import type { Issue } from "../../domain/issue.js";
import type { AgentToolRuntime } from "../../agent/tools.js";
import { isRecord } from "../../shared/json.js";
import { nullLogger, type Logger } from "../../observability/logger.js";
import type { FreshAttemptControl, TrackerAdapter } from "../adapter.js";
import { TrackerError } from "../errors.js";
import type { GraphqlClient } from "./gh-graphql-client.js";
import {
  ISSUE_LABELS_QUERY,
  PROJECT_ITEMS_BY_ID_QUERY,
  PROJECT_ITEMS_QUERY,
} from "./graphql.js";
import type { GitHubProjectsConfig } from "./profile.js";
import { GitHubProjectsAgentToolRuntime } from "./agent-tools.js";

const MAX_NODE_IDS_PER_REQUEST = 100;
const PRIORITIES: Readonly<Record<string, number>> = {
  P0: 1,
  P1: 2,
  P2: 3,
  P3: 4,
};
const RFC_3339_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/iu;

class MalformedItemError extends Error {}
class OutOfScopeItemError extends Error {}

interface PageInfo {
  readonly endCursor: string | null;
  readonly hasNextPage: boolean;
}

interface ItemPage {
  readonly nodes: readonly unknown[];
  readonly pageInfo: PageInfo;
}

interface LabelPage {
  readonly labels: readonly string[];
  readonly pageInfo: PageInfo;
}

export interface GitHubProjectsAdapterOptions {
  readonly activeStates: readonly string[];
  readonly freshAttemptStates?: readonly string[];
  readonly client: GraphqlClient;
  readonly config: GitHubProjectsConfig;
  readonly logger?: Logger;
}

function normalizedState(state: string): string {
  return state.trim().toLowerCase();
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value))
    throw new MalformedItemError(`${label} must be an object`);
  return value;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new MalformedItemError(`${label} must be a non-empty string`);
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

function optionalTimestamp(value: unknown): Date | null {
  if (typeof value !== "string" || !RFC_3339_INSTANT.test(value)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

function statusOf(item: Record<string, unknown>): string {
  const statusValue = record(item["statusValue"], "project item Status value");
  if (statusValue["__typename"] !== "ProjectV2ItemFieldSingleSelectValue") {
    throw new MalformedItemError(
      "project item Status value must be a single-select value",
    );
  }
  return nonEmptyString(statusValue["name"], "project item state");
}

function stateVersionOf(item: Record<string, unknown>): string | null {
  const statusValue = record(item["statusValue"], "project item Status value");
  if (statusValue["__typename"] !== "ProjectV2ItemFieldSingleSelectValue") {
    return null;
  }
  const id = statusValue["id"];
  const updatedAt = statusValue["updatedAt"];
  if (
    typeof id !== "string" ||
    id.trim() === "" ||
    typeof updatedAt !== "string" ||
    optionalTimestamp(updatedAt) === null
  ) {
    return null;
  }
  return createHash("sha256")
    .update(`${id}\0${updatedAt}`, "utf8")
    .digest("hex");
}

function priorityOf(item: Record<string, unknown>): number | null {
  const value = item["priorityValue"];
  if (
    !isRecord(value) ||
    value["__typename"] !== "ProjectV2ItemFieldSingleSelectValue"
  )
    return null;
  const name = value["name"];
  return typeof name === "string"
    ? (PRIORITIES[name.trim().toUpperCase()] ?? null)
    : null;
}

function firstAssigneeId(content: Record<string, unknown>): string | null {
  const assignees = content["assignees"];
  if (!isRecord(assignees) || !Array.isArray(assignees["nodes"])) return null;
  for (const candidate of assignees["nodes"]) {
    if (
      isRecord(candidate) &&
      typeof candidate["id"] === "string" &&
      candidate["id"].trim() !== ""
    ) {
      return candidate["id"];
    }
  }
  return null;
}

function labelPage(value: unknown, label: string): LabelPage {
  if (!isRecord(value))
    return { labels: [], pageInfo: { hasNextPage: false, endCursor: null } };
  const nodes = value["nodes"];
  const labels = Array.isArray(nodes)
    ? nodes.flatMap((entry) => {
        if (!isRecord(entry) || typeof entry["name"] !== "string") return [];
        return [entry["name"]];
      })
    : [];
  return { labels, pageInfo: pageInfo(value["pageInfo"], `${label}.pageInfo`) };
}

function normalizeLabels(labels: readonly string[]): readonly string[] {
  const result = new Set<string>();
  for (const label of labels) {
    const normalized = label.trim().toLowerCase();
    if (normalized !== "") result.add(normalized);
  }
  return [...result];
}

function projectOwnerLogin(project: Record<string, unknown>): string {
  const owner = record(project["owner"], "project owner");
  return nonEmptyString(owner["login"], "project owner login");
}

function itemIdForLog(value: unknown): string {
  return isRecord(value) && typeof value["id"] === "string"
    ? value["id"]
    : "unknown";
}

export class GitHubProjectsAdapter implements TrackerAdapter {
  readonly #activeStates: ReadonlySet<string>;
  readonly #freshAttemptStates: ReadonlySet<string>;
  readonly #client: GraphqlClient;
  readonly #config: GitHubProjectsConfig;
  readonly #logger: Logger;

  constructor(options: GitHubProjectsAdapterOptions) {
    this.#activeStates = new Set(options.activeStates.map(normalizedState));
    this.#freshAttemptStates = new Set(
      (options.freshAttemptStates ?? []).map(normalizedState),
    );
    this.#client = options.client;
    this.#config = options.config;
    this.#logger = options.logger ?? nullLogger;
  }

  agentToolRuntime(issue: Issue): AgentToolRuntime {
    return new GitHubProjectsAgentToolRuntime(
      this.#client,
      this.#config,
      issue,
      {
        freshAttempt: this.#freshAttemptStates.has(
          normalizedState(issue.state),
        ),
      },
    );
  }

  freshAttemptControl(issue: Issue): FreshAttemptControl {
    return new GitHubProjectsAgentToolRuntime(
      this.#client,
      this.#config,
      issue,
    );
  }

  async fetchIssuesByStates(
    stateNames: readonly string[],
  ): Promise<readonly Issue[]> {
    const requestedStates = new Set(
      stateNames.map(normalizedState).filter((state) => state !== ""),
    );
    if (requestedStates.size === 0) return [];

    const issues: Issue[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;

    for (;;) {
      const data = await this.#client.request(PROJECT_ITEMS_QUERY, {
        owner: this.#config.owner,
        repo: this.#config.repo,
        projectNumber: this.#config.projectNumber,
        cursor,
        statusField: this.#config.statusField,
        priorityField: this.#config.priorityField,
      });
      const page = this.#projectPage(data);

      for (const candidate of page.nodes) {
        try {
          const item = record(candidate, "project item");
          const state = statusOf(item);
          if (!requestedStates.has(normalizedState(state))) continue;
          issues.push(await this.#normalizeItem(item, state));
        } catch (error) {
          if (
            error instanceof MalformedItemError ||
            error instanceof OutOfScopeItemError
          ) {
            this.#logger.warn(
              "Omitting unusable GitHub Project item from state-list result",
              {
                project_item_id: itemIdForLog(candidate),
                reason: error.message,
              },
            );
            continue;
          }
          throw error;
        }
      }

      if (!page.pageInfo.hasNextPage) break;
      cursor = this.#nextCursor(page.pageInfo, seenCursors, "project items");
    }

    return issues;
  }

  async fetchIssuesByIds(
    issueIds: readonly string[],
  ): Promise<readonly Issue[]> {
    const requested = [...new Set(issueIds.filter((id) => id !== ""))];
    if (requested.length === 0) return [];

    const requestedSet = new Set(requested);
    const seen = new Set<string>();
    const issues: Issue[] = [];

    for (
      let offset = 0;
      offset < requested.length;
      offset += MAX_NODE_IDS_PER_REQUEST
    ) {
      const ids = requested.slice(offset, offset + MAX_NODE_IDS_PER_REQUEST);
      const data = await this.#client.request(PROJECT_ITEMS_BY_ID_QUERY, {
        ids,
        statusField: this.#config.statusField,
        priorityField: this.#config.priorityField,
      });
      const root = this.#responseRecord(data, "ID-refresh data");
      const nodes = root["nodes"];
      if (!Array.isArray(nodes)) {
        throw new TrackerError(
          "tracker_response",
          "GitHub ID-refresh response nodes must be a list",
        );
      }

      for (const candidate of nodes) {
        if (candidate === null) continue;
        if (!isRecord(candidate) || candidate["__typename"] !== "ProjectV2Item")
          continue;
        let id: string;
        try {
          id = nonEmptyString(candidate["id"], "project item id");
        } catch (error) {
          throw this.#malformedRefresh(error, "unknown");
        }
        if (!requestedSet.has(id)) {
          throw new TrackerError(
            "tracker_response",
            `GitHub returned unrequested project item ${id}`,
          );
        }
        if (seen.has(id)) {
          throw new TrackerError(
            "tracker_response",
            `GitHub returned duplicate project item ${id}`,
          );
        }
        seen.add(id);

        try {
          this.#assertItemProject(candidate);
          const state = statusOf(candidate);
          issues.push(await this.#normalizeItem(candidate, state));
        } catch (error) {
          if (error instanceof OutOfScopeItemError) continue;
          if (error instanceof MalformedItemError)
            throw this.#malformedRefresh(error, id);
          throw error;
        }
      }
    }

    return issues;
  }

  #projectPage(data: unknown): ItemPage {
    const root = this.#responseRecord(data, "project-list data");
    const repository = root["repository"];
    const owner = isRecord(repository) ? repository["owner"] : null;
    const project = isRecord(owner) ? owner["projectV2"] : null;
    if (!isRecord(project)) {
      throw new TrackerError(
        "invalid_tracker_config",
        `GitHub repository ${this.#config.owner}/${this.#config.repo} or Project #${this.#config.projectNumber} was not found or is not visible`,
      );
    }
    const items = project["items"];
    if (!isRecord(items) || !Array.isArray(items["nodes"])) {
      throw new TrackerError(
        "tracker_response",
        "GitHub project items must be a list",
      );
    }
    return {
      nodes: items["nodes"],
      pageInfo: pageInfo(items["pageInfo"], "project items pageInfo"),
    };
  }

  async #normalizeItem(
    item: Record<string, unknown>,
    state: string,
  ): Promise<Issue> {
    const projectItemId = nonEmptyString(item["id"], "project item id");
    if (item["isArchived"] === true)
      throw new OutOfScopeItemError("project item is archived");
    this.#assertItemProject(item);

    const content = record(item["content"], "project item content");
    if (content["__typename"] !== "Issue") {
      throw new MalformedItemError(
        "only GitHub Issue project items are supported",
      );
    }
    const issueNodeId = nonEmptyString(content["id"], "issue node id");
    const number = content["number"];
    if (!Number.isSafeInteger(number) || (number as number) <= 0) {
      throw new MalformedItemError("issue number must be a positive integer");
    }
    const title = nonEmptyString(content["title"], "issue title");
    const issueState = nonEmptyString(content["state"], "issue state");
    const repository = record(content["repository"], "issue repository");
    const repositoryOwner = record(
      repository["owner"],
      "issue repository owner",
    );
    const owner = nonEmptyString(
      repositoryOwner["login"],
      "issue repository owner login",
    );
    const repo = nonEmptyString(repository["name"], "issue repository name");
    if (
      owner.toLowerCase() !== this.#config.owner.toLowerCase() ||
      repo.toLowerCase() !== this.#config.repo.toLowerCase()
    ) {
      throw new OutOfScopeItemError(
        `issue belongs to ${owner}/${repo}, outside configured repository`,
      );
    }

    const initialLabels = labelPage(content["labels"], "issue labels");
    const allLabels = await this.#completeLabels(issueNodeId, initialLabels);
    const issueNumber = number as number;
    return {
      id: projectItemId,
      native_ref: {
        issue_node_id: issueNodeId,
        number: issueNumber,
        owner,
        project_item_id: projectItemId,
        repo,
      },
      identifier: `${repo}#${issueNumber}`,
      title,
      description: typeof content["body"] === "string" ? content["body"] : null,
      priority: priorityOf(item),
      state,
      state_version: stateVersionOf(item),
      branch_name: null,
      url:
        typeof content["url"] === "string" && content["url"].trim() !== ""
          ? content["url"]
          : null,
      assignee_id: firstAssigneeId(content),
      labels: normalizeLabels(allLabels),
      blocked_by: [],
      dispatchable:
        issueState.toUpperCase() === "OPEN" &&
        this.#activeStates.has(normalizedState(state)),
      created_at: optionalTimestamp(content["createdAt"]),
      updated_at: optionalTimestamp(content["updatedAt"]),
    };
  }

  #assertItemProject(item: Record<string, unknown>): void {
    const project = record(item["project"], "project item project");
    const number = project["number"];
    const owner = projectOwnerLogin(project);
    if (
      number !== this.#config.projectNumber ||
      owner.toLowerCase() !== this.#config.owner.toLowerCase()
    ) {
      throw new OutOfScopeItemError(
        `project item belongs to ${owner}#${String(number)}, outside configured project`,
      );
    }
  }

  async #completeLabels(
    issueNodeId: string,
    initial: LabelPage,
  ): Promise<readonly string[]> {
    const labels = [...initial.labels];
    const seenCursors = new Set<string>();
    let current = initial.pageInfo;

    while (current.hasNextPage) {
      const cursor = this.#nextCursor(
        current,
        seenCursors,
        `labels for issue ${issueNodeId}`,
      );
      const data = await this.#client.request(ISSUE_LABELS_QUERY, {
        id: issueNodeId,
        cursor,
      });
      const root = this.#responseRecord(data, "label-page data");
      const node = root["node"];
      if (!isRecord(node) || node["__typename"] !== "Issue") {
        throw new TrackerError(
          "tracker_response",
          `Could not continue labels for issue node ${issueNodeId}`,
        );
      }
      const next = labelPage(node["labels"], `labels for issue ${issueNodeId}`);
      labels.push(...next.labels);
      current = next.pageInfo;
    }
    return labels;
  }

  #nextCursor(info: PageInfo, seen: Set<string>, label: string): string {
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

  #responseRecord(value: unknown, label: string): Record<string, unknown> {
    if (!isRecord(value)) {
      throw new TrackerError("tracker_response", `${label} must be an object`);
    }
    return value;
  }

  #malformedRefresh(error: unknown, id: string): TrackerError {
    return new TrackerError(
      "tracker_response",
      `Requested GitHub project item ${id} is malformed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
