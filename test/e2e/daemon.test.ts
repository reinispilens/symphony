import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildDaemonHost } from "../../src/cli.js";
import { nullLogger } from "../../src/observability/logger.js";
import { SqliteSymphonyStateStore } from "../../src/state/sqlite-store.js";
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

function run(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(String(stderr).trim() || error.message));
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}

function digest(bytes: string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function installFakeCodex(binDirectory: string): Promise<void> {
  const codexPath = path.join(binDirectory, "codex");
  await writeFile(
    codexPath,
    `#!/usr/bin/env node
if (process.argv[2] !== "app-server") process.exit(2);
import(${JSON.stringify(fakeAppServer)});
`,
    "utf8",
  );
  await chmod(codexPath, 0o755);
}

async function installFakeProcessBoundary(
  binDirectory: string,
): Promise<{ systemdRun: string; systemctl: string }> {
  const systemdRun = path.join(binDirectory, "systemd-run");
  const systemctl = path.join(binDirectory, "systemctl");
  await writeFile(
    systemdRun,
    '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n',
  );
  await writeFile(
    systemctl,
    `#!${process.execPath}\n` +
      `const args = process.argv.slice(2);\n` +
      `if (args.includes("--property=Version")) { process.stdout.write("Version=259\\n"); process.exit(0); }\n` +
      `if (args[1] === "show") { process.stdout.write("LoadState=not-found\\nActiveState=inactive\\nSubState=dead\\nControlGroup=\\n"); process.exit(0); }\n` +
      `if (args[1] === "kill") process.exit(0);\n` +
      `process.exit(1);\n`,
  );
  await Promise.all([chmod(systemdRun, 0o755), chmod(systemctl, 0o755)]);
  return { systemdRun, systemctl };
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
      await installFakeCodex(binDirectory);
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
  after_run: 'printf "after:%s\\n" "$SYMPHONY_RUN_STATUS" >> lifecycle.log'
  before_remove: 'printf "before_remove:%s\\n" "$SYMPHONY_ISSUE_IDENTIFIER" > "$SYMPHONY_WORKFLOW_DIR/before-remove.log"; rm prepared.txt lifecycle.log; rmdir "$SYMPHONY_WORKSPACE_PATH"'
agent:
  max_concurrent_agents: 1
  max_turns: 2
  max_retry_backoff_ms: 10000
codex:
  command: codex app-server
  read_timeout_ms: 1000
  turn_timeout_ms: 1000
  stall_timeout_ms: 5000
---
Work on {{ issue.identifier }}: {{ issue.title }}.
`,
        "utf8",
      );

      const host = await buildDaemonHost({
        source: { kind: "workflow", path: workflowPath },
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
        // Model the external handoff only after the worker has durably entered retry.
        await writeFile(trackerStatePath, "Human Review", "utf8");
        await waitForHost(
          () =>
            host.snapshot().counts.running === 0 &&
            host.snapshot().counts.retrying === 0,
        );

        const workspaceNames = (await readdir(workspaceRoot)).filter(
          (name) => name !== ".symphony",
        );
        expect(workspaceNames).toHaveLength(1);
        expect(
          existsSync(path.join(workspaceRoot, ".symphony", "state.sqlite")),
        ).toBe(true);
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
          async () =>
            (await readdir(workspaceRoot)).filter(
              (name) => name !== ".symphony",
            ).length === 0,
        );
        expect(await readFile(beforeRemoveLog, "utf8")).toBe(
          "before_remove:widgets#123\n",
        );
      } finally {
        await host.stop();
      }
    });
  }, 90_000);

  it("runs and cleans a managed Git worktree with no product lifecycle hooks", async () => {
    await withTempDirectory(async (directory) => {
      const binDirectory = path.join(directory, "bin");
      const operatorRoot = path.join(directory, "operator");
      const sourceRoot = path.join(directory, "source");
      const stateRoot = path.join(directory, "state");
      const workspaceRoot = path.join(directory, "workspaces");
      const trackerStatePath = path.join(directory, "tracker-state");
      const pnpmCommand = await run("which", ["pnpm"]);
      const pnpmEntryPoint = await realpath(pnpmCommand);
      const sandboxExecutable = await realpath(await run("which", ["bwrap"]));
      const dependencySeedStore = path.dirname(
        await realpath(await run(pnpmCommand, ["store", "path"])),
      );
      await Promise.all([
        mkdir(binDirectory, { recursive: true }),
        mkdir(operatorRoot),
        mkdir(path.join(sourceRoot, ".symphony"), { recursive: true }),
      ]);
      const ghPath = path.join(binDirectory, "gh");
      await writeFile(ghPath, FAKE_GH, "utf8");
      await chmod(ghPath, 0o755);
      await installFakeCodex(binDirectory);
      const processBoundary = await installFakeProcessBoundary(binDirectory);
      await writeFile(trackerStatePath, "Todo", "utf8");
      await run("git", ["-C", sourceRoot, "init", "-b", "main"]);
      await run("git", [
        "-C",
        sourceRoot,
        "config",
        "user.name",
        "Symphony Test",
      ]);
      await run("git", [
        "-C",
        sourceRoot,
        "config",
        "user.email",
        "symphony@example.test",
      ]);
      await run("git", [
        "-C",
        sourceRoot,
        "remote",
        "add",
        "origin",
        "https://github.com/acme/widgets.git",
      ]);
      await writeFile(path.join(sourceRoot, "product.txt"), "product\n");
      await writeFile(path.join(sourceRoot, ".gitignore"), "node_modules/\n");
      await writeFile(
        path.join(sourceRoot, "AGENTS.md"),
        "# Accepted product instructions\n",
      );
      await writeFile(
        path.join(sourceRoot, "package.json"),
        JSON.stringify({
          name: "managed-e2e",
          version: "1.0.0",
          packageManager: "pnpm@11.3.0",
          scripts: {
            preinstall:
              "node -e \"require('node:fs').writeFileSync('lifecycle-ran', 'unsafe')\"",
          },
        }),
      );
      await writeFile(
        path.join(sourceRoot, "pnpm-lock.yaml"),
        `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .: {}
`,
      );
      const profilePath = ".symphony/repository-profile.json";
      const promptPath = ".symphony/prompt.md";
      const profile = {
        schemaVersion: 1,
        repositoryIdentity: "acme/widgets",
        baseRef: "refs/heads/main",
        authoringContext: {
          promptPath,
          paths: ["AGENTS.md"],
        },
        preparationClass: "pnpm",
      };
      const profileBytes = `${JSON.stringify(profile, null, 2)}\n`;
      await writeFile(path.join(sourceRoot, profilePath), profileBytes);
      await writeFile(
        path.join(sourceRoot, promptPath),
        "Work on {{ issue.identifier }}: {{ issue.title }}.\n",
      );
      await run("git", ["-C", sourceRoot, "add", "."]);
      await run("git", ["-C", sourceRoot, "commit", "-m", "fixture base"]);
      const revision = await run("git", [
        "-C",
        sourceRoot,
        "rev-parse",
        "HEAD",
      ]);
      const bindingPath = path.join(operatorRoot, "widgets.json");
      await writeFile(
        bindingPath,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            id: "widgets-e2e",
            productProfile: {
              repositoryIdentity: "acme/widgets",
              sourceRoot,
              path: profilePath,
              revision,
              digest: digest(profileBytes),
            },
            stateRoot,
            workspaceRoot,
            branchPrefix: "symphony/",
            gitExecutable: await realpath(await run("which", ["git"])),
            tracker: {
              kind: "github-projects",
              provider: {
                owner: "acme",
                repo: "widgets",
                project: 28,
              },
              requiredLabels: ["ready"],
              excludedLabels: ["driver:direct"],
              activeStates: ["Todo", "In Progress"],
              terminalStates: ["Done", "Cancelled"],
              freshAttemptStates: [],
              freshAttemptFailureState: null,
            },
            polling: { intervalMs: 50 },
            preparation: {
              timeoutMs: 30_000,
              nodeExecutable: process.execPath,
              pnpmEntryPoint,
              sandboxExecutable,
              dependencyPolicy: {
                id: "public-npm-offline-v1",
                mode: "offline",
                registry: "https://registry.npmjs.org/",
                seedStoreRoot: dependencySeedStore,
                pnpmVersion: "11.3.0",
              },
            },
            agent: {
              maxConcurrentAgents: 1,
              maxTurns: 2,
              maxRetryBackoffMs: 10_000,
              maxConcurrentAgentsByState: {},
            },
            runtime: {
              codexExecutable: path.join(binDirectory, "codex"),
              turnTimeoutMs: 1_000,
              readTimeoutMs: 1_000,
              stallTimeoutMs: 5_000,
              containment: {
                provider: "systemd-user-scope",
                shutdownTimeoutMs: 500,
                systemdRunExecutable: processBoundary.systemdRun,
                systemctlExecutable: processBoundary.systemctl,
              },
            },
          },
          null,
          2,
        )}\n`,
      );

      // The mutable checkout is not deployment authority. These hostile live
      // edits must not replace the exact profile/context revision above.
      await writeFile(
        path.join(sourceRoot, profilePath),
        '{"schemaVersion":999,"workspaceRoot":"/candidate"}\n',
      );
      await writeFile(
        path.join(sourceRoot, promptPath),
        "MUTABLE PROMPT MUST NOT WIN\n",
      );

      const logMessages: string[] = [];
      const host = await buildDaemonHost({
        source: { kind: "binding", path: bindingPath },
        logger: {
          ...nullLogger,
          info(message: string) {
            logMessages.push(message);
          },
        },
        environment: {
          PATH: `${binDirectory}:${process.env["PATH"] ?? ""}`,
          GH_TOKEN: "parent-token",
          FAKE_GH_STATE_PATH: trackerStatePath,
          FAKE_CODEX_SCENARIO: "normal",
          FAKE_CODEX_TITLE_PREFIX: "widgets#123",
          FAKE_CODEX_EXPECT_MANAGED_POLICY: "1",
          FAKE_CODEX_EXPECT_PROMPT:
            "Work on widgets#123: Exercise the complete daemon.",
        },
      });
      try {
        await host.start();
        await eventually(() => logMessages.includes("retry outcome=scheduled"));
        await writeFile(trackerStatePath, "Human Review", "utf8");
        await eventually(
          () =>
            host.snapshot().counts.running === 0 &&
            host.snapshot().counts.retrying === 0,
        );

        const managedEntries = await readdir(workspaceRoot);
        expect(managedEntries).toHaveLength(1);
        const managedPath = path.join(workspaceRoot, managedEntries[0]!);
        expect(
          await readFile(path.join(managedPath, "product.txt"), "utf8"),
        ).toBe("product\n");
        expect(
          await run("git", ["-C", managedPath, "branch", "--show-current"]),
        ).toMatch(/^symphony\/widgets-123-/u);
        expect(existsSync(path.join(managedPath, "lifecycle-ran"))).toBe(false);
        expect(logMessages).toContain("preparation outcome=succeeded");
        expect(existsSync(path.join(stateRoot, "agent-runtime"))).toBe(false);
        expect(existsSync(path.join(stateRoot, "state.sqlite"))).toBe(true);
        expect(existsSync(path.join(workspaceRoot, ".symphony"))).toBe(false);
        expect({
          status: await run("git", [
            "-C",
            managedPath,
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
          ]),
          diff: await run("git", [
            "-C",
            managedPath,
            "diff",
            "--",
            "pnpm-lock.yaml",
          ]),
        }).toEqual({ status: "", diff: "" });

        const recordedState = SqliteSymphonyStateStore.open(
          path.join(stateRoot, "state.sqlite"),
        );
        try {
          expect(recordedState.listActiveSessions()).toMatchObject([
            {
              repositoryIdentity: "acme/widgets",
              configuration: {
                productProfile: {
                  repositoryIdentity: "acme/widgets",
                  path: profilePath,
                  revision,
                  digest: digest(profileBytes),
                },
                deploymentBinding: { id: "widgets-e2e" },
              },
            },
          ]);
        } finally {
          recordedState.close();
        }

        await writeFile(trackerStatePath, "Cancelled", "utf8");
        await eventually(
          async () => (await readdir(workspaceRoot)).length === 0,
        );
        expect(
          await run("git", [
            "-C",
            sourceRoot,
            "worktree",
            "list",
            "--porcelain",
          ]),
        ).not.toContain(workspaceRoot);
      } finally {
        await host.stop();
      }
    });
  }, 90_000);
});
