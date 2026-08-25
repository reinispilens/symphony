import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { Logger } from "../../src/observability/logger.js";
import { readFreshAttemptReceipt } from "../../src/workspace/fresh-attempt.js";
import type { WorkspaceLifecycleConfig } from "../../src/workspace/manager.js";
import { WorkspaceManager } from "../../src/workspace/manager.js";
import { issue, withTempDirectory } from "../support/factories.js";

function config(
  directory: string,
  hooks: Partial<WorkspaceLifecycleConfig["hooks"]> = {},
  provider: WorkspaceLifecycleConfig["workspace"]["provider"] = "directory",
): WorkspaceLifecycleConfig {
  return {
    deployment: null,
    repository: null,
    preparation: {
      driver: "none",
      frozenLockfile: true,
      lifecycleScripts: false,
      timeoutMs: 300_000,
    },
    secretEnvironmentNames: ["TEST_TRACKER_TOKEN"],
    workflowPath: path.join(directory, "WORKFLOW.md"),
    workspace: {
      provider,
      root: path.join(directory, "workspaces"),
    },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 1000,
      ...hooks,
    },
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("WorkspaceManager", () => {
  it("provisions one fresh workspace per generation and resumes without erasing it again", async () => {
    await withTempDirectory(async (directory) => {
      const lifecycle = config(
        directory,
        {
          afterCreate:
            'printf "%s" "$SYMPHONY_ATTEMPT_GENERATION" > generation',
          beforeRemove:
            'test "$SYMPHONY_RUN_STATUS" = "fresh_attempt_reset" && test -n "$SYMPHONY_ATTEMPT_GENERATION" && rm -f old generation && rmdir "$SYMPHONY_WORKSPACE_PATH"',
        },
        "harness",
      );
      const manager = new WorkspaceManager({ processEnvironment: {} });
      const old = await manager.prepare(issue(), lifecycle);
      await writeFile(path.join(old.path, "old"), "rejected", "utf8");

      const first = await manager.prepareFreshAttempt(
        issue(),
        lifecycle,
        "generation-1",
      );
      expect(first.resetWorkpad).toBe(true);
      expect(
        await readFile(path.join(first.workspace.path, "generation"), "utf8"),
      ).toBe("generation-1");
      expect(await exists(path.join(first.workspace.path, "old"))).toBe(false);
      expect(
        await readFreshAttemptReceipt(lifecycle.workspace.root, "opaque-1"),
      ).toMatchObject({ generation: "generation-1", phase: "provisioned" });

      await manager.markFreshAttemptReady(issue(), lifecycle, "generation-1");
      await writeFile(
        path.join(first.workspace.path, "new-workpad"),
        "new attempt",
        "utf8",
      );
      const resumed = await manager.prepareFreshAttempt(
        issue(),
        lifecycle,
        "generation-1",
      );
      expect(resumed.resetWorkpad).toBe(false);
      expect(
        await readFile(
          path.join(resumed.workspace.path, "new-workpad"),
          "utf8",
        ),
      ).toBe("new attempt");
    });
  });

  it("resumes an interrupted provisioned generation at workpad reset", async () => {
    await withTempDirectory(async (directory) => {
      const lifecycle = config(directory);
      const manager = new WorkspaceManager({ processEnvironment: {} });
      const first = await manager.prepareFreshAttempt(
        issue(),
        lifecycle,
        "generation-1",
      );

      const resumed = await manager.prepareFreshAttempt(
        issue(),
        lifecycle,
        "generation-1",
      );

      expect(first.resetWorkpad).toBe(true);
      expect(resumed).toEqual({
        ...first,
        workspace: { ...first.workspace, createdNow: false },
      });
    });
  });

  it("refuses a harness fresh attempt when repository teardown does not remove the old workspace", async () => {
    await withTempDirectory(async (directory) => {
      const lifecycle = config(
        directory,
        { beforeRemove: 'test "$SYMPHONY_RUN_STATUS" = fresh_attempt_reset' },
        "harness",
      );
      const manager = new WorkspaceManager({ processEnvironment: {} });
      const old = await manager.prepare(issue(), lifecycle);

      await expect(
        manager.prepareFreshAttempt(issue(), lifecycle, "generation-1"),
      ).rejects.toMatchObject({ code: "fresh_attempt_reset_failed" });
      expect(await exists(old.path)).toBe(true);
      expect(
        await readFreshAttemptReceipt(lifecycle.workspace.root, "opaque-1"),
      ).toBeNull();
    });
  });

  it("refuses a fresh receipt store redirected through a symbolic link", async () => {
    await withTempDirectory(async (directory) => {
      const lifecycle = config(directory);
      const outside = path.join(directory, "outside");
      await Promise.all([mkdir(lifecycle.workspace.root), mkdir(outside)]);
      await symlink(outside, path.join(lifecycle.workspace.root, ".symphony"));
      const manager = new WorkspaceManager({ processEnvironment: {} });

      await expect(
        manager.prepareFreshAttempt(issue(), lifecycle, "generation-1"),
      ).rejects.toMatchObject({ code: "workspace_path_unsafe" });
    });
  });

  it("creates deterministically, runs after_create in the empty workspace once, and then reuses it", async () => {
    await withTempDirectory(async (directory) => {
      const logPath = path.join(directory, "hook.log");
      const lifecycle = config(directory, {
        afterCreate:
          'test "$PWD" = "$SYMPHONY_WORKSPACE_PATH" && printf "%s:%s\\n" "$SYMPHONY_ISSUE_IDENTIFIER" "$SYMPHONY_WORKSPACE_KEY" >> "$SYMPHONY_WORKFLOW_DIR/hook.log"',
      });
      const manager = new WorkspaceManager({ processEnvironment: {} });

      const first = await manager.prepare(issue(), lifecycle);
      const second = await manager.prepare(issue(), lifecycle);

      expect(first).toEqual({
        createdNow: true,
        path: first.path,
        workspaceKey: "SYM-123",
      });
      expect(second).toEqual({ ...first, createdNow: false });
      expect(await readFile(logPath, "utf8")).toBe("SYM-123:SYM-123\n");
    });
  });

  it("removes a newly-created workspace when after_create fails", async () => {
    await withTempDirectory(async (directory) => {
      const lifecycle = config(directory, { afterCreate: "exit 7" });
      const manager = new WorkspaceManager({ processEnvironment: {} });
      const workspacePath = path.join(lifecycle.workspace.root, "SYM-123");

      await expect(manager.prepare(issue(), lifecycle)).rejects.toMatchObject({
        code: "hook_failed",
      });
      expect(await exists(workspacePath)).toBe(false);
    });
  });

  it("runs before_run for every attempt and treats failure as fatal", async () => {
    await withTempDirectory(async (directory) => {
      const lifecycle = config(directory, {
        beforeRun:
          'printf "%s\\n" "$SYMPHONY_ATTEMPT" >> attempts && test "$SYMPHONY_ATTEMPT" != "2"',
      });
      const manager = new WorkspaceManager({ processEnvironment: {} });
      const workspace = await manager.prepare(issue(), lifecycle);

      await manager.beforeRun(issue(), workspace, lifecycle, { attempt: 1 });
      await expect(
        manager.beforeRun(issue(), workspace, lifecycle, { attempt: 2 }),
      ).rejects.toMatchObject({
        code: "hook_failed",
      });
      expect(
        await readFile(path.join(workspace.path, "attempts"), "utf8"),
      ).toBe("1\n2\n");
    });
  });

  it("logs and ignores after_run and before_remove failures", async () => {
    await withTempDirectory(async (directory) => {
      const warn = vi.fn();
      const info = vi.fn();
      const logger: Logger = {
        debug: vi.fn(),
        info,
        warn,
        error: vi.fn(),
      };
      const lifecycle = config(directory, {
        afterRun: 'printf "%s" "$TEST_TRACKER_TOKEN" >&2; exit 8',
        beforeRemove: "exit 9",
      });
      const manager = new WorkspaceManager({
        logger,
        processEnvironment: { TEST_TRACKER_TOKEN: "must-not-be-logged" },
      });
      const workspace = await manager.prepare(issue(), lifecycle);
      await writeFile(path.join(workspace.path, "artifact"), "proof", "utf8");

      await manager.afterRun(issue(), workspace, lifecycle, {
        attempt: 1,
        status: "failed",
      });
      await manager.remove(issue(), lifecycle);

      expect(warn).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(
        "must-not-be-logged",
      );
      expect(JSON.stringify(warn.mock.calls)).toContain("[REDACTED]");
      expect(info).toHaveBeenCalledWith(
        expect.stringMatching(/^Workspace hook (started|finished)$/),
        expect.objectContaining({
          issue_id: "opaque-1",
          issue_identifier: "SYM-123",
        }),
      );
      expect(await exists(workspace.path)).toBe(false);
    });
  });

  it("lets a harness hook remove its own workspace without a generic delete", async () => {
    await withTempDirectory(async (directory) => {
      const lifecycle = config(
        directory,
        { beforeRemove: 'rmdir "$SYMPHONY_WORKSPACE_PATH"' },
        "harness",
      );
      const manager = new WorkspaceManager({ processEnvironment: {} });
      const workspace = await manager.prepare(issue(), lifecycle);

      await manager.remove(issue(), lifecycle);

      expect(await exists(workspace.path)).toBe(false);
    });
  });

  it("retains a harness-owned workspace when repository teardown fails", async () => {
    await withTempDirectory(async (directory) => {
      const warn = vi.fn();
      const logger: Logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn,
        error: vi.fn(),
      };
      const lifecycle = config(
        directory,
        { beforeRemove: "exit 9" },
        "harness",
      );
      const manager = new WorkspaceManager({
        logger,
        processEnvironment: {},
      });
      const workspace = await manager.prepare(issue(), lifecycle);
      await writeFile(
        path.join(workspace.path, "receipt"),
        "allocated",
        "utf8",
      );

      await manager.remove(issue(), lifecycle);

      expect(await exists(workspace.path)).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        "Harness-owned workspace was retained because teardown did not remove it",
        expect.objectContaining({ workspace_path: workspace.path }),
      );
    });
  });

  it("does not recursively delete a partially-created harness workspace", async () => {
    await withTempDirectory(async (directory) => {
      const lifecycle = config(
        directory,
        {
          afterCreate: "touch allocation-receipt; exit 7",
          beforeRemove: "exit 8",
        },
        "harness",
      );
      const manager = new WorkspaceManager({ processEnvironment: {} });
      const workspacePath = path.join(lifecycle.workspace.root, "SYM-123");

      await expect(manager.prepare(issue(), lifecycle)).rejects.toMatchObject({
        code: "hook_failed",
      });
      expect(await exists(path.join(workspacePath, "allocation-receipt"))).toBe(
        true,
      );
    });
  });

  it("terminates a timed-out before_run hook and fails the attempt", async () => {
    await withTempDirectory(async (directory) => {
      const lifecycle = config(directory, {
        beforeRun: "sleep 5",
        timeoutMs: 30,
      });
      const manager = new WorkspaceManager({ processEnvironment: {} });
      const workspace = await manager.prepare(issue(), lifecycle);

      await expect(
        manager.beforeRun(issue(), workspace, lifecycle, { attempt: null }),
      ).rejects.toMatchObject({
        code: "hook_timeout",
      });
    });
  });

  it("rejects an agent launch from any cwd other than the issue workspace", async () => {
    await withTempDirectory(async (directory) => {
      const lifecycle = config(directory);
      const manager = new WorkspaceManager({ processEnvironment: {} });
      const workspace = await manager.prepare(issue(), lifecycle);

      await expect(
        manager.assertAgentLaunchCwd(workspace, lifecycle, workspace.path),
      ).resolves.toBeUndefined();
      await expect(
        manager.assertAgentLaunchCwd(workspace, lifecycle, directory),
      ).rejects.toMatchObject({
        code: "workspace_path_unsafe",
      });
    });
  });
});
