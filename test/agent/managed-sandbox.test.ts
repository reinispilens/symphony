import {
  chmod,
  mkdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  cleanupManagedCodexSandboxSession,
  openManagedCodexSandbox,
} from "../../src/agent/managed-sandbox.js";
import { systemdScopeUnit } from "../../src/agent/systemd-user-scope.js";
import type {
  RepositoryAttemptAuthority,
  WorkspaceLifecycleConfig,
} from "../../src/repository/driver.js";
import { withTempDirectory } from "../support/factories.js";

function lifecycle(
  workspaceRoot: string,
  workflowPath: string,
): WorkspaceLifecycleConfig {
  return {
    deployment: null,
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 1_000,
    },
    repository: {
      identity: "acme/widgets",
      hostname: "github.com",
      baseRef: "refs/heads/main",
      branchPrefix: "symphony/",
      profileDigest: null,
    },
    preparation: {
      driver: "none",
      frozenLockfile: true,
      lifecycleScripts: false,
      timeoutMs: 1_000,
    },
    secretEnvironmentNames: [],
    workflowPath,
    workspace: { provider: "git-worktree", root: workspaceRoot },
  };
}

async function layout(
  root: string,
  options: { readonly state?: boolean } = {},
) {
  const bin = path.join(root, "bin");
  const source = path.join(root, "source");
  const workspaceRoot = path.join(root, "workspaces");
  const stateRoot = path.join(root, "state");
  const workspace = path.join(workspaceRoot, "attempt");
  const workflowPath = path.join(source, "WORKFLOW.md");
  await Promise.all([
    mkdir(bin),
    mkdir(source),
    mkdir(stateRoot),
    mkdir(workspace, { recursive: true }),
  ]);
  if (options.state !== false) {
    await mkdir(path.join(workspaceRoot, ".symphony"));
  }
  await writeFile(workflowPath, "workflow");
  const codex = path.join(bin, "codex");
  await writeFile(codex, "#!/bin/sh\nexit 0\n");
  await chmod(codex, 0o755);
  return {
    config: lifecycle(workspaceRoot, workflowPath),
    environment: { PATH: bin },
    bin,
    source,
    stateRoot,
    workspace,
    workspaceRoot,
  };
}

const authority: RepositoryAttemptAuthority = {
  workSessionId: "session/unsafe-looking",
  attemptId: "attempt/unsafe-looking",
  runtimeLeaseToken: "lease/unsafe-looking",
  controllerGeneration: 1,
};

