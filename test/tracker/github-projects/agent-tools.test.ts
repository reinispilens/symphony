import { describe, expect, it } from "vitest";

import { TrackerError } from "../../../src/tracker/errors.js";
import { GitHubProjectsAgentToolRuntime } from "../../../src/tracker/github-projects/agent-tools.js";
import { issue } from "../../support/factories.js";
import { config, FakeGraphqlClient } from "./support.js";

function githubIssue() {
  return issue({
    id: "PVTI_1",
    identifier: "widgets#123",
    native_ref: {
      issue_node_id: "I_1",
      number: 123,
      owner: "acme",
      project_item_id: "PVTI_1",
      repo: "widgets",
    },
  });
}

function commentPage(
  nodes: readonly unknown[],
  page: {
    readonly hasNextPage?: boolean;
    readonly endCursor?: string | null;
  } = {},
) {
  return {
    node: {
      __typename: "Issue",
      comments: {
        nodes,
        pageInfo: {
          hasNextPage: page.hasNextPage ?? false,
          endCursor: page.endCursor ?? null,
        },
      },
    },
  };
}

function statusField(
  options: readonly { readonly id: string; readonly name: string }[],
) {
  return {
    repository: {
      owner: {
        projectV2: {
          id: "PVT_28",
          number: 28,
          field: {
            __typename: "ProjectV2SingleSelectField",
            id: "FIELD_STATUS",
            name: "Status",
            options,
          },
        },
      },
    },
  };
}

