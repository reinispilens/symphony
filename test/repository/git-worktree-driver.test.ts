import { execFile } from "node:child_process";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  GitWorktreeRepositoryDriver,
  preflightManagedGitHost,
} from "../../src/repository/git-worktree-driver.js";
import type {
  RepositoryAttemptAuthority,
  WorkspaceLifecycleConfig,
} from "../../src/repository/driver.js";
import { SqliteSymphonyStateStore } from "../../src/state/sqlite-store.js";
import type { StartedAttempt } from "../../src/state/model.js";
import { workspaceLocation } from "../../src/workspace/path-safety.js";
import { issue, withTempDirectory } from "../support/factories.js";

const START_MS = Date.parse("2026-08-25T10:00:00.000Z");

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

async function git(root: string, ...args: readonly string[]): Promise<string> {
  return run("git", ["-C", root, ...args]);
}

async function exists(entryPath: string): Promise<boolean> {
  try {
    await access(entryPath);
    return true;
  } catch {
    return false;
  }
}

async function repositoryFixture(directory: string) {
  const sourceRoot = path.join(directory, "source");
  const workspaceRoot = path.join(directory, "workspaces");
  await mkdir(sourceRoot);
  await git(sourceRoot, "init", "-b", "main");
  await git(sourceRoot, "config", "user.name", "Symphony Test");
  await git(sourceRoot, "config", "user.email", "symphony@example.test");
  await git(
    sourceRoot,
    "remote",
    "add",
    "origin",
    "https://github.com/acme/widgets.git",
  );
  await writeFile(path.join(sourceRoot, "WORKFLOW.md"), "fixture\n", "utf8");
  await writeFile(path.join(sourceRoot, "product.txt"), "base\n", "utf8");
  await git(sourceRoot, "add", "WORKFLOW.md", "product.txt");
  await git(sourceRoot, "commit", "-m", "fixture base");

  const config: WorkspaceLifecycleConfig = {
    deployment: null,
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
      timeoutMs: 300_000,
    },
    workspace: { provider: "git-worktree", root: workspaceRoot },
    workflowPath: path.join(sourceRoot, "WORKFLOW.md"),
    secretEnvironmentNames: [],
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 60_000,
    },
  };
  return { config, sourceRoot, workspaceRoot };
}

function trackerSession(store: SqliteSymphonyStateStore, now: string) {
  return store.getOrCreateTrackerSession({
    trackerKind: "test",
    repositoryIdentity: "acme/widgets",
    issueId: "issue-1",
    issueIdentifier: "WID-1",
    issueUrl: null,
    intent: "Exercise the managed Git driver",
    controllerId: "tracker:test:acme/widgets",
    doctrine: null,
    configuration: null,
    now,
  });
}

function startAttempt(
  store: SqliteSymphonyStateStore,
  sessionId: string,
  nowMs: number,
): StartedAttempt {
  return store.startAttempt({
    sessionId,
    controllerGeneration: 1,
    holderId: "daemon-test",
    trackerAttempt: null,
    freshAttemptGeneration: null,
    now: new Date(nowMs).toISOString(),
    leaseExpiresAt: new Date(nowMs + 120_000).toISOString(),
  });
}

function authority(started: StartedAttempt): RepositoryAttemptAuthority {
  return {
    workSessionId: started.session.id,
    attemptId: started.attemptId,
    runtimeLeaseToken: started.runtimeLeaseToken,
    controllerGeneration: started.controllerGeneration,
  };
}

function finishAttempt(
  store: SqliteSymphonyStateStore,
  started: StartedAttempt,
  nowMs: number,
): void {
  store.finishAttempt({
    sessionId: started.session.id,
    attemptId: started.attemptId,
    runtimeLeaseToken: started.runtimeLeaseToken,
    controllerGeneration: started.controllerGeneration,
    status: "completed",
    error: null,
    now: new Date(nowMs).toISOString(),
  });
}