describe("managed Codex sandbox", () => {
  it("uses the deployment-owned runtime root and proves the process scope empty before cleanup", async () => {
    await withTempDirectory(async (root) => {
      const fixture = await layout(root);
      const systemdRun = path.join(fixture.bin, "systemd-run");
      const systemctl = path.join(fixture.bin, "systemctl");
      const activePath = path.join(root, "scope-active");
      const logPath = path.join(root, "systemctl.log");
      await writeFile(systemdRun, "#!/bin/sh\nexit 0\n");
      await writeFile(
        systemctl,
        `#!${process.execPath}\n` +
          `const fs = require("node:fs");\n` +
          `const args = process.argv.slice(2);\n` +
          `fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");\n` +
          `if (args.includes("--property=Version")) { process.stdout.write("Version=259\\n"); process.exit(0); }\n` +
          `if (args[1] === "show") {\n` +
          `  const active = fs.existsSync(${JSON.stringify(activePath)});\n` +
          `  process.stdout.write(active ? "LoadState=loaded\\nActiveState=active\\nSubState=running\\nControlGroup=/user.slice/test.scope\\n" : "LoadState=not-found\\nActiveState=inactive\\nSubState=dead\\nControlGroup=\\n");\n` +
          `  process.exit(0);\n` +
          `}\n` +
          `if (args[1] === "kill") { try { fs.unlinkSync(${JSON.stringify(activePath)}); } catch {} process.exit(0); }\n` +
          `process.exit(1);\n`,
      );
      await Promise.all([chmod(systemdRun, 0o755), chmod(systemctl, 0o755)]);
      const config: WorkspaceLifecycleConfig = {
        ...fixture.config,
        deployment: {
          bindingId: "widgets-local",
          bindingDigest: "sha256:binding",
          bindingPath: path.join(root, "operator", "widgets.json"),
          sourceRoot: fixture.source,
          stateRoot: fixture.stateRoot,
          acceptedConfiguration: {
            productProfile: {
              repositoryIdentity: "acme/widgets",
              path: ".symphony/repository-profile.json",
              revision: "a".repeat(40),
              digest: "sha256:profile",
            },
            authoringContext: {
              repositoryIdentity: "acme/widgets",
              revision: "a".repeat(40),
              manifestDigest: "sha256:context",
              entries: [],
            },
            deploymentBinding: {
              id: "widgets-local",
              digest: "sha256:binding",
            },
            governanceManifest: null,
            trackerPolicy: null,
            deliveryGrant: null,
            proofAuthority: null,
          },
          doctrine: null,
          codexExecutable: path.join(fixture.bin, "codex"),
          gitExecutable: "/usr/bin/git",
          deliveryProvider: null,
          preparation: {
            nodeExecutable: process.execPath,
            pnpmEntryPoint: path.join(fixture.bin, "pnpm.mjs"),
            sandboxExecutable: "/usr/bin/bwrap",
            dependencyPolicy: {
              id: "offline-test-v1",
              digest: `sha256:${"1".repeat(64)}`,
              mode: "offline",
              registry: "https://registry.npmjs.org/",
              seedStoreRoot: path.join(root, "dependency-store"),
              pnpmVersion: "11.3.0",
            },
          },
          processContainment: {
            provider: "systemd-user-scope",
            shutdownTimeoutMs: 200,
            systemdRunExecutable: systemdRun,
            systemctlExecutable: systemctl,
          },
        },
      };

      const sandbox = await openManagedCodexSandbox(
        config,
        authority,
        fixture.environment,
        fixture.workspace,
      );
      const runtime = sandbox!.environment["TMPDIR"]!;
      expect(path.relative(fixture.stateRoot, runtime)).toMatch(
        /^agent-runtime\//u,
      );
      expect(sandbox!.command).toEqual({
        executable: systemdRun,
        args: [
          "--user",
          "--scope",
          "--expand-environment=no",
          "--quiet",
          "--collect",
          `--unit=${systemdScopeUnit(authority)}`,
          "--property=KillMode=control-group",
          "--",
          path.join(fixture.bin, "codex"),
          "app-server",
        ],
      });
      await expect(sandbox!.cleanup()).rejects.toMatchObject({
        code: "runtime_quiescence_refused",
      });

      await writeFile(activePath, "active");
      await sandbox!.quiesce();
      await sandbox!.cleanup();

      await expect(stat(runtime)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(logPath, "utf8")).toContain('"--signal=SIGTERM"');
    });
  });

  it("owns one private temp root and removes it after the runtime", async () => {
    await withTempDirectory(async (root) => {
      const fixture = await layout(root);
      const sandbox = await openManagedCodexSandbox(
        fixture.config,
        authority,
        {
          ...fixture.environment,
          GH_TOKEN: "removed by the app-server client",
        },
        fixture.workspace,
      );
      expect(sandbox).not.toBeNull();
      const runtime = sandbox!.environment["TMPDIR"]!;
      expect(runtime).toBe(sandbox!.environment["TMP"]);
      expect(runtime).toBe(sandbox!.environment["TEMP"]);
      expect(path.relative(fixture.workspaceRoot, runtime)).toMatch(
        /^\.symphony\/agent-runtime\//u,
      );
      expect(sandbox!.command).toEqual({
        executable: path.join(root, "bin", "codex"),
        args: ["app-server"],
      });
      expect(sandbox!.turnSandboxPolicy).toEqual({
        type: "workspaceWrite",
        writableRoots: [runtime],
        networkAccess: false,
        excludeSlashTmp: true,
        excludeTmpdirEnvVar: true,
      });
      await writeFile(path.join(runtime, "temporary"), "owned");

      await expect(
        openManagedCodexSandbox(
          fixture.config,
          authority,
          fixture.environment,
          fixture.workspace,
        ),
      ).rejects.toMatchObject({ code: "agent_sandbox_refused" });
      await sandbox!.cleanup();
      await sandbox!.cleanup();
      await expect(stat(runtime)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("removes crash leftovers at guarded WorkSession cleanup", async () => {
    await withTempDirectory(async (root) => {
      const fixture = await layout(root);
      const sandbox = await openManagedCodexSandbox(
        fixture.config,
        authority,
        fixture.environment,
        fixture.workspace,
      );
      const runtime = sandbox!.environment["TMPDIR"]!;

      await cleanupManagedCodexSandboxSession(fixture.config, {
        workSessionId: authority.workSessionId,
        controllerGeneration: 1,
      });

      await expect(stat(runtime)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("refuses a linked state directory before creating runtime state outside the root", async () => {
    await withTempDirectory(async (root) => {
      const fixture = await layout(root, { state: false });
      const outside = path.join(root, "outside");
      await mkdir(outside);
      await symlink(outside, path.join(fixture.workspaceRoot, ".symphony"));

      await expect(
        openManagedCodexSandbox(
          fixture.config,
          authority,
          fixture.environment,
          fixture.workspace,
        ),
      ).rejects.toMatchObject({ code: "agent_sandbox_refused" });
    });
  });
});
