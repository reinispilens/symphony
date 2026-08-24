import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildDaemonHost } from "../../src/cli.js";
import { nullLogger } from "../../src/observability/logger.js";
import { withTempDirectory } from "../support/factories.js";

const fakeAppServer = fileURLToPath(
  new URL("../fixtures/fake-codex-app-server.mjs", import.meta.url),
);

const FAKE_GH = `#!/usr/bin/env node
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  if (process.env.GH_TOKEN !== "parent-token") {
    console.error("HTTP 401: missing parent tracker token");
    process.exit(1);
  }
  const request = JSON.parse(input);
  const statePath = process.env.FAKE_GH_STATE_PATH;
  const configuredState = statePath
    ? require("node:fs").readFileSync(statePath, "utf8").trim()
    : "";
  const status =
    configuredState ||
    (request.query.includes("SymphonyProjectItemsById")
      ? "Human Review"
      : "Todo");
  const item = {
    __typename: "ProjectV2Item",
    id: "PVTI_E2E_1",
    isArchived: false,
    project: {
      id: "PVT_28",
      number: 28,
      owner: { __typename: "Organization", login: "acme" },
    },
    statusValue: {
      __typename: "ProjectV2ItemFieldSingleSelectValue",
      name: status,
    },
    priorityValue: {
      __typename: "ProjectV2ItemFieldSingleSelectValue",
      name: "P1",
    },
    content: {
      __typename: "Issue",
      id: "ISSUE_E2E_1",
      number: 123,
      title: "Exercise the complete daemon",
      body: "Prove every boundary composes.",
      url: "https://github.test/acme/widgets/issues/123",
      state: "OPEN",
      createdAt: "2026-08-23T08:00:00Z",
      updatedAt: "2026-08-23T09:00:00Z",
      repository: {
        name: "widgets",
        nameWithOwner: "acme/widgets",
        owner: { login: "acme" },
      },
      labels: {
        nodes: [{ name: "ready" }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
      assignees: { nodes: [] },
    },
  };
  const data = request.query.includes("SymphonyProjectItemsById")
    ? { nodes: [item] }
    : {
        repository: {
          owner: {
            __typename: "Organization",
            projectV2: {
              id: "PVT_28",
              number: 28,
              items: {
                nodes: [item],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      };
  process.stdout.write(JSON.stringify({ data }));
});
`;

async function eventually(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline)
      throw new Error(`condition did not become true within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("isolated daemon end-to-end", () => {
  it("composes retry release and normal-poll terminal cleanup through the repository hook", async () => {
    await withTempDirectory(async (directory) => {
      const binDirectory = path.join(directory, "bin");
      const workspaceRoot = path.join(directory, "workspaces");
      const workflowPath = path.join(directory, "WORKFLOW.md");
      const trackerStatePath = path.join(directory, "tracker-state");
      const beforeRemoveLog = path.join(directory, "before-remove.log");
      await mkdir(binDirectory, { recursive: true });
      const ghPath = path.join(binDirectory, "gh");
      await writeFile(ghPath, FAKE_GH, "utf8");
      await chmod(ghPath, 0o755);
      await writeFile(trackerStatePath, "Todo", "utf8");
      const logMessages: string[] = [];
      const testLogger = {
        ...nullLogger,
        info(message: string) {
          logMessages.push(message);
        },
      };
      await writeFile(
        workflowPath,
        `---
tracker:
  kind: github-projects
  provider:
    owner: acme
    repo: widgets
    project: 28
  active_states: [Todo, In Progress]
  terminal_states: [Done, Cancelled]
  required_labels: [ready]
polling:
  interval_ms: 50
workspace:
  provider: harness
  root: ${workspaceRoot}
hooks:
  after_create: 'printf "prepared\\n" > prepared.txt'
  before_run: 'printf "before\\n" >> lifecycle.log'
  after_run: 'printf "after:%s\\n" "$SYMPHONY_RUN_STATUS" >> lifecycle.log; printf "Human Review" > "$SYMPHONY_WORKFLOW_DIR/tracker-state"'
  before_remove: 'printf "before_remove:%s\\n" "$SYMPHONY_ISSUE_IDENTIFIER" > "$SYMPHONY_WORKFLOW_DIR/before-remove.log"; rm prepared.txt lifecycle.log; rmdir "$SYMPHONY_WORKSPACE_PATH"'
agent:
  max_concurrent_agents: 1
  max_turns: 2
  max_retry_backoff_ms: 10000
codex:
  command: node ${JSON.stringify(fakeAppServer)}
  read_timeout_ms: 1000
  turn_timeout_ms: 1000
  stall_timeout_ms: 5000
---
Work on {{ issue.identifier }}: {{ issue.title }}.
`,
        "utf8",
      );

      const host = await buildDaemonHost({
        workflowPath,
        logger: testLogger,
        environment: {
          PATH: `${binDirectory}:${process.env["PATH"] ?? ""}`,
          GH_TOKEN: "parent-token",
          FAKE_GH_STATE_PATH: trackerStatePath,
          FAKE_CODEX_SCENARIO: "normal",
          FAKE_CODEX_TITLE_PREFIX: "widgets#123",
        },
      });
      const waitForHost = async (
        predicate: () => boolean | Promise<boolean>,
      ): Promise<void> => {
        try {
          await eventually(predicate);
        } catch (error) {
          throw new Error(
            `daemon condition failed: ${JSON.stringify({
              logs: logMessages,
              snapshot: host.snapshot(),
              tracker_state: await readFile(trackerStatePath, "utf8"),
            })}`,
            { cause: error },
          );
        }
      };
      try {
        await host.start();
        expect(host.snapshot().counts.running).toBe(1);
        await waitForHost(() =>
          logMessages.includes("retry outcome=scheduled"),
        );
        await waitForHost(
          () =>
            host.snapshot().counts.running === 0 &&
            host.snapshot().counts.retrying === 0,
        );

        const workspaceNames = await readdir(workspaceRoot);
        expect(workspaceNames).toHaveLength(1);
        const workspacePath = path.join(workspaceRoot, workspaceNames[0]!);
        expect(
          await readFile(path.join(workspacePath, "prepared.txt"), "utf8"),
        ).toBe("prepared\n");
        expect(
          await readFile(path.join(workspacePath, "lifecycle.log"), "utf8"),
        ).toBe("before\nafter:succeeded\n");
        expect(host.snapshot().codex_totals).toMatchObject({
          input_tokens: 12,
          output_tokens: 9,
          total_tokens: 21,
        });

        await writeFile(trackerStatePath, "Cancelled", "utf8");
        await waitForHost(() => existsSync(beforeRemoveLog));
        await waitForHost(
          async () => (await readdir(workspaceRoot)).length === 0,
        );
        expect(await readFile(beforeRemoveLog, "utf8")).toBe(
          "before_remove:widgets#123\n",
        );
      } finally {
        await host.stop();
      }
    });
  }, 90_000);
});
