import { describe, expect, it, vi } from "vitest";

import {
  GitHubDeliveryProvider,
  GitHubGitRefPusher,
  parseGitHubDeliveryProviderRequest,
  type GitCommandPort,
  type GitHubHttpPort,
  type GitHubHttpResponse,
} from "../../src/delivery/github-provider.js";
import type { DeliveryProviderRequest } from "../../src/delivery/provider.js";

const HEAD_SHA = "d".repeat(40);
const CHECK_NAME = "test";

function request(
  operation: DeliveryProviderRequest["operation"] = "observe",
): DeliveryProviderRequest {
  const common = {
    protocolVersion: 1 as const,
    idempotencyKey: "delivery:test",
    sessionId: "session-1",
    controllerGeneration: 3,
    repositoryIdentity: "acme/widgets",
    grant: {
      authority: "owner-gated" as const,
      governingPolicy: {
        repositoryIdentity: "acme/.github",
        path: "agent-system/tracker-policy.json",
        revision: "a".repeat(40),
        digest: `sha256:${"b".repeat(64)}`,
      },
      requiredChecks: [CHECK_NAME],
    },
    tracker: {
      origin: "tracker" as const,
      issueId: "issue-1",
      state: "Human Review",
      stateVersion: "state-version-1",
      permittedOperations: [
        "materialize",
        "push",
        "openPullRequest",
        "observeChecks",
        "observeMerge",
        "releaseRemoteBranch",
        "cleanupWorkspace",
      ] as const,
      permitsDelivery: true,
      permitsMerge: false,
      permitsCleanup: true,
      observedAt: "2026-08-26T10:00:00.000Z",
    },
    branch: "symphony/widgets",
    baseRef: "refs/remotes/origin/main",
    immutableHeadSha: HEAD_SHA,
  };
  switch (operation) {
    case "observe":
      return { ...common, operation };
    case "push":
      return {
        ...common,
        operation,
        sourceRoot: "/repositories/widgets",
        expectedRemoteHeadSha: null,
      };
    case "open_pull_request":
      return {
        ...common,
        operation,
        title: "Deliver widgets",
        body: "Changes",
      };
    case "merge_pull_request":
    case "close_pull_request":
      return { ...common, operation, pullRequestId: "42" };
    case "delete_remote_branch":
      return {
        ...common,
        operation,
        sourceRoot: "/repositories/widgets",
        expectedRemoteHeadSha: HEAD_SHA,
      };
  }
}

class FakeHttp implements GitHubHttpPort {
  readonly calls: Array<{
    readonly kind: "bytes" | "json";
    readonly method: string;
    readonly path: string;
    readonly body?: unknown;
  }> = [];
  readonly bytes = new Map<string, GitHubHttpResponse<Buffer>>();
  readonly json = new Map<string, GitHubHttpResponse<unknown>>();

