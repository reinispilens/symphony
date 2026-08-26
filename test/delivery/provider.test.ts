import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ExternalDeliveryProvider,
  type DeliveryProviderRequest,
} from "../../src/delivery/provider.js";
import { withTempDirectory } from "../support/factories.js";

function request(): DeliveryProviderRequest {
  return {
    protocolVersion: 1,
    operation: "observe",
    idempotencyKey: "session-1:observe:head-1",
    sessionId: "session-1",
    controllerGeneration: 3,
    repositoryIdentity: "acme/widgets",
    grant: {
      authority: "owner-gated",
      governingPolicy: {
        repositoryIdentity: "acme/.github",
        path: "agent-system/delivery-policy.json",
        revision: "a".repeat(40),
        digest: `sha256:${"b".repeat(64)}`,
      },
      requiredChecks: ["proof / Protected final"],
    },
    tracker: {
      origin: "tracker",
      issueId: "issue-1",
      state: "Human Review",
      stateVersion: "state-3",
      permitsDelivery: true,
      permitsMerge: false,
      permitsCleanup: true,
      observedAt: "2026-08-26T10:00:00.000Z",
    },
    branch: "symphony/widgets",
    baseRef: "refs/heads/main",
    immutableHeadSha: "c".repeat(40),
  };
}

describe("ExternalDeliveryProvider", () => {
  it("runs one bounded trusted process with only declared credentials", async () => {
    await withTempDirectory(async (directory) => {
      const executable = path.join(directory, "provider.mjs");
      await writeFile(
        executable,
        [
          `#!${process.execPath}`,
          'let input = "";',
          'process.stdin.setEncoding("utf8");',
          'process.stdin.on("data", (chunk) => { input += chunk; });',
          'process.stdin.on("end", () => {',
          "  const request = JSON.parse(input);",
          '  if (process.env.DELIVERY_TOKEN !== "operator-secret") process.exit(91);',
          "  if (process.env.CANDIDATE_SECRET !== undefined) process.exit(92);",
          '  if (JSON.stringify(request).includes("operator-secret")) process.exit(93);',
          "  const head = request.immutableHeadSha;",
          "  process.stdout.write(JSON.stringify({",
          "    protocolVersion: 1,",
          '    outcome: "ok",',
          "    observation: {",
          "      remoteHeadSha: head,",
          "      pullRequest: null,",
          "      requiredChecks: [{",
          '        name: "proof / Protected final",',
          "        headSha: head,",
          '        checkRunId: "100",',
          '        workflowRunId: "200",',
          '        status: "passed",',
          '        observedAt: "2026-08-26T10:01:00.000Z"',
          "      }],",
          "      proof: [{",
          '        id: "proof-100",',
          '        checkName: "proof / Protected final",',
          '        checkRunId: "100",',
          '        workflowRunId: "200",',
          "        sourceSha: head,",
          `        planDigest: "sha256:${"1".repeat(64)}",`,
          `        adapterDigest: "sha256:${"2".repeat(64)}",`,
          `        policyDigest: "sha256:${"3".repeat(64)}",`,
          `        resultDigest: "sha256:${"4".repeat(64)}",`,
          `        evidenceDigest: "sha256:${"5".repeat(64)}",`,
          '        status: "passed",',
          '        recordedAt: "2026-08-26T10:00:30.000Z",',
          '        observedAt: "2026-08-26T10:01:00.000Z"',
          "      }]",
          "    }",
          "  }));",
          "});",
          "",
        ].join("\n"),
      );
      await chmod(executable, 0o755);
      const provider = new ExternalDeliveryProvider({
        executable,
        timeoutMs: 2_000,
        secretEnvironmentNames: ["DELIVERY_TOKEN"],
        environment: {
          PATH: process.env["PATH"],
          DELIVERY_TOKEN: "operator-secret",
          CANDIDATE_SECRET: "must-not-cross",
        },
      });
      await expect(provider.execute(request())).resolves.toMatchObject({
        remoteHeadSha: "c".repeat(40),
        requiredChecks: [
          {
            name: "proof / Protected final",
            status: "passed",
            headSha: "c".repeat(40),
          },
        ],
        proof: [{ id: "proof-100", status: "passed" }],
      });
    });
  });

  it("classifies a nonzero mutation result as ambiguous instead of retry-safe", async () => {
    await withTempDirectory(async (directory) => {
      const executable = path.join(directory, "ambiguous-provider.mjs");
      await writeFile(
        executable,
        `#!${process.execPath}\nprocess.stderr.write("connection lost after request\\n");\nprocess.exit(17);\n`,
      );
      await chmod(executable, 0o755);
      const provider = new ExternalDeliveryProvider({
        executable,
        timeoutMs: 2_000,
        secretEnvironmentNames: [],
        environment: { PATH: process.env["PATH"] },
      });
      await expect(provider.execute(request())).rejects.toMatchObject({
        code: "delivery_provider_failed",
        message: expect.stringContaining("ambiguous"),
      });
    });
  });
});
