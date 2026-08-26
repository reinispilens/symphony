import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:net";

import { describe, expect, it } from "vitest";

import { PnpmPreparationDriver } from "../../src/preparation/pnpm-driver.js";
import type {
  RepositoryAttemptAuthority,
  Workspace,
  WorkspaceLifecycleConfig,
} from "../../src/repository/driver.js";
import { SqliteSymphonyStateStore } from "../../src/state/sqlite-store.js";
import { issue, withTempDirectory } from "../support/factories.js";

const START_MS = Date.parse("2026-08-25T10:00:00.000Z");

function command(file: string, args: readonly string[]): Promise<string> {
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

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

let toolchainPromise:
  | Promise<{
      readonly pnpmEntryPoint: string;
      readonly sandboxExecutable: string;
      readonly seedStoreRoot: string;
    }>
  | undefined;

function toolchain() {
  toolchainPromise ??= (async () => {
    const pnpmCommand = await command("which", ["pnpm"]);
    return {
      pnpmEntryPoint: await realpath(pnpmCommand),
      sandboxExecutable: await realpath(await command("which", ["bwrap"])),
      seedStoreRoot: path.dirname(
        await realpath(await command(pnpmCommand, ["store", "path"])),
      ),
    };
  })();
  return toolchainPromise;
}

async function exists(entryPath: string): Promise<boolean> {
  try {
    await stat(entryPath);
    return true;
  } catch {
    return false;
  }
}

function withPreparationAuthority(
  config: WorkspaceLifecycleConfig,
  overrides: {
    readonly dependencyPolicy?: Partial<
      NonNullable<
        NonNullable<WorkspaceLifecycleConfig["deployment"]>["preparation"]
      >["dependencyPolicy"]
    >;
    readonly pnpmEntryPoint?: string;
    readonly sandboxExecutable?: string;
    readonly timeoutMs?: number;
  },
): WorkspaceLifecycleConfig {
  const deployment = config.deployment!;
  const preparation = deployment.preparation!;
  return {
    ...config,
    preparation: {
      ...config.preparation,
      ...(overrides.timeoutMs === undefined
        ? {}
        : { timeoutMs: overrides.timeoutMs }),
    },
    deployment: {
      ...deployment,
      preparation: {
        ...preparation,
        ...(overrides.pnpmEntryPoint === undefined
          ? {}
          : { pnpmEntryPoint: overrides.pnpmEntryPoint }),
        ...(overrides.sandboxExecutable === undefined
          ? {}
          : { sandboxExecutable: overrides.sandboxExecutable }),
        dependencyPolicy: {
          ...preparation.dependencyPolicy,
          ...overrides.dependencyPolicy,
        },
      },
    },
  };
}

async function processIdsContaining(token: string): Promise<number[]> {
  const ids: number[] = [];
  for (const entry of await readdir("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    try {
      const commandLine = await readFile(
        path.join("/proc", entry.name, "cmdline"),
        "utf8",
      );
      if (commandLine.includes(token)) ids.push(Number(entry.name));
    } catch {
      // The process may have exited between directory enumeration and read.
    }
  }
  return ids;
}

async function eventuallyNoProcess(token: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while ((await processIdsContaining(token)).length !== 0) {
    if (Date.now() >= deadline) {
      throw new Error(`detached preparation descendant survived: ${token}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function fixture(directory: string) {
  const tools = await toolchain();
  const workspaceRoot = path.join(directory, "workspaces");
  const workspacePath = path.join(workspaceRoot, "PREP-1");
  await mkdir(workspacePath, { recursive: true });
  const policy = {
    id: "public-npm-offline-v1",
    mode: "offline" as const,
    registry: "https://registry.npmjs.org/",
    seedStoreRoot: tools.seedStoreRoot,
    pnpmVersion: "11.3.0",
  };
  const config: WorkspaceLifecycleConfig = {
    deployment: {
      bindingId: "preparation-test",
      bindingDigest: `sha256:${"1".repeat(64)}`,
      bindingPath: path.join(directory, "operator", "binding.json"),
      sourceRoot: path.join(directory, "source"),
      stateRoot: path.join(directory, "state"),
      acceptedConfiguration: {
        productProfile: {
          repositoryIdentity: "acme/widgets",
          path: ".symphony/repository-profile.json",
          revision: "a".repeat(40),
          digest: `sha256:${"2".repeat(64)}`,
        },
        authoringContext: {
          repositoryIdentity: "acme/widgets",
          revision: "a".repeat(40),
          manifestDigest: `sha256:${"3".repeat(64)}`,
          entries: [],
        },
        deploymentBinding: {
          id: "preparation-test",
          digest: `sha256:${"1".repeat(64)}`,
        },
        deliveryGrant: null,
      },
      codexExecutable: process.execPath,
      gitExecutable: "/usr/bin/git",
      deliveryProvider: null,
      preparation: {
        nodeExecutable: process.execPath,
        pnpmEntryPoint: tools.pnpmEntryPoint,
        sandboxExecutable: tools.sandboxExecutable,
        dependencyPolicy: {
          ...policy,
          digest: digest(JSON.stringify({ schemaVersion: 1, ...policy })),
        },
      },
      processContainment: {
        provider: "systemd-user-scope",
        shutdownTimeoutMs: 1_000,
        systemdRunExecutable: "/usr/bin/systemd-run",
        systemctlExecutable: "/usr/bin/systemctl",
      },
    },
    repository: {
      identity: "acme/widgets",
      hostname: "github.com",
      baseRef: "refs/remotes/origin/main",
      branchPrefix: "symphony/",
      profileDigest: null,
    },
    preparation: {
      driver: "pnpm",
      frozenLockfile: true,
      lifecycleScripts: false,
      timeoutMs: 30_000,
    },
    workspace: { provider: "git-worktree", root: workspaceRoot },
    workflowPath: path.join(directory, "WORKFLOW.md"),
    secretEnvironmentNames: ["GH_TOKEN"],
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 60_000,
    },
  };
  const workspace: Workspace = {
    createdNow: true,
    path: workspacePath,
    workspaceKey: "PREP-1",
  };
  return { config, workspace, workspaceRoot };
}

function begin(
  store: SqliteSymphonyStateStore,
  workspace: Workspace,
): RepositoryAttemptAuthority {
  const session = store.getOrCreateTrackerSession({
    trackerKind: "test",
    repositoryIdentity: "acme/widgets",
    issueId: "prep-1",
    issueIdentifier: "PREP-1",
    issueUrl: null,
    intent: "Prepare dependencies",
    controllerId: "tracker:test:acme/widgets",
    doctrine: null,
    configuration: null,
    now: new Date(START_MS).toISOString(),
  });
  const started = store.startAttempt({
    sessionId: session.id,
    controllerGeneration: session.controller.generation,
    holderId: "daemon-test",
    trackerAttempt: null,
    freshAttemptGeneration: null,
    now: new Date(START_MS).toISOString(),
    leaseExpiresAt: new Date(START_MS + 120_000).toISOString(),
  });
  const begun = store.beginManagedWorkspace({
    sessionId: session.id,
    attemptId: started.attemptId,
    runtimeLeaseToken: started.runtimeLeaseToken,
    controllerGeneration: started.controllerGeneration,
    path: workspace.path,
    workspaceKey: workspace.workspaceKey,
    repositoryIdentity: "acme/widgets",
    profileDigest: "sha256:preparation-fixture",
    sourceRoot: path.join(path.dirname(workspace.path), "source"),
    workspaceRoot: path.dirname(workspace.path),
    baseRef: "refs/remotes/origin/main",
    baseSha: "a".repeat(40),
    branch: "symphony/PREP-1",
    freshAttemptGeneration: null,
    now: new Date(START_MS + 1).toISOString(),
  });
  store.transitionManagedWorkspace({
    sessionId: session.id,
    attemptId: started.attemptId,
    workspaceLeaseToken: begun.workspaceLeaseToken,
    controllerGeneration: started.controllerGeneration,
    runtimeLeaseToken: started.runtimeLeaseToken,
    expectedPhases: ["allocating"],
    phase: "provisioned",
    error: null,
    now: new Date(START_MS + 2).toISOString(),
  });
  store.transitionManagedWorkspace({
    sessionId: session.id,
    attemptId: started.attemptId,
    workspaceLeaseToken: begun.workspaceLeaseToken,
    controllerGeneration: started.controllerGeneration,
    runtimeLeaseToken: started.runtimeLeaseToken,
    expectedPhases: ["provisioned"],
    phase: "ready",
    error: null,
    now: new Date(START_MS + 3).toISOString(),
  });
  return {
    workSessionId: session.id,
    attemptId: started.attemptId,
    runtimeLeaseToken: started.runtimeLeaseToken,
    controllerGeneration: started.controllerGeneration,
  };
}

async function writePackage(workspacePath: string): Promise<void> {
  await writeFile(
    path.join(workspacePath, "package.json"),
    JSON.stringify({
      name: "preparation-fixture",
      version: "1.0.0",
      packageManager: "pnpm@11.3.0",
      scripts: {
        preinstall:
          "node -e \"require('node:fs').writeFileSync('lifecycle-ran', 'unsafe')\"",
      },
    }),
    "utf8",
  );
  await writeFile(
    path.join(workspacePath, "pnpm-lock.yaml"),
    `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .: {}
`,
    "utf8",
  );
}

async function writePackageWithDependency(
  workspacePath: string,
): Promise<void> {
  await writeFile(
    path.join(workspacePath, "package.json"),
    JSON.stringify({
      name: "preparation-dependency-fixture",
      version: "1.0.0",
      packageManager: "pnpm@11.3.0",
      dependencies: { yaml: "2.9.0" },
    }),
    "utf8",
  );
  await writeFile(
    path.join(workspacePath, "pnpm-lock.yaml"),
    `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:
  .:
    dependencies:
      yaml:
        specifier: 2.9.0
        version: 2.9.0

packages:
  yaml@2.9.0:
    resolution: {integrity: sha512-2AvhNX3mb8zd6Zy7INTtSpl1F15HW6Wnqj0srWlkKLcpYl/gMIMJiyuGq2KeI2YFxUPjdlB+3Lc10seMLtL4cA==}
    engines: {node: '>= 14.6'}

snapshots:
  yaml@2.9.0: {}
`,
    "utf8",
  );
}

describe("PnpmPreparationDriver", () => {
  it("installs an integrity-pinned dependency from the read-only offline seed", async () => {
    await withTempDirectory(async (directory) => {
      const { config: baseConfig, workspace } = await fixture(directory);
      const config: WorkspaceLifecycleConfig = {
        ...baseConfig,
        preparation: { ...baseConfig.preparation, timeoutMs: 5_000 },
      };
      await writePackageWithDependency(workspace.path);
      const store = SqliteSymphonyStateStore.openInMemory();
      const authority = begin(store, workspace);
      const driver = new PnpmPreparationDriver({
        stateStore: store,
        processEnvironment: process.env,
        now: () => new Date(START_MS + 10),
      });
      try {
        await driver.prepare({
          authority,
          config,
          issue: issue({ id: "prep-1", identifier: "PREP-1" }),
          workspace,
        });
        const installed = JSON.parse(
          await readFile(
            path.join(workspace.path, "node_modules", "yaml", "package.json"),
            "utf8",
          ),
        ) as { version: string };
        expect(installed.version).toBe("2.9.0");
        expect(
          store
            .getSession(authority.workSessionId)
            ?.attempts.find((attempt) => attempt.id === authority.attemptId)
            ?.preparation,
        ).toMatchObject({
          driverVersion: 2,
          status: "succeeded",
          dependencyPolicy: { mode: "offline" },
          inputDigest: expect.stringMatching(/^sha256:/u),
        });
      } finally {
        store.close();
      }
    });
  }, 30_000);

  it("refuses a manifest that disagrees with the frozen lockfile", async () => {
    await withTempDirectory(async (directory) => {
      const { config, workspace } = await fixture(directory);
      await writePackageWithDependency(workspace.path);
      await writeFile(
        path.join(workspace.path, "package.json"),
        JSON.stringify({
          name: "preparation-dependency-fixture",
          version: "1.0.0",
          packageManager: "pnpm@11.3.0",
          dependencies: { yaml: "2.8.0" },
        }),
      );
      const store = SqliteSymphonyStateStore.openInMemory();
      const authority = begin(store, workspace);
      const driver = new PnpmPreparationDriver({
        stateStore: store,
        processEnvironment: process.env,
        now: () => new Date(START_MS + 10),
      });
      try {
        await expect(
          driver.prepare({
            authority,
            config,
            issue: issue({ id: "prep-1", identifier: "PREP-1" }),
            workspace,
          }),
        ).rejects.toThrow("ERR_PNPM_OUTDATED_LOCKFILE");
        expect(
          store
            .getSession(authority.workSessionId)
            ?.attempts.find((attempt) => attempt.id === authority.attemptId)
            ?.preparation,
        ).toMatchObject({ status: "failed" });
      } finally {
        store.close();
      }
    });
  }, 30_000);

  it("runs a frozen install with lifecycle scripts disabled and cleans its attempt cache", async () => {
    await withTempDirectory(async (directory) => {
      const { config, workspace } = await fixture(directory);
      await writePackage(workspace.path);
      const store = SqliteSymphonyStateStore.openInMemory();
      const authority = begin(store, workspace);
      let nowMs = START_MS + 10;
      const driver = new PnpmPreparationDriver({
        stateStore: store,
        now: () => new Date(nowMs++),
        processEnvironment: process.env,
      });
      try {
        await driver.prepare({
          authority,
          config,
          issue: issue({ id: "prep-1", identifier: "PREP-1" }),
          workspace,
        });
        expect(await exists(path.join(workspace.path, "lifecycle-ran"))).toBe(
          false,
        );
        const preparation = store
          .getSession(authority.workSessionId)
          ?.attempts.find(
            (attempt) => attempt.id === authority.attemptId,
          )?.preparation;
        expect(preparation).toMatchObject({
          driver: "pnpm",
          status: "succeeded",
          lifecycleScripts: false,
        });
        expect(preparation?.cachePath.startsWith(workspace.path)).toBe(false);
        expect((await stat(preparation!.cachePath)).mode & 0o777).toBe(0o700);

        await expect(
          driver.cleanup(
            {
              workSessionId: authority.workSessionId,
              controllerGeneration: authority.controllerGeneration,
            },
            config,
          ),
        ).rejects.toThrow("stale or active WorkSession");
        expect(await exists(preparation!.cachePath)).toBe(true);

        store.finishAttempt({
          sessionId: authority.workSessionId,
          attemptId: authority.attemptId,
          runtimeLeaseToken: authority.runtimeLeaseToken,
          controllerGeneration: authority.controllerGeneration,
          status: "completed",
          error: null,
          now: new Date(START_MS + 1_000).toISOString(),
        });
        await expect(
          driver.cleanup(
            {
              workSessionId: authority.workSessionId,
              controllerGeneration: authority.controllerGeneration + 1,
            },
            config,
          ),
        ).rejects.toThrow("stale or active WorkSession");
        await driver.cleanup(
          {
            workSessionId: authority.workSessionId,
            controllerGeneration: authority.controllerGeneration,
          },
          config,
        );
        expect(await exists(preparation!.cachePath)).toBe(false);
      } finally {
        store.close();
      }
    });
  });

  it("passes only a minimal environment to the preparation process", async () => {
    await withTempDirectory(async (directory) => {
      const { config: baseConfig, workspace } = await fixture(directory);
      await writePackage(workspace.path);
      const executable = path.join(directory, "observe-environment.mjs");
      const hostSecret = path.join(directory, "host-secret.txt");
      await writeFile(hostSecret, "must-not-be-readable", "utf8");
      await writeFile(
        executable,
        `#!/usr/bin/env node
import fs from "node:fs";
let hostRead = "blocked";
try { hostRead = fs.readFileSync(${JSON.stringify(hostSecret)}, "utf8"); } catch {}
fs.writeFileSync("preparation-observation.json", JSON.stringify({ argv: process.argv.slice(2), env: process.env, hostRead }));
`,
        "utf8",
      );
      await chmod(executable, 0o755);
      const config: WorkspaceLifecycleConfig = {
        ...baseConfig,
        deployment: {
          ...baseConfig.deployment!,
          preparation: {
            ...baseConfig.deployment!.preparation!,
            pnpmEntryPoint: executable,
          },
        },
      };
      const store = SqliteSymphonyStateStore.openInMemory();
      const authority = begin(store, workspace);
      const driver = new PnpmPreparationDriver({
        stateStore: store,
        processEnvironment: {
          PATH: process.env["PATH"],
          LANG: "C.UTF-8",
          GH_TOKEN: "tracker-secret",
          WCP_CONTROL_TOKEN: "control-secret",
          SSH_AUTH_SOCK: "/private/agent.sock",
        },
        now: () => new Date(START_MS + 10),
      });
      try {
        await driver.prepare({
          authority,
          config,
          issue: issue({ id: "prep-1", identifier: "PREP-1" }),
          workspace,
        });
        const observation = JSON.parse(
          await readFile(
            path.join(workspace.path, "preparation-observation.json"),
            "utf8",
          ),
        ) as {
          argv: string[];
          env: Record<string, string>;
          hostRead: string;
        };
        expect(observation.argv).toContain("--ignore-scripts");
        expect(observation.argv).toContain("--frozen-lockfile");
        expect(observation.argv).toContain("--offline");
        expect(observation.argv).toContain("--ignore-pnpmfile");
        expect(observation.env["GH_TOKEN"]).toBeUndefined();
        expect(observation.env["WCP_CONTROL_TOKEN"]).toBeUndefined();
        expect(observation.env["SSH_AUTH_SOCK"]).toBeUndefined();
        expect(observation.env["HOME"]).toBe("/cache/home");
        expect(observation.env["npm_config_ignore_scripts"]).toBe("true");
        expect(observation.env["npm_config_offline"]).toBe("true");
        expect(observation.hostRead).toBe("blocked");
      } finally {
        store.close();
      }
    });
  });

  it("cannot reach host, private, or metadata networks or mutate the dependency seed", async () => {
    await withTempDirectory(async (directory) => {
      const { config: baseConfig, workspace } = await fixture(directory);
      await writePackage(workspace.path);
      const server = createServer((socket) => socket.end("host-service"));
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("test host service did not bind a TCP port");
      }
      const entryPoint = path.join(directory, "probe-network.mjs");
      const stateSecret = path.join(baseConfig.deployment!.stateRoot, "secret");
      const siblingSecret = path.join(directory, "sibling", "secret");
      await Promise.all([
        mkdir(path.dirname(stateSecret), { recursive: true }),
        mkdir(path.dirname(siblingSecret), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(stateSecret, "state-secret"),
        writeFile(siblingSecret, "sibling-secret"),
        writeFile(
          entryPoint,
          `import fs from "node:fs";
import net from "node:net";
const probe = (host, port) => new Promise((resolve) => {
  const socket = net.connect({ host, port });
  const done = (result) => { socket.destroy(); resolve(result); };
  socket.setTimeout(250, () => done("timeout"));
  socket.once("connect", () => done("connected"));
  socket.once("error", (error) => done(error.code || "error"));
});
const read = (file) => { try { return fs.readFileSync(file, "utf8"); } catch { return "blocked"; } };
let seedWrite = "blocked";
try { fs.writeFileSync("/dependency-seed/v11/network-write-probe", "unsafe"); seedWrite = "written"; } catch {}
const result = {
  host: await probe("127.0.0.1", ${address.port}),
  private: await probe("10.0.0.1", 80),
  metadata: await probe("169.254.169.254", 80),
  stateRead: read(${JSON.stringify(stateSecret)}),
  siblingRead: read(${JSON.stringify(siblingSecret)}),
  seedWrite,
};
fs.writeFileSync("network-observation.json", JSON.stringify(result));
`,
          "utf8",
        ),
      ]);
      await chmod(entryPoint, 0o755);
      const config = withPreparationAuthority(baseConfig, {
        pnpmEntryPoint: entryPoint,
      });
      const store = SqliteSymphonyStateStore.openInMemory();
      const authority = begin(store, workspace);
      const driver = new PnpmPreparationDriver({
        stateStore: store,
        processEnvironment: process.env,
        now: () => new Date(START_MS + 10),
      });
      try {
        await driver.prepare({
          authority,
          config,
          issue: issue({ id: "prep-1", identifier: "PREP-1" }),
          workspace,
        });
        const observation = JSON.parse(
          await readFile(
            path.join(workspace.path, "network-observation.json"),
            "utf8",
          ),
        ) as Record<string, string>;
        expect(observation).toMatchObject({
          stateRead: "blocked",
          siblingRead: "blocked",
          seedWrite: "blocked",
        });
        expect(observation["host"]).not.toBe("connected");
        expect(observation["private"]).not.toBe("connected");
        expect(observation["metadata"]).not.toBe("connected");
      } finally {
        store.close();
        await new Promise<void>((resolve, reject) =>
          server.close((error) =>
            error === undefined ? resolve() : reject(error),
          ),
        );
      }
    });
  });

  it("records a setup refusal when the frozen lockfile is missing", async () => {
    await withTempDirectory(async (directory) => {
      const { config, workspace } = await fixture(directory);
      await writeFile(
        path.join(workspace.path, "package.json"),
        JSON.stringify({
          name: "missing-lock",
          version: "1.0.0",
          packageManager: "pnpm@11.3.0",
        }),
      );
      const store = SqliteSymphonyStateStore.openInMemory();
      const authority = begin(store, workspace);
      const driver = new PnpmPreparationDriver({
        stateStore: store,
        processEnvironment: process.env,
        now: () => new Date(START_MS + 10),
      });
      try {
        await expect(
          driver.prepare({
            authority,
            config,
            issue: issue({ id: "prep-1", identifier: "PREP-1" }),
            workspace,
          }),
        ).rejects.toThrow("pnpm-lock.yaml");
        expect(
          store
            .getSession(authority.workSessionId)
            ?.attempts.find((attempt) => attempt.id === authority.attemptId)
            ?.preparation,
        ).toMatchObject({
          status: "setup_refused",
          lockfileDigest: null,
        });
      } finally {
        store.close();
      }
    });
  });

  it("records a setup refusal for a linked lockfile", async () => {
    await withTempDirectory(async (directory) => {
      const { config, workspace } = await fixture(directory);
      await writePackage(workspace.path);
      const linkedLockfile = path.join(directory, "outside-lock.yaml");
      const lockfilePath = path.join(workspace.path, "pnpm-lock.yaml");
      await writeFile(linkedLockfile, await readFile(lockfilePath));
      await rm(lockfilePath);
      await symlink(linkedLockfile, lockfilePath);
      const store = SqliteSymphonyStateStore.openInMemory();
      const authority = begin(store, workspace);
      const driver = new PnpmPreparationDriver({
        stateStore: store,
        processEnvironment: process.env,
        now: () => new Date(START_MS + 10),
      });
      try {
        await expect(
          driver.prepare({
            authority,
            config,
            issue: issue({ id: "prep-1", identifier: "PREP-1" }),
            workspace,
          }),
        ).rejects.toThrow("pnpm-lock.yaml");
        expect(
          store
            .getSession(authority.workSessionId)
            ?.attempts.find((attempt) => attempt.id === authority.attemptId)
            ?.preparation,
        ).toMatchObject({ status: "setup_refused" });
      } finally {
        store.close();
      }
    });
  });

  it.each([
    "https://packages.example.test/evil.tgz",
    "git+ssh://git@example.test/evil.git",
    "file:../outside-package",
  ])("refuses custom dependency source %s", async (specifier) => {
    await withTempDirectory(async (directory) => {
      const { config, workspace } = await fixture(directory);
      await writePackage(workspace.path);
      await writeFile(
        path.join(workspace.path, "package.json"),
        JSON.stringify({
          name: "custom-source",
          version: "1.0.0",
          packageManager: "pnpm@11.3.0",
          dependencies: { unsafe: specifier },
        }),
      );
      const store = SqliteSymphonyStateStore.openInMemory();
      const authority = begin(store, workspace);
      const driver = new PnpmPreparationDriver({
        stateStore: store,
        processEnvironment: process.env,
        now: () => new Date(START_MS + 10),
      });
      try {
        await expect(
          driver.prepare({
            authority,
            config,
            issue: issue({ id: "prep-1", identifier: "PREP-1" }),
            workspace,
          }),
        ).rejects.toThrow("admitted registry");
        expect(
          store
            .getSession(authority.workSessionId)
            ?.attempts.find((attempt) => attempt.id === authority.attemptId)
            ?.preparation,
        ).toMatchObject({ status: "setup_refused" });
      } finally {
        store.close();
      }
    });
  });

  it("refuses an arbitrary tarball URL embedded in the lockfile", async () => {
    await withTempDirectory(async (directory) => {
      const { config, workspace } = await fixture(directory);
      await writePackageWithDependency(workspace.path);
      const lockfilePath = path.join(workspace.path, "pnpm-lock.yaml");
      await writeFile(
        lockfilePath,
        (await readFile(lockfilePath, "utf8")).replace(
          "resolution: {integrity:",
          "resolution: {tarball: https://packages.example.test/yaml.tgz, integrity:",
        ),
      );
      const store = SqliteSymphonyStateStore.openInMemory();
      const authority = begin(store, workspace);
      const driver = new PnpmPreparationDriver({
        stateStore: store,
        processEnvironment: process.env,
        now: () => new Date(START_MS + 10),
      });
      try {
        await expect(
          driver.prepare({
            authority,
            config,
            issue: issue({ id: "prep-1", identifier: "PREP-1" }),
            workspace,
          }),
        ).rejects.toThrow("unsupported key 'tarball'");
      } finally {
        store.close();
      }
    });
  });

  it("fences dependency-policy drift on an already bound attempt", async () => {
    await withTempDirectory(async (directory) => {
      const { config: baseConfig, workspace } = await fixture(directory);
      await writePackage(workspace.path);
      const entryPoint = path.join(directory, "successful-preparation.mjs");
      await writeFile(entryPoint, "// successful no-op\n", "utf8");
      const config = withPreparationAuthority(baseConfig, {
        pnpmEntryPoint: entryPoint,
      });
      const store = SqliteSymphonyStateStore.openInMemory();
      const authority = begin(store, workspace);
      const driver = new PnpmPreparationDriver({
        stateStore: store,
        processEnvironment: process.env,
        now: () => new Date(START_MS + 10),
      });
      try {
        await driver.prepare({
          authority,
          config,
          issue: issue({ id: "prep-1", identifier: "PREP-1" }),
          workspace,
        });
        const drifted = withPreparationAuthority(config, {
          dependencyPolicy: { digest: `sha256:${"f".repeat(64)}` },
        });
        await expect(
          driver.prepare({
            authority,
            config: drifted,
            issue: issue({ id: "prep-1", identifier: "PREP-1" }),
            workspace,
          }),
        ).rejects.toThrow("different preparation plan");
      } finally {
        store.close();
      }
    });
  });

  it("does not fall back when the configured sandbox fails", async () => {
    await withTempDirectory(async (directory) => {
      const { config: baseConfig, workspace } = await fixture(directory);
      await writePackage(workspace.path);
      const sandboxLog = path.join(directory, "sandbox-args.json");
      const unsafeMarker = path.join(workspace.path, "unsandboxed-fallback");
      const entryPoint = path.join(directory, "must-not-run.mjs");
      const sandbox = path.join(directory, "refusing-sandbox.mjs");
      await Promise.all([
        writeFile(
          entryPoint,
          `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(unsafeMarker)}, "unsafe");\n`,
        ),
        writeFile(
          sandbox,
          `#!${process.execPath}\nimport fs from "node:fs"; fs.writeFileSync(${JSON.stringify(sandboxLog)}, JSON.stringify(process.argv.slice(2))); process.exit(73);\n`,
        ),
      ]);
      await chmod(sandbox, 0o755);
      const config = withPreparationAuthority(baseConfig, {
        pnpmEntryPoint: entryPoint,
        sandboxExecutable: sandbox,
      });
      const store = SqliteSymphonyStateStore.openInMemory();
      const authority = begin(store, workspace);
      const driver = new PnpmPreparationDriver({
        stateStore: store,
        processEnvironment: process.env,
        now: () => new Date(START_MS + 10),
      });
      try {
        await expect(
          driver.prepare({
            authority,
            config,
            issue: issue({ id: "prep-1", identifier: "PREP-1" }),
            workspace,
          }),
        ).rejects.toThrow("status 73");
        expect(await exists(unsafeMarker)).toBe(false);
        const args = JSON.parse(await readFile(sandboxLog, "utf8")) as string[];
        expect(args).toContain("--unshare-all");
        expect(args).not.toContain("--share-net");
        expect(args).toContain("--offline");
        expect(args).toContain("--trust-lockfile");
        expect(args).toContain("/dependency-seed");
      } finally {
        store.close();
      }
    });
  });

  it("terminates detached descendants when preparation is cancelled", async () => {
    await withTempDirectory(async (directory) => {
      const { config: baseConfig, workspace } = await fixture(directory);
      await writePackage(workspace.path);
      const token = `symphony-preparation-child-${randomUUID()}`;
      const childStarted = path.join(workspace.path, "child-started");
      const entryPoint = path.join(directory, "detached-child.mjs");
      await writeFile(
        entryPoint,
        `import fs from "node:fs";
import { spawn } from "node:child_process";
spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ${JSON.stringify(token)}], { detached: true, stdio: "ignore" });
fs.writeFileSync("child-started", "yes");
setInterval(() => {}, 1000);
`,
      );
      const config = withPreparationAuthority(baseConfig, {
        pnpmEntryPoint: entryPoint,
        timeoutMs: 20_000,
      });
      const store = SqliteSymphonyStateStore.openInMemory();
      const authority = begin(store, workspace);
      const driver = new PnpmPreparationDriver({
        stateStore: store,
        processEnvironment: process.env,
        now: () => new Date(START_MS + 10),
      });
      const controller = new AbortController();
      try {
        const preparation = driver.prepare({
          authority,
          config,
          issue: issue({ id: "prep-1", identifier: "PREP-1" }),
          signal: controller.signal,
          workspace,
        });
        const deadline = Date.now() + 5_000;
        while (!(await exists(childStarted))) {
          if (Date.now() >= deadline) {
            throw new Error("detached child fixture did not start");
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        controller.abort(new Error("test cancellation"));
        await expect(preparation).rejects.toThrow("attempt cancellation");
        await eventuallyNoProcess(token);
        expect(
          store
            .getSession(authority.workSessionId)
            ?.attempts.find((attempt) => attempt.id === authority.attemptId)
            ?.preparation,
        ).toMatchObject({ status: "interrupted" });
      } finally {
        for (const pid of await processIdsContaining(token)) {
          if (pid <= 1) continue;
          try {
            process.kill(pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
        store.close();
      }
    });
  }, 15_000);

  it("records a timeout as interrupted", async () => {
    await withTempDirectory(async (directory) => {
      const { config: baseConfig, workspace } = await fixture(directory);
      await writePackage(workspace.path);
      const entryPoint = path.join(directory, "never-finishes.mjs");
      await writeFile(entryPoint, "setInterval(() => {}, 1000);\n");
      const config = withPreparationAuthority(baseConfig, {
        pnpmEntryPoint: entryPoint,
        timeoutMs: 1_000,
      });
      const store = SqliteSymphonyStateStore.openInMemory();
      const authority = begin(store, workspace);
      const driver = new PnpmPreparationDriver({
        stateStore: store,
        processEnvironment: process.env,
        now: () => new Date(START_MS + 10),
      });
      try {
        await expect(
          driver.prepare({
            authority,
            config,
            issue: issue({ id: "prep-1", identifier: "PREP-1" }),
            workspace,
          }),
        ).rejects.toThrow("timed out after 1000ms");
        expect(
          store
            .getSession(authority.workSessionId)
            ?.attempts.find((attempt) => attempt.id === authority.attemptId)
            ?.preparation,
        ).toMatchObject({ status: "interrupted" });
      } finally {
        store.close();
      }
    });
  }, 10_000);
});