  async requestJson(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<GitHubHttpResponse<unknown>> {
    this.calls.push({
      kind: "json",
      method,
      path,
      ...(body === undefined ? {} : { body }),
    });
    const response = this.json.get(`${method} ${path}`);
    if (response === undefined)
      throw new Error(`Unexpected HTTP ${method} ${path}`);
    return response;
  }

  async requestBytes(path: string): Promise<GitHubHttpResponse<Buffer>> {
    this.calls.push({ kind: "bytes", method: "GET", path });
    const response = this.bytes.get(path);
    if (response === undefined) throw new Error(`Unexpected bytes GET ${path}`);
    return response;
  }
}

function observationHttp(): FakeHttp {
  const http = new FakeHttp();
  const repository = "/repos/acme/widgets";
  http.json.set(`GET ${repository}/git/ref/heads/symphony%2Fwidgets`, {
    status: 200,
    body: { object: { sha: HEAD_SHA } },
  });
  http.json.set(
    `GET ${repository}/pulls?state=all&head=acme%3Asymphony%2Fwidgets&base=main&per_page=100`,
    {
      status: 200,
      body: [
        {
          number: 42,
          html_url: "https://github.com/acme/widgets/pull/42",
          state: "open",
          merged_at: null,
          merge_commit_sha: null,
          head: { ref: "symphony/widgets", sha: HEAD_SHA },
          base: { ref: "main" },
        },
      ],
    },
  );
  http.json.set(
    `GET ${repository}/commits/${HEAD_SHA}/check-runs?check_name=test&filter=latest&per_page=100`,
    {
      status: 200,
      body: {
        check_runs: [
          {
            id: 100,
            name: CHECK_NAME,
            head_sha: HEAD_SHA,
            status: "completed",
            conclusion: "success",
            details_url:
              "https://github.com/acme/widgets/actions/runs/200/job/300",
            completed_at: "2026-08-26T10:05:00.000Z",
            app: { slug: "github-actions" },
          },
        ],
      },
    },
  );
  return http;
}

describe("GitHubDeliveryProvider", () => {
  it("observes an ordinary required check on the exact delivery head", async () => {
    const http = observationHttp();
    const provider = new GitHubDeliveryProvider({
      http,
      refs: { push: vi.fn(), delete: vi.fn() },
    });

    await expect(provider.execute(request())).resolves.toMatchObject({
      remoteHeadSha: HEAD_SHA,
      pullRequest: {
        id: "42",
        baseRef: "refs/remotes/origin/main",
        headRef: "symphony/widgets",
        headSha: HEAD_SHA,
      },
      requiredChecks: [
        {
          name: CHECK_NAME,
          status: "passed",
          checkRunId: "100",
          workflowRunId: "200",
        },
      ],
    });
  });

  it("refuses merge when the product grant and live lane do not both authorize it", async () => {
    const provider = new GitHubDeliveryProvider({
      http: new FakeHttp(),
      refs: { push: vi.fn(), delete: vi.fn() },
    });
    const merge = request("merge_pull_request");
    await expect(
      provider.execute({
        ...merge,
        tracker: {
          ...merge.tracker,
          permittedOperations: [
            ...merge.tracker.permittedOperations,
            "mergePullRequest",
          ],
          permitsMerge: true,
        },
      }),
    ).rejects.toMatchObject({
      code: "delivery_provider_refused",
      message: expect.stringContaining("full-in-scope"),
    });
  });

  it("strictly decodes the process request and rejects undeclared fields", () => {
    expect(parseGitHubDeliveryProviderRequest(request())).toEqual(request());
    expect(() =>
      parseGitHubDeliveryProviderRequest({
        ...request(),
        candidateGrant: true,
      }),
    ).toThrow(/missing or unknown fields/u);
  });
});

describe("GitHubGitRefPusher", () => {
  it("keeps the token out of argv and uses exact compare-and-swap refspecs", async () => {
    const calls: Parameters<GitCommandPort["execute"]>[] = [];
    const command: GitCommandPort = {
      async execute(...args) {
        calls.push(args);
        return { exitCode: 0, stderr: "" };
      },
    };
    const refs = new GitHubGitRefPusher({
      command,
      gitExecutable: "/usr/bin/git",
      hostname: "github.com",
      token: "operator-secret",
    });

    await refs.push(
      request("push") as Extract<
        DeliveryProviderRequest,
        { operation: "push" }
      >,
    );
    await refs.delete(
      request("delete_remote_branch") as Extract<
        DeliveryProviderRequest,
        { operation: "delete_remote_branch" }
      >,
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]?.[1]).toContain(
      `--force-with-lease=refs/heads/symphony/widgets:`,
    );
    expect(calls[0]?.[1]).toContain(`${HEAD_SHA}:refs/heads/symphony/widgets`);
    expect(calls[1]?.[1]).toContain(
      `--force-with-lease=refs/heads/symphony/widgets:${HEAD_SHA}`,
    );
    expect(calls[1]?.[1]).toContain(":refs/heads/symphony/widgets");
    expect(JSON.stringify(calls.map((entry) => entry[1]))).not.toContain(
      "operator-secret",
    );
    expect(calls[0]?.[2]["GIT_CONFIG_VALUE_0"]).toBe(
      `Authorization: Basic ${Buffer.from("x-access-token:operator-secret").toString("base64")}`,
    );
  });
});
