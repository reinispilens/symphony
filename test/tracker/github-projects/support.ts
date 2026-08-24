import type { GraphqlClient } from "../../../src/tracker/github-projects/gh-graphql-client.js";

export interface FakeCall {
  readonly document: string;
  readonly variables: Readonly<Record<string, unknown>>;
}

export class FakeGraphqlClient implements GraphqlClient {
  readonly calls: FakeCall[] = [];
  readonly #responses: Array<unknown | Error>;

  constructor(responses: Array<unknown | Error>) {
    this.#responses = [...responses];
  }

  async request(
    document: string,
    variables: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    this.calls.push({ document, variables });
    const response = this.#responses.shift();
    if (response === undefined)
      throw new Error("FakeGraphqlClient has no response queued");
    if (response instanceof Error) throw response;
    return response;
  }
}

export interface RawItemOptions {
  readonly assigneeId?: string | null;
  readonly body?: string | null;
  readonly createdAt?: string | null;
  readonly id?: string;
  readonly issueNodeId?: string;
  readonly issueState?: string;
  readonly labels?: readonly string[];
  readonly labelsCursor?: string | null;
  readonly labelsHaveNextPage?: boolean;
  readonly number?: number;
  readonly owner?: string;
  readonly priority?: string | null;
  readonly projectNumber?: number;
  readonly projectOwner?: string;
  readonly repo?: string;
  readonly status?: string | null;
  readonly statusValueId?: string;
  readonly statusUpdatedAt?: string;
  readonly title?: string;
  readonly type?: string;
  readonly updatedAt?: string | null;
}

export function rawItem(options: RawItemOptions = {}) {
  const owner = options.owner ?? "acme";
  const repo = options.repo ?? "widgets";
  const type = options.type ?? "Issue";
  const statusValue =
    options.status === null
      ? null
      : {
          __typename: "ProjectV2ItemFieldSingleSelectValue",
          id: options.statusValueId ?? "PVTFSV_1",
          name: options.status ?? "Todo",
          updatedAt: options.statusUpdatedAt ?? "2026-08-21T11:00:00Z",
        };
  const priorityValue =
    options.priority === null
      ? null
      : {
          __typename: "ProjectV2ItemFieldSingleSelectValue",
          name: options.priority ?? "P1",
        };

  return {
    __typename: "ProjectV2Item",
    id: options.id ?? "PVTI_1",
    isArchived: false,
    project: {
      id: "PVT_28",
      number: options.projectNumber ?? 28,
      owner: {
        __typename: "Organization",
        login: options.projectOwner ?? "acme",
      },
    },
    statusValue,
    priorityValue,
    content:
      type === "Issue"
        ? {
            __typename: "Issue",
            id: options.issueNodeId ?? "I_1",
            number: options.number ?? 123,
            title: options.title ?? "Do the work",
            body: options.body === undefined ? "Details" : options.body,
            url: `https://github.test/${owner}/${repo}/issues/${options.number ?? 123}`,
            state: options.issueState ?? "OPEN",
            createdAt:
              options.createdAt === undefined
                ? "2026-08-20T10:00:00Z"
                : options.createdAt,
            updatedAt:
              options.updatedAt === undefined
                ? "2026-08-21T10:00:00Z"
                : options.updatedAt,
            repository: {
              name: repo,
              nameWithOwner: `${owner}/${repo}`,
              owner: { login: owner },
            },
            labels: {
              nodes: (options.labels ?? ["Ready"]).map((name) => ({ name })),
              pageInfo: {
                hasNextPage: options.labelsHaveNextPage ?? false,
                endCursor: options.labelsCursor ?? null,
              },
            },
            assignees: {
              nodes:
                options.assigneeId === null
                  ? []
                  : [{ id: options.assigneeId ?? "U_1" }],
            },
          }
        : { __typename: type, title: options.title ?? "Unsupported card" },
  };
}

export function projectPage(
  nodes: readonly unknown[],
  page: {
    readonly hasNextPage?: boolean;
    readonly endCursor?: string | null;
  } = {},
) {
  return {
    repository: {
      owner: {
        __typename: "Organization",
        projectV2: {
          id: "PVT_28",
          number: 28,
          items: {
            nodes,
            pageInfo: {
              hasNextPage: page.hasNextPage ?? false,
              endCursor: page.endCursor ?? null,
            },
          },
        },
      },
    },
  };
}

export function labelPage(
  names: readonly string[],
  page: {
    readonly hasNextPage?: boolean;
    readonly endCursor?: string | null;
  } = {},
) {
  return {
    node: {
      __typename: "Issue",
      labels: {
        nodes: names.map((name) => ({ name })),
        pageInfo: {
          hasNextPage: page.hasNextPage ?? false,
          endCursor: page.endCursor ?? null,
        },
      },
    },
  };
}

export const config = {
  agentStatusTargets: [] as readonly string[],
  hostname: "github.com",
  owner: "acme",
  priorityField: "Priority",
  projectNumber: 28,
  repo: "widgets",
  statusField: "Status",
  timeoutMs: 30_000,
} as const;