describe("GitWorktreeRepositoryDriver", () => {
  it("refuses an in-repository workspace root before creating host state", async () => {
    await withTempDirectory(async (directory) => {
      const fixture = await repositoryFixture(directory);
      const unsafeRoot = path.join(fixture.sourceRoot, "managed-workspaces");
      await expect(
        preflightManagedGitHost({
          deployment: null,
          repository: fixture.config.repository,
          workflowPath: fixture.config.workflowPath,
          workspace: {
            provider: "git-worktree",
            root: unsafeRoot,
          },
        }),
      ).rejects.toThrow("must be disjoint");
      expect(await exists(unsafeRoot)).toBe(false);
    });
  });

  it("provisions without product hooks and retains a dirty workspace until cleanup is safe", async () => {
    await withTempDirectory(async (directory) => {
      const fixture = await repositoryFixture(directory);
      const store = SqliteSymphonyStateStore.openInMemory();
      let nowMs = START_MS + 1_000;
      const driver = new GitWorktreeRepositoryDriver({
        stateStore: store,
        now: () => new Date(nowMs++),
      });
      try {
        const session = trackerSession(store, new Date(START_MS).toISOString());
        const started = startAttempt(store, session.id, START_MS);
        const task = issue({
          id: "issue-1",
          identifier: "WID-1",
          title: "Managed lifecycle",
        });
        const workspace = await driver.prepare(task, fixture.config, {
          attempt: null,
          authority: authority(started),
        });

        expect(await git(workspace.path, "branch", "--show-current")).toMatch(
          /^symphony\/wid-1-/u,
        );
        expect(store.getSession(session.id)).toMatchObject({
          attempts: [
            {
              workspaceLease: {
                mode: "managed",
                phase: "ready",
                baseSha: await git(fixture.sourceRoot, "rev-parse", "main"),
              },
            },
          ],
        });

        await writeFile(path.join(workspace.path, "uncommitted.txt"), "keep\n");
        finishAttempt(store, started, START_MS + 10_000);
        await expect(
          driver.remove(task, fixture.config, {
            workSessionId: session.id,
            controllerGeneration: started.controllerGeneration + 1,
          }),
        ).rejects.toThrow("stale controller generation");
        await expect(
          driver.remove(task, fixture.config, {
            workSessionId: session.id,
            controllerGeneration: started.controllerGeneration,
          }),
        ).rejects.toThrow("dirty; retaining it");
        expect(await exists(workspace.path)).toBe(true);
        expect(
          store.getSession(session.id)?.attempts[0]?.workspaceLease,
        ).toMatchObject({ phase: "retained" });

        await git(workspace.path, "clean", "-fd");
        await driver.remove(task, fixture.config, {
          workSessionId: session.id,
          controllerGeneration: started.controllerGeneration,
        });
        expect(await exists(workspace.path)).toBe(false);
        expect(
          store.getSession(session.id)?.attempts[0]?.workspaceLease,
        ).toMatchObject({ phase: "removed" });
      } finally {
        store.close();
      }
    });
  });

  it("does not execute a repository post-checkout hook while provisioning", async () => {
    await withTempDirectory(async (directory) => {
      const fixture = await repositoryFixture(directory);
      const marker = path.join(directory, "post-checkout-ran");
      const hook = path.join(
        fixture.sourceRoot,
        ".git",
        "hooks",
        "post-checkout",
      );
      await writeFile(
        hook,
        `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "unsafe");\n`,
      );
      await chmod(hook, 0o755);
      const store = SqliteSymphonyStateStore.openInMemory();
      const driver = new GitWorktreeRepositoryDriver({
        stateStore: store,
        now: () => new Date(START_MS + 1_000),
      });
      try {
        const session = trackerSession(store, new Date(START_MS).toISOString());
        const started = startAttempt(store, session.id, START_MS);
        await driver.prepare(
          issue({ id: "issue-1", identifier: "WID-1" }),
          fixture.config,
          { attempt: null, authority: authority(started) },
        );

        expect(await exists(marker)).toBe(false);
      } finally {
        store.close();
      }
    });
  });

  it("refuses executable Git filters before allocating a workspace", async () => {
    await withTempDirectory(async (directory) => {
      const fixture = await repositoryFixture(directory);
      const marker = path.join(directory, "smudge-filter-ran");
      await writeFile(
        path.join(fixture.sourceRoot, ".gitattributes"),
        "product.txt filter=hostile\n",
      );
      await git(fixture.sourceRoot, "add", ".gitattributes");
      await git(fixture.sourceRoot, "commit", "-m", "add filter attribute");
      await git(
        fixture.sourceRoot,
        "config",
        "filter.hostile.smudge",
        `${process.execPath} -e 'require(\"node:fs\").writeFileSync(${JSON.stringify(marker)}, \"unsafe\")'`,
      );
      const store = SqliteSymphonyStateStore.openInMemory();
      const driver = new GitWorktreeRepositoryDriver({ stateStore: store });
      try {
        const session = trackerSession(store, new Date(START_MS).toISOString());
        const started = startAttempt(store, session.id, START_MS);
        await expect(
          driver.prepare(
            issue({ id: "issue-1", identifier: "WID-1" }),
            fixture.config,
            { attempt: null, authority: authority(started) },
          ),
        ).rejects.toThrow(
          "refuses executable Git clean/smudge/process filters",
        );

        expect(await exists(marker)).toBe(false);
        expect(await exists(fixture.workspaceRoot)).toBe(false);
      } finally {
        store.close();
      }
    });
  });

  it("reuses one fresh generation and force-replaces only when the generation changes", async () => {
    await withTempDirectory(async (directory) => {
      const fixture = await repositoryFixture(directory);
      const store = SqliteSymphonyStateStore.openInMemory();
      let nowMs = START_MS + 1_000;
      const driver = new GitWorktreeRepositoryDriver({
        stateStore: store,
        now: () => new Date(nowMs++),
      });
      try {
        const session = trackerSession(store, new Date(START_MS).toISOString());
        const task = issue({
          id: "issue-1",
          identifier: "WID-1",
          title: "Fresh managed lifecycle",
          state: "Rework",
        });
        const first = startAttempt(store, session.id, START_MS);
        const pinnedBaseSha = await git(
          fixture.sourceRoot,
          "rev-parse",
          "main",
        );
        const firstPreparation = await driver.prepareFreshAttempt(
          task,
          fixture.config,
          "generation-one",
          { attempt: null, authority: authority(first) },
        );
        expect(firstPreparation.resetWorkpad).toBe(true);
        await driver.markFreshAttemptReady(
          task,
          fixture.config,
          "generation-one",
          { attempt: null, authority: authority(first) },
        );
        const firstBranch = await git(
          firstPreparation.workspace.path,
          "branch",
          "--show-current",
        );
        await writeFile(
          path.join(firstPreparation.workspace.path, "generation.txt"),
          "one\n",
        );
        finishAttempt(store, first, START_MS + 10_000);

        const second = startAttempt(store, session.id, START_MS + 11_000);
        const reused = await driver.prepareFreshAttempt(
          task,
          fixture.config,
          "generation-one",
          { attempt: 1, authority: authority(second) },
        );
        expect(reused.resetWorkpad).toBe(false);
        expect(reused.workspace.createdNow).toBe(false);
        expect(
          store
            .getSession(session.id)
            ?.attempts.map((attempt) =>
              attempt.workspaceLease?.mode === "managed"
                ? attempt.workspaceLease.phase
                : attempt.workspaceLease?.mode,
            ),
        ).toEqual(["superseded", "ready"]);
        finishAttempt(store, second, START_MS + 20_000);

        await writeFile(
          path.join(fixture.sourceRoot, "product.txt"),
          "new mutable base\n",
        );
        await git(fixture.sourceRoot, "add", "product.txt");
        await git(fixture.sourceRoot, "commit", "-m", "advance mutable base");
        expect(await git(fixture.sourceRoot, "rev-parse", "main")).not.toBe(
          pinnedBaseSha,
        );

        const third = startAttempt(store, session.id, START_MS + 21_000);
        const replaced = await driver.prepareFreshAttempt(
          task,
          fixture.config,
          "generation-two",
          { attempt: null, authority: authority(third) },
        );
        expect(replaced.resetWorkpad).toBe(true);
        expect(replaced.workspace.createdNow).toBe(true);
        expect(
          await git(replaced.workspace.path, "branch", "--show-current"),
        ).not.toBe(firstBranch);
        expect(await git(replaced.workspace.path, "rev-parse", "HEAD")).toBe(
          pinnedBaseSha,
        );
        expect(
          store
            .getSession(session.id)
            ?.attempts.map((attempt) =>
              attempt.workspaceLease?.mode === "managed"
                ? attempt.workspaceLease.baseSha
                : null,
            ),
        ).toEqual([pinnedBaseSha, pinnedBaseSha, pinnedBaseSha]);
        expect(
          await run("git", [
            "-C",
            fixture.sourceRoot,
            "show-ref",
            "--verify",
            "--quiet",
            `refs/heads/${firstBranch}`,
          ]).catch(() => "missing"),
        ).toBe("missing");
        await driver.markFreshAttemptReady(
          task,
          fixture.config,
          "generation-two",
          { attempt: null, authority: authority(third) },
        );
        await driver.beforeRun(task, replaced.workspace, fixture.config, {
          attempt: null,
          authority: authority(third),
        });
        finishAttempt(store, third, START_MS + 30_000);
        await driver.remove(task, fixture.config, {
          workSessionId: session.id,
          controllerGeneration: third.controllerGeneration,
        });
        expect(
          store
            .getSession(session.id)
            ?.attempts.map((attempt) =>
              attempt.workspaceLease?.mode === "managed"
                ? attempt.workspaceLease.phase
                : attempt.workspaceLease?.mode,
            ),
        ).toEqual(["superseded", "removed", "removed"]);
      } finally {
        store.close();
      }
    });
  });

  it("recovers a crash after Git creation from the pre-recorded lease and pending effect", async () => {
    await withTempDirectory(async (directory) => {
      const fixture = await repositoryFixture(directory);
      const store = SqliteSymphonyStateStore.openInMemory();
      let nowMs = START_MS + 1_000;
      const driver = new GitWorktreeRepositoryDriver({
        stateStore: store,
        now: () => new Date(nowMs++),
      });
      try {
        const session = trackerSession(store, new Date(START_MS).toISOString());
        const started = startAttempt(store, session.id, START_MS);
        const task = issue({ id: "issue-1", identifier: "WID-1" });
        const location = workspaceLocation(
          fixture.workspaceRoot,
          task.identifier,
        );
        await mkdir(fixture.workspaceRoot);
        const baseSha = await git(fixture.sourceRoot, "rev-parse", "main");
        const branch = `symphony/wid-1-${session.id.slice(0, 8)}`;
        const profile = {
          schemaVersion: 1,
          identity: "acme/widgets",
          hostname: "github.com",
          baseRef: "refs/heads/main",
          branchPrefix: "symphony/",
          driver: "git-worktree",
          driverVersion: 1,
        };
        const profileDigest = `sha256:${(await import("node:crypto"))
          .createHash("sha256")
          .update(JSON.stringify(profile))
          .digest("hex")}`;
        const begun = store.beginManagedWorkspace({
          sessionId: session.id,
          attemptId: started.attemptId,
          runtimeLeaseToken: started.runtimeLeaseToken,
          controllerGeneration: started.controllerGeneration,
          path: location.path,
          workspaceKey: location.workspaceKey,
          repositoryIdentity: "acme/widgets",
          profileDigest,
          sourceRoot: fixture.sourceRoot,
          workspaceRoot: fixture.workspaceRoot,
          baseRef: "refs/heads/main",
          baseSha,
          branch,
          freshAttemptGeneration: null,
          now: new Date(nowMs++).toISOString(),
        });
        store.enqueueEffect({
          sessionId: session.id,
          controllerGeneration: started.controllerGeneration,
          kind: "git.create_worktree",
          idempotencyKey: `workspace:create:${branch}`,
          payload: {
            source_root: fixture.sourceRoot,
            workspace_path: location.path,
            branch,
            base_sha: baseSha,
          },
          now: new Date(nowMs++).toISOString(),
        });
        await git(
          fixture.sourceRoot,
          "worktree",
          "add",
          "-b",
          branch,
          location.path,
          baseSha,
        );

        const expiryTime = new Date(START_MS + 121_000).toISOString();
        const expired = store.listExpiredRuntimeLeases(expiryTime);
        store.expireRuntimeLease({ ...expired[0]!, now: expiryTime });
        const recoveredAttempt = startAttempt(
          store,
          session.id,
          START_MS + 121_001,
        );
        nowMs = START_MS + 122_000;

        const recovered = await driver.prepare(task, fixture.config, {
          attempt: 1,
          authority: authority(recoveredAttempt),
        });
        expect(recovered).toMatchObject({
          createdNow: false,
          path: location.path,
        });
        expect(store.listPendingEffects()).toHaveLength(0);
        expect(
          store.getSession(session.id)?.attempts[1]?.workspaceLease,
        ).toMatchObject({ phase: "ready" });
        finishAttempt(store, recoveredAttempt, START_MS + 130_000);
        await driver.remove(task, fixture.config, {
          workSessionId: session.id,
          controllerGeneration: recoveredAttempt.controllerGeneration,
        });
      } finally {
        store.close();
      }
    });
  });

  it("refuses a mismatched origin without exposing URL credentials", async () => {
    await withTempDirectory(async (directory) => {
      const fixture = await repositoryFixture(directory);
      await git(
        fixture.sourceRoot,
        "remote",
        "set-url",
        "origin",
        "https://top-secret@example.test/acme/widgets.git",
      );
      const store = SqliteSymphonyStateStore.openInMemory();
      const driver = new GitWorktreeRepositoryDriver({ stateStore: store });
      try {
        const session = trackerSession(store, new Date(START_MS).toISOString());
        const started = startAttempt(store, session.id, START_MS);
        let refusal: unknown;
        try {
          await driver.prepare(issue(), fixture.config, {
            attempt: null,
            authority: authority(started),
          });
        } catch (error) {
          refusal = error;
        }
        expect(String(refusal)).toContain("origin identity does not match");
        expect(String(refusal)).not.toContain("top-secret");
      } finally {
        store.close();
      }
    });
  });
});
