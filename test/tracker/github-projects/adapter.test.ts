import { describe, expect, it, vi } from "vitest";

import type { Logger } from "../../../src/observability/logger.js";
import { GitHubProjectsAdapter } from "../../../src/tracker/github-projects/adapter.js";
import {
  config,
  FakeGraphqlClient,
  labelPage,
  projectPage,
  rawItem,
} from "./support.js";

function adapter(client: FakeGraphqlClient, logger?: Logger) {
  return new GitHubProjectsAdapter({
    activeStates: ["Todo", "In Progress"],
    client,
    config,
    ...(logger === undefined ? {} : { logger }),
  });
}

describe("GitHubProjectsAdapter.fetchIssuesByStates", () => {
  it("does not call GitHub for an empty state list", async () => {
    const client = new FakeGraphqlClient([]);
    await expect(adapter(client).fetchIssuesByStates([])).resolves.toEqual([]);
    expect(client.calls).toHaveLength(0);
  });

  it("normalizes an exact-repository issue and derives explicit dispatchability", async () => {
    const client = new FakeGraphqlClient([
      projectPage([
        rawItem({
          labels: [" Ready ", "ready", "", "Backend"],
          priority: "P0",
          body: null,
          updatedAt: "not-a-date",
        }),
      ]),
    ]);

    const issues = await adapter(client).fetchIssuesByStates([" todo "]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({
      id: "PVTI_1",
      native_ref: {
        issue_node_id: "I_1",
        number: 123,
        owner: "acme",
        project_item_id: "PVTI_1",
        repo: "widgets",
      },
      identifier: "widgets#123",
      title: "Do the work",
      description: null,
      priority: 1,
      state: "Todo",
      state_version:
        "df6d122daea2f4615ebaf476b03cd2ea3e03835d3559273311fcaeb284d8699d",
      branch_name: null,
      url: "https://github.test/acme/widgets/issues/123",
      assignee_id: "U_1",
      labels: ["ready", "backend"],
      blocked_by: [],
      dispatchable: true,
      created_at: new Date("2026-08-20T10:00:00Z"),
      updated_at: null,
    });
    expect(client.calls[0]?.variables).toMatchObject({
      owner: "acme",
      repo: "widgets",
      projectNumber: 28,
      cursor: null,
      statusField: "Status",
      priorityField: "Priority",
    });
  });

  it("returns active closed issues with dispatchable false for scheduler visibility", async () => {
    const client = new FakeGraphqlClient([
      projectPage([rawItem({ issueState: "CLOSED" })]),
    ]);
    const issues = await adapter(client).fetchIssuesByStates(["Todo"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.dispatchable).toBe(false);
  });

  it("does not accept date-only provider metadata as an RFC 3339 instant", async () => {
    const client = new FakeGraphqlClient([
      projectPage([
        rawItem({ createdAt: "2026-08-20", updatedAt: "2026-08-21" }),
      ]),
    ]);
    const issues = await adapter(client).fetchIssuesByStates(["Todo"]);
    expect(issues[0]).toMatchObject({ created_at: null, updated_at: null });
  });

  it("walks project pages in provider order", async () => {
    const client = new FakeGraphqlClient([
      projectPage([rawItem({ id: "PVTI_1", number: 1 })], {
        hasNextPage: true,
        endCursor: "cursor-1",
      }),
      projectPage([rawItem({ id: "PVTI_2", number: 2 })]),
    ]);
    const issues = await adapter(client).fetchIssuesByStates(["Todo"]);
    expect(issues.map((entry) => entry.id)).toEqual(["PVTI_1", "PVTI_2"]);
    expect(client.calls.map((call) => call.variables["cursor"])).toEqual([
      null,
      "cursor-1",
    ]);
  });

  it("paginates labels and normalizes across page boundaries", async () => {
    const client = new FakeGraphqlClient([
      projectPage([
        rawItem({
          labels: ["First"],
          labelsHaveNextPage: true,
          labelsCursor: "labels-1",
        }),
      ]),
      labelPage(["SECOND", " first "]),
    ]);
    const issues = await adapter(client).fetchIssuesByStates(["Todo"]);
    expect(issues[0]?.labels).toEqual(["first", "second"]);
    expect(client.calls[1]?.variables).toEqual({
      id: "I_1",
      cursor: "labels-1",
    });
  });

  it("logs and omits malformed and out-of-scope state-list cards", async () => {
    const warn = vi.fn();
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
    };
    const malformed = rawItem({ id: "BAD", title: "" });
    const wrongRepo = rawItem({ id: "OTHER", repo: "other" });
    const valid = rawItem({ id: "GOOD", number: 3 });
    const client = new FakeGraphqlClient([
      projectPage([malformed, wrongRepo, valid]),
    ]);

    const issues = await adapter(client, logger).fetchIssuesByStates(["Todo"]);
    expect(issues.map((entry) => entry.id)).toEqual(["GOOD"]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("fails atomically when pagination repeats a cursor", async () => {
    const client = new FakeGraphqlClient([
      projectPage([rawItem({ id: "PVTI_1" })], {
        hasNextPage: true,
        endCursor: "same",
      }),
      projectPage([rawItem({ id: "PVTI_2" })], {
        hasNextPage: true,
        endCursor: "same",
      }),
    ]);
    await expect(
      adapter(client).fetchIssuesByStates(["Todo"]),
    ).rejects.toMatchObject({
      category: "tracker_pagination",
    });
  });
});

describe("GitHubProjectsAdapter.fetchIssuesByIds", () => {
  it("does not call GitHub for an empty ID set", async () => {
    const client = new FakeGraphqlClient([]);
    await expect(adapter(client).fetchIssuesByIds([])).resolves.toEqual([]);
    expect(client.calls).toHaveLength(0);
  });

  it("deduplicates input, returns full snapshots, and omits invisible IDs", async () => {
    const client = new FakeGraphqlClient([
      {
        nodes: [rawItem({ id: "PVTI_1", status: "Human Review" }), null],
      },
    ]);
    const issues = await adapter(client).fetchIssuesByIds([
      "PVTI_1",
      "PVTI_1",
      "MISSING",
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      id: "PVTI_1",
      state: "Human Review",
      dispatchable: false,
    });
    expect(client.calls[0]?.variables["ids"]).toEqual(["PVTI_1", "MISSING"]);
  });

  it("omits a requested item that moved outside configured project scope", async () => {
    const client = new FakeGraphqlClient([
      { nodes: [rawItem({ id: "PVTI_1", projectNumber: 29 })] },
    ]);
    await expect(adapter(client).fetchIssuesByIds(["PVTI_1"])).resolves.toEqual(
      [],
    );
  });

  it("fails the whole refresh when a requested in-scope item is malformed", async () => {
    const client = new FakeGraphqlClient([
      { nodes: [rawItem({ id: "PVTI_1", title: "" })] },
    ]);
    await expect(
      adapter(client).fetchIssuesByIds(["PVTI_1"]),
    ).rejects.toMatchObject({
      category: "tracker_response",
      message: expect.stringContaining("PVTI_1"),
    });
  });

  it("rejects duplicate or unrequested provider output", async () => {
    const duplicateClient = new FakeGraphqlClient([
      { nodes: [rawItem({ id: "PVTI_1" }), rawItem({ id: "PVTI_1" })] },
    ]);
    await expect(
      adapter(duplicateClient).fetchIssuesByIds(["PVTI_1"]),
    ).rejects.toMatchObject({
      category: "tracker_response",
    });

    const extraClient = new FakeGraphqlClient([
      { nodes: [rawItem({ id: "EXTRA" })] },
    ]);
    await expect(
      adapter(extraClient).fetchIssuesByIds(["PVTI_1"]),
    ).rejects.toMatchObject({
      category: "tracker_response",
    });
  });

  it("batches opaque ID refreshes at GitHub's 100-node request bound", async () => {
    const firstHundred = Array.from(
      { length: 100 },
      (_, index) => `PVTI_${index + 1}`,
    );
    const requested = [...firstHundred, "PVTI_101"];
    const client = new FakeGraphqlClient([
      {
        nodes: firstHundred.map((id, index) =>
          rawItem({ id, number: index + 1 }),
        ),
      },
      { nodes: [rawItem({ id: "PVTI_101", number: 101 })] },
    ]);

    const issues = await adapter(client).fetchIssuesByIds(requested);
    expect(issues).toHaveLength(101);
    expect(client.calls).toHaveLength(2);
    expect(client.calls[0]?.variables["ids"]).toHaveLength(100);
    expect(client.calls[1]?.variables["ids"]).toEqual(["PVTI_101"]);
  });
});