describe("GitHub Projects provider-native agent tools", () => {
  it("advertises only the workpad tool until status targets are explicitly authorized", () => {
    const withoutTargets = new GitHubProjectsAgentToolRuntime(
      new FakeGraphqlClient([]),
      config,
      githubIssue(),
    );
    const withTargets = new GitHubProjectsAgentToolRuntime(
      new FakeGraphqlClient([]),
      { ...config, agentStatusTargets: ["In Progress", "Human Review"] },
      githubIssue(),
    );
    const freshAttempt = new GitHubProjectsAgentToolRuntime(
      new FakeGraphqlClient([]),
      config,
      githubIssue(),
      { freshAttempt: true },
    );

    expect(withoutTargets.specs.map((spec) => spec.name)).toEqual([
      "github_issue_workpad_upsert",
      "github_issue_comments_list",
    ]);
    expect(withTargets.specs.map((spec) => spec.name)).toEqual([
      "github_issue_workpad_upsert",
      "github_issue_comments_list",
      "github_project_status_update",
    ]);
    expect(withTargets.specs[2]?.inputSchema["properties"]).toMatchObject({
      status: { enum: ["In Progress", "Human Review"] },
    });
    expect(freshAttempt.specs.map((spec) => spec.name)).toContain(
      "github_pull_request_close",
    );
  });

  it("lists reviewer comments without exposing the managed workpad", async () => {
    const client = new FakeGraphqlClient([
      commentPage([
        {
          id: "C_WORKPAD",
          body: "## Agent Workpad\n\nRejected attempt",
          url: "https://github.test/workpad",
        },
        {
          id: "C_REVIEW",
          body: "P1: callback can bypass the network guard",
          url: "https://github.test/review",
          author: { login: "reviewer" },
          createdAt: "2026-08-24T08:00:00Z",
        },
      ]),
    ]);
    const runtime = new GitHubProjectsAgentToolRuntime(
      client,
      config,
      githubIssue(),
    );

    await expect(
      runtime.execute("github_issue_comments_list", {}),
    ).resolves.toEqual({
      success: true,
      output: {
        comments: [
          {
            author: "reviewer",
            body: "P1: callback can bypass the network guard",
            created_at: "2026-08-24T08:00:00Z",
            id: "C_REVIEW",
            url: "https://github.test/review",
          },
        ],
        truncated: false,
      },
    });
  });

  it("deletes only the managed workpad for a driver-owned reset", async () => {
    const client = new FakeGraphqlClient([
      commentPage([
        { id: "C_REVIEW", body: "Keep this finding", url: null },
        { id: "C_WORKPAD", body: "## Agent Workpad\n\nOld", url: null },
      ]),
      { deleteIssueComment: { clientMutationId: null } },
    ]);
    const runtime = new GitHubProjectsAgentToolRuntime(
      client,
      config,
      githubIssue(),
    );

    await expect(runtime.resetWorkpad()).resolves.toBeUndefined();
    expect(client.calls[1]?.variables).toEqual({ commentId: "C_WORKPAD" });
  });

  it("persists a blocker before handing a refused fresh attempt to humans", async () => {
    const blockerBody = expect.stringContaining(
      "could not create a fresh branch",
    );
    const client = new FakeGraphqlClient([
      commentPage([]),
      {
        addComment: {
          commentEdge: {
            node: {
              id: "C_BLOCKER",
              body: "## Agent Workpad\n\n### Fresh-attempt provisioning blocker\n\ncould not create a fresh branch\n\nSymphony refused this attempt before launching Codex. The rejected workspace was not reused.\n",
              url: null,
            },
          },
        },
      },
      statusField([{ id: "OPT_REVIEW", name: "Human Review" }]),
      {
        updateProjectV2ItemFieldValue: {
          projectV2Item: {
            id: "PVTI_1",
            statusValue: {
              __typename: "ProjectV2ItemFieldSingleSelectValue",
              name: "Human Review",
            },
          },
        },
      },
    ]);
    const runtime = new GitHubProjectsAgentToolRuntime(
      client,
      config,
      githubIssue(),
    );

    await expect(
      runtime.refuse("could not create a fresh branch", "Human Review"),
    ).resolves.toBeUndefined();
    expect(client.calls[1]?.variables).toMatchObject({ body: blockerBody });
    expect(client.calls[3]?.variables).toMatchObject({
      optionId: "OPT_REVIEW",
    });
  });

  it("closes a repository-local stale pull request only in a fresh attempt", async () => {
    const client = new FakeGraphqlClient([
      {
        repository: {
          pullRequest: {
            id: "PR_76",
            number: 76,
            state: "OPEN",
            url: "https://github.test/acme/widgets/pull/76",
          },
        },
      },
      {
        closePullRequest: {
          pullRequest: {
            id: "PR_76",
            number: 76,
            state: "CLOSED",
            url: "https://github.test/acme/widgets/pull/76",
          },
        },
      },
    ]);
    const runtime = new GitHubProjectsAgentToolRuntime(
      client,
      config,
      githubIssue(),
      { freshAttempt: true },
    );

    await expect(
      runtime.execute("github_pull_request_close", { number: 76 }),
    ).resolves.toMatchObject({
      success: true,
      output: { action: "closed", number: 76, state: "CLOSED" },
    });
    expect(client.calls[1]?.variables).toEqual({ pullRequestId: "PR_76" });
  });

  it("creates the managed workpad when the issue has none", async () => {
    const client = new FakeGraphqlClient([
      commentPage([]),
      {
        addComment: {
          commentEdge: {
            node: {
              id: "COMMENT_1",
              body: "## Agent Workpad\n\nPlan\n",
              url: "https://github.test/comment/1",
            },
          },
        },
      },
    ]);
    const runtime = new GitHubProjectsAgentToolRuntime(
      client,
      config,
      githubIssue(),
    );

    await expect(
      runtime.execute("github_issue_workpad_upsert", { content: "Plan" }),
    ).resolves.toEqual({
      success: true,
      output: {
        action: "created",
        comment_id: "COMMENT_1",
        issue_number: 123,
        url: "https://github.test/comment/1",
      },
    });
    expect(client.calls[1]?.variables).toEqual({
      issueId: "I_1",
      body: "## Agent Workpad\n\nPlan\n",
    });
  });

  it("paginates comments and edits the one existing workpad in place", async () => {
    const oldBody = "## Agent Workpad\n\nOld\n";
    const newBody = "## Agent Workpad\n\nNew evidence\n";
    const client = new FakeGraphqlClient([
      commentPage([{ id: "C_OTHER", body: "Hello", url: null }], {
        hasNextPage: true,
        endCursor: "page-2",
      }),
      commentPage([{ id: "C_WORKPAD", body: oldBody, url: null }]),
      {
        updateIssueComment: {
          issueComment: {
            id: "C_WORKPAD",
            body: newBody,
            url: "https://github.test/comment/workpad",
          },
        },
      },
    ]);
    const runtime = new GitHubProjectsAgentToolRuntime(
      client,
      config,
      githubIssue(),
    );

    await expect(
      runtime.execute("github_issue_workpad_upsert", {
        content: "New evidence",
      }),
    ).resolves.toMatchObject({
      success: true,
      output: { action: "updated", comment_id: "C_WORKPAD" },
    });
    expect(client.calls.map((call) => call.variables)).toEqual([
      { id: "I_1", cursor: null },
      { id: "I_1", cursor: "page-2" },
      { commentId: "C_WORKPAD", body: newBody },
    ]);
  });

  it("refuses ambiguous duplicate workpads and invalid arguments", async () => {
    const duplicateClient = new FakeGraphqlClient([
      commentPage([
        { id: "C_1", body: "## Agent Workpad\n\nOne", url: null },
        { id: "C_2", body: "## Agent Workpad\n\nTwo", url: null },
      ]),
    ]);
    const duplicateRuntime = new GitHubProjectsAgentToolRuntime(
      duplicateClient,
      config,
      githubIssue(),
    );
    await expect(
      duplicateRuntime.execute("github_issue_workpad_upsert", {
        content: "Replacement",
      }),
    ).resolves.toMatchObject({
      success: false,
      error: { code: "tracker_response" },
    });

    const invalidClient = new FakeGraphqlClient([]);
    const invalidRuntime = new GitHubProjectsAgentToolRuntime(
      invalidClient,
      config,
      githubIssue(),
    );
    await expect(
      invalidRuntime.execute("github_issue_workpad_upsert", { content: "" }),
    ).resolves.toMatchObject({
      success: false,
      error: { code: "invalid_arguments" },
    });
    expect(invalidClient.calls).toHaveLength(0);
  });

  it("updates only a configured status target and verifies the returned item", async () => {
    const client = new FakeGraphqlClient([
      statusField([
        { id: "OPT_TODO", name: "Todo" },
        { id: "OPT_REVIEW", name: "Human Review" },
      ]),
      {
        updateProjectV2ItemFieldValue: {
          projectV2Item: {
            id: "PVTI_1",
            statusValue: {
              __typename: "ProjectV2ItemFieldSingleSelectValue",
              name: "Human Review",
            },
          },
        },
      },
    ]);
    const runtime = new GitHubProjectsAgentToolRuntime(
      client,
      { ...config, agentStatusTargets: ["Human Review"] },
      githubIssue(),
    );

    await expect(
      runtime.execute("github_project_status_update", {
        status: "human review",
      }),
    ).resolves.toEqual({
      success: true,
      output: { project_item_id: "PVTI_1", status: "Human Review" },
    });
    expect(client.calls[1]?.variables).toEqual({
      projectId: "PVT_28",
      itemId: "PVTI_1",
      fieldId: "FIELD_STATUS",
      optionId: "OPT_REVIEW",
      statusField: "Status",
    });
  });

  it("rejects unauthorized statuses and out-of-scope native references before mutation", async () => {
    const client = new FakeGraphqlClient([]);
    const runtime = new GitHubProjectsAgentToolRuntime(
      client,
      { ...config, agentStatusTargets: ["Human Review"] },
      githubIssue(),
    );
    await expect(
      runtime.execute("github_project_status_update", { status: "Merging" }),
    ).resolves.toMatchObject({
      success: false,
      error: { code: "status_not_authorized" },
    });

    const outOfScope = new GitHubProjectsAgentToolRuntime(
      client,
      { ...config, agentStatusTargets: ["Human Review"] },
      issue({
        id: "PVTI_1",
        native_ref: {
          issue_node_id: "I_1",
          number: 123,
          owner: "someone-else",
          project_item_id: "PVTI_1",
          repo: "widgets",
        },
      }),
    );
    await expect(
      outOfScope.execute("github_project_status_update", {
        status: "Human Review",
      }),
    ).resolves.toMatchObject({
      success: false,
      error: { code: "tracker_response" },
    });
    expect(client.calls).toHaveLength(0);
  });

  it("returns retryable tracker failures as structured tool results", async () => {
    const client = new FakeGraphqlClient([
      new TrackerError("tracker_rate_limited", "slow down", {
        retryable: true,
      }),
    ]);
    const runtime = new GitHubProjectsAgentToolRuntime(
      client,
      config,
      githubIssue(),
    );

    await expect(
      runtime.execute("github_issue_workpad_upsert", { content: "Plan" }),
    ).resolves.toEqual({
      success: false,
      error: {
        code: "tracker_rate_limited",
        message: "slow down",
        details: { retryable: true },
      },
    });
  });
});
