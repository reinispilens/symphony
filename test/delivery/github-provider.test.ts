import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";

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
const CONTROL_DIGEST = "2".repeat(64);
const POLICY_DIGEST = "3".repeat(64);
const RECEIPT_DIGEST = "4".repeat(64);
const CHECK_NAME = "proof / Protected proof v2 / final";
const CALLER_WORKFLOW = ".github/workflows/protected-proof-v2.yml";
const CONTROL_REPOSITORY = "acme/workspace-control-plane";
const CONTROL_REVISION = "c".repeat(40);
const CONTROL_WORKFLOW = ".github/workflows/protected-proof-v2.yml";

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, stableJson(record[key])]),
  );
}

const PLAN_IDENTITY = {
  schemaVersion: 2,
  correlation: {
    repository: "acme/widgets",
    eventName: "pull_request_target",
    runId: 200,
    runAttempt: 1,
    callerWorkflowRef: `acme/widgets/${CALLER_WORKFLOW}@refs/heads/main`,
    controlWorkflowRepository: CONTROL_REPOSITORY,
    controlWorkflowSha: CONTROL_REVISION,
  },
  source: { head: { commit: HEAD_SHA } },
  authority: {
    controlSourceRepository: CONTROL_REPOSITORY,
    controlSourceRevision: CONTROL_REVISION,
    controlSourceSha256: CONTROL_DIGEST,
    headPolicySha256: POLICY_DIGEST,
  },
};
const PLAN_DIGEST = createHash("sha256")
  .update(JSON.stringify(stableJson(PLAN_IDENTITY)))
  .digest("hex");

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
    proofAuthority: {
      kind: "github-actions-reusable-workflow-v1" as const,
      requiredCheck: CHECK_NAME,
      eventName: "pull_request_target" as const,
      callerWorkflowPath: CALLER_WORKFLOW,
      controlWorkflow: {
        repositoryIdentity: CONTROL_REPOSITORY,
        path: CONTROL_WORKFLOW,
        revision: CONTROL_REVISION,
      },
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
      return { ...common, operation, title: "Deliver widgets", body: "Proof" };
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

function storedZip(name: string, value: unknown): Buffer {
  const filename = Buffer.from(name);
  const data = Buffer.from(JSON.stringify(value));
  const checksum = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(data.byteLength, 18);
  local.writeUInt32LE(data.byteLength, 22);
  local.writeUInt16LE(filename.byteLength, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(data.byteLength, 20);
  central.writeUInt32LE(data.byteLength, 24);
  central.writeUInt16LE(filename.byteLength, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt32LE(0, 42);

  const centralOffset =
    local.byteLength + filename.byteLength + data.byteLength;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.byteLength + filename.byteLength, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, filename, data, central, filename, eocd]);
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
    `GET ${repository}/commits/${HEAD_SHA}/check-runs?check_name=proof+%2F+Protected+proof+v2+%2F+final&filter=latest&per_page=100`,
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
  http.json.set(`GET ${repository}/actions/runs/200`, {
    status: 200,
    body: {
      id: 200,
      run_attempt: 1,
      event: "pull_request_target",
      head_sha: HEAD_SHA,
      path: CALLER_WORKFLOW,
      referenced_workflows: [
        {
          path: `${CONTROL_REPOSITORY}/${CONTROL_WORKFLOW}@${CONTROL_REVISION}`,
          sha: CONTROL_REVISION,
        },
      ],
      repository: { full_name: "acme/widgets" },
      created_at: "2026-08-26T10:01:00.000Z",
    },
  });
  http.json.set(`GET ${repository}/actions/runs/200/artifacts?per_page=100`, {
    status: 200,
    body: {
      artifacts: [
        {
          id: 400,
          name: "protected-proof-v2-plan-200-1",
          expired: false,
        },
        {
          id: 401,
          name: "protected-proof-v2-result-200-1",
          expired: false,
        },
      ],
    },
  });
  http.bytes.set(`${repository}/actions/artifacts/400/zip`, {
    status: 200,
    body: storedZip("plan.json", {
      ...PLAN_IDENTITY,
      digest: PLAN_DIGEST,
    }),
  });
  http.bytes.set(`${repository}/actions/artifacts/401/zip`, {
    status: 200,
    body: storedZip("result.json", {
      schemaVersion: 2,
      repository: "acme/widgets",
      sourceCommit: HEAD_SHA,
      planDigest: PLAN_DIGEST,
      status: "non_verdict",
      cleanup: "complete",
      laneResults: [
        { laneId: "repository-proof", receiptSha256: RECEIPT_DIGEST },
      ],
    }),
  });
  return http;
}

describe("GitHubDeliveryProvider", () => {
  it("uses protected artifacts to reject a false-green non-verdict check", async () => {
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
          status: "non_verdict",
          checkRunId: "100",
          workflowRunId: "200",
        },
      ],
      proof: [
        {
          id: "github-actions:200:100",
          sourceSha: HEAD_SHA,
          planDigest: `sha256:${PLAN_DIGEST}`,
          adapterDigest: `sha256:${CONTROL_DIGEST}`,
          policyDigest: `sha256:${POLICY_DIGEST}`,
          status: "non_verdict",
        },
      ],
    });
  });

  it("refuses a check whose workflow run did not invoke the pinned control workflow", async () => {
    const http = observationHttp();
    const key = "GET /repos/acme/widgets/actions/runs/200";
    const response = http.json.get(key)!;
    http.json.set(key, {
      ...response,
      body: {
        ...(response.body as Record<string, unknown>),
        referenced_workflows: [
          {
            path: `attacker/fake-control/${CONTROL_WORKFLOW}@${CONTROL_REVISION}`,
            sha: CONTROL_REVISION,
          },
        ],
      },
    });
    const provider = new GitHubDeliveryProvider({
      http,
      refs: { push: vi.fn(), delete: vi.fn() },
    });

    await expect(provider.execute(request())).rejects.toMatchObject({
      code: "delivery_provider_refused",
      message: expect.stringContaining("pinned repository"),
    });
  });

  it("refuses a proof ZIP whose local entry disagrees with its signed directory", async () => {
    const http = observationHttp();
    const key = "/repos/acme/widgets/actions/artifacts/400/zip";
    const response = http.bytes.get(key)!;
    const archive = Buffer.from(response.body);
    archive[30] = "x".charCodeAt(0);
    http.bytes.set(key, { ...response, body: archive });
    const provider = new GitHubDeliveryProvider({
      http,
      refs: { push: vi.fn(), delete: vi.fn() },
    });

    await expect(provider.execute(request())).rejects.toMatchObject({
      code: "delivery_provider_failed",
      message: expect.stringContaining("local entry"),
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
