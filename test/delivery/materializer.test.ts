import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { TrustedSourceMaterializer } from "../../src/delivery/materializer.js";
import { SqliteSymphonyStateStore } from "../../src/state/sqlite-store.js";
import {
  acceptedGovernanceFixture,
  protectedProofAuthorityFixture,
  withTempDirectory,
} from "../support/factories.js";

const START = "2026-08-26T10:00:00.000Z";

function command(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(String(stderr) || error.message));
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}

function configuration() {
  const governance = acceptedGovernanceFixture();
  return {
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
    deploymentBinding: { id: "widgets-test", digest: "sha256:binding" },
    governanceManifest: governance.governanceManifest,
    trackerPolicy: governance.trackerPolicy,
    deliveryGrant: {
      authority: "owner-gated" as const,
      governingPolicy: governance.trackerPolicy.source,
      requiredChecks: ["proof / Protected final"],
    },
    proofAuthority: protectedProofAuthorityFixture(),
  };
}

async function fixture(directory: string) {
  const governance = acceptedGovernanceFixture();
  const sourceRoot = path.join(directory, "source");
  const workspaceRoot = path.join(directory, "workspaces");
  const workspacePath = path.join(workspaceRoot, "widgets");
  const stateRoot = path.join(directory, "state");
  await Promise.all([
    mkdir(path.join(sourceRoot, "src"), { recursive: true }),
    mkdir(workspaceRoot),
    mkdir(stateRoot),
  ]);
  await command("git", ["init", "-b", "main", sourceRoot]);
  await command("git", ["-C", sourceRoot, "config", "user.name", "Test"]);
  await command("git", [
    "-C",
    sourceRoot,
    "config",
    "user.email",
    "test@example.test",
  ]);
  await command("git", [
    "-C",
    sourceRoot,
    "remote",
    "add",
    "origin",
    "https://github.com/acme/widgets.git",
  ]);
  await Promise.all([
    writeFile(path.join(sourceRoot, "src", "tracked.txt"), "before\n"),
    writeFile(path.join(sourceRoot, "delete-me.txt"), "remove me\n"),
    writeFile(path.join(sourceRoot, ".gitignore"), "node_modules/\n"),
  ]);
  await command("git", ["-C", sourceRoot, "add", "."]);
  await command("git", ["-C", sourceRoot, "commit", "-m", "base"]);
  const baseSha = await command("git", ["-C", sourceRoot, "rev-parse", "HEAD"]);
  await command("git", [
    "-C",
    sourceRoot,
    "worktree",
    "add",
    "-b",
    "symphony/widgets",
    workspacePath,
    baseSha,
  ]);
  const store = SqliteSymphonyStateStore.open(
    path.join(stateRoot, "state.sqlite"),
  );
  const session = store.getOrCreateTrackerSession({
    trackerKind: "test",
    repositoryIdentity: "acme/widgets",
    issueId: "widgets-1",
    issueIdentifier: "WID-1",
    issueUrl: null,
    intent: "Materialize exactly the authored source",
    controllerId: "tracker:test:acme/widgets",
    doctrine: governance.doctrine,
    configuration: configuration(),
    now: START,
  });
  const started = store.startAttempt({
    sessionId: session.id,
    controllerGeneration: 1,
    holderId: "daemon-test",
    trackerAttempt: null,
    freshAttemptGeneration: null,
    now: START,
    leaseExpiresAt: "2026-08-26T10:05:00.000Z",
  });
  const begun = store.beginManagedWorkspace({
    sessionId: session.id,
    attemptId: started.attemptId,
    runtimeLeaseToken: started.runtimeLeaseToken,
    controllerGeneration: started.controllerGeneration,
    path: workspacePath,
    workspaceKey: "WID-1",
    repositoryIdentity: "acme/widgets",
    profileDigest: configuration().productProfile.digest,
    sourceRoot,
    workspaceRoot,
    baseRef: "refs/heads/main",
    baseSha,
    branch: "symphony/widgets",
    freshAttemptGeneration: null,
    now: "2026-08-26T10:00:01.000Z",
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
    now: "2026-08-26T10:00:02.000Z",
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
    now: "2026-08-26T10:00:03.000Z",
  });
  return {
    baseSha,
    begun,
    session,
    sourceRoot,
    started,
    stateRoot,
    store,
    workspacePath,
  };
}

describe("TrustedSourceMaterializer", () => {
  it("writes one exact commit from tracked and non-ignored source without using the candidate index", async () => {
    await withTempDirectory(async (directory) => {
      const setup = await fixture(directory);
      try {
        await Promise.all([
          writeFile(
            path.join(setup.workspacePath, "src", "tracked.txt"),
            "after\n",
          ),
          writeFile(path.join(setup.workspacePath, "new-source.txt"), "new\n"),
          mkdir(path.join(setup.workspacePath, "node_modules", "fixture"), {
            recursive: true,
          }),
        ]);
        await writeFile(
          path.join(
            setup.workspacePath,
            "node_modules",
            "fixture",
            "ignored.js",
          ),
          "ignored\n",
        );
        await command("git", [
          "-C",
          setup.workspacePath,
          "rm",
          "delete-me.txt",
        ]);
        setup.store.finishAttempt({
          sessionId: setup.session.id,
          attemptId: setup.started.attemptId,
          runtimeLeaseToken: setup.started.runtimeLeaseToken,
          controllerGeneration: setup.started.controllerGeneration,
          status: "completed",
          error: null,
          now: "2026-08-26T10:00:04.000Z",
        });
        let tick = 4;
        const materializer = new TrustedSourceMaterializer({
          gitExecutable: await realpath(await command("which", ["git"])),
          stateRoot: setup.stateRoot,
          stateStore: setup.store,
          now: () =>
            new Date(
              `2026-08-26T10:00:${String(++tick).padStart(2, "0")}.000Z`,
            ),
        });
        const authority = {
          sessionId: setup.session.id,
          attemptId: setup.started.attemptId,
          workspaceLeaseToken: setup.begun.workspaceLeaseToken,
          controllerGeneration: setup.started.controllerGeneration,
        };
        const result = await materializer.materialize(authority);
        expect(result).toMatchObject({
          phase: "branch_updated",
          parentSha: setup.baseSha,
          branch: "symphony/widgets",
          inputManifest: [
            { path: ".gitignore", origin: "tracked" },
            { path: "new-source.txt", origin: "untracked" },
            { path: "src/tracked.txt", origin: "tracked" },
          ],
        });
        expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/u);
        expect(
          await command("git", [
            "-C",
            setup.workspacePath,
            "show",
            `${result.commitSha}:src/tracked.txt`,
          ]),
        ).toBe("after");
        expect(
          await command("git", [
            "-C",
            setup.workspacePath,
            "show",
            `${result.commitSha}:new-source.txt`,
          ]),
        ).toBe("new");
        expect(
          await command("git", [
            "-C",
            setup.workspacePath,
            "ls-tree",
            "-r",
            "--name-only",
            result.commitSha!,
          ]),
        ).not.toContain("node_modules");
        expect(
          await command("git", [
            "-C",
            setup.workspacePath,
            "status",
            "--porcelain",
          ]),
        ).toBe("");

        const recovered = await materializer.materialize(authority);
        expect(recovered.id).toBe(result.id);
        expect(recovered.commitSha).toBe(result.commitSha);
        expect(
          setup.store.getSession(setup.session.id)?.materializations,
        ).toHaveLength(1);
      } finally {
        setup.store.close();
      }
    });
  });

  it("refuses nested repository authority without moving the managed branch", async () => {
    await withTempDirectory(async (directory) => {
      const setup = await fixture(directory);
      try {
        await mkdir(path.join(setup.workspacePath, "nested", ".git"), {
          recursive: true,
        });
        setup.store.finishAttempt({
          sessionId: setup.session.id,
          attemptId: setup.started.attemptId,
          runtimeLeaseToken: setup.started.runtimeLeaseToken,
          controllerGeneration: setup.started.controllerGeneration,
          status: "completed",
          error: null,
          now: "2026-08-26T10:00:04.000Z",
        });
        const materializer = new TrustedSourceMaterializer({
          gitExecutable: await realpath(await command("which", ["git"])),
          stateRoot: setup.stateRoot,
          stateStore: setup.store,
        });
        await expect(
          materializer.materialize({
            sessionId: setup.session.id,
            attemptId: setup.started.attemptId,
            workspaceLeaseToken: setup.begun.workspaceLeaseToken,
            controllerGeneration: setup.started.controllerGeneration,
          }),
        ).rejects.toMatchObject({ code: "materialization_refused" });
        expect(
          await command("git", [
            "-C",
            setup.workspacePath,
            "rev-parse",
            "refs/heads/symphony/widgets",
          ]),
        ).toBe(setup.baseSha);
        expect(
          setup.store.getSession(setup.session.id)?.materializations[0],
        ).toMatchObject({ phase: "refused" });
      } finally {
        setup.store.close();
      }
    });
  });

  it("never rolls back a completed branch when later workspace bytes diverge", async () => {
    await withTempDirectory(async (directory) => {
      const setup = await fixture(directory);
      try {
        await writeFile(
          path.join(setup.workspacePath, "src", "tracked.txt"),
          "materialized\n",
        );
        setup.store.finishAttempt({
          sessionId: setup.session.id,
          attemptId: setup.started.attemptId,
          runtimeLeaseToken: setup.started.runtimeLeaseToken,
          controllerGeneration: setup.started.controllerGeneration,
          status: "completed",
          error: null,
          now: "2026-08-26T10:00:04.000Z",
        });
        const materializer = new TrustedSourceMaterializer({
          gitExecutable: await realpath(await command("which", ["git"])),
          stateRoot: setup.stateRoot,
          stateStore: setup.store,
        });
        const authority = {
          sessionId: setup.session.id,
          attemptId: setup.started.attemptId,
          workspaceLeaseToken: setup.begun.workspaceLeaseToken,
          controllerGeneration: setup.started.controllerGeneration,
        };
        const completed = await materializer.materialize(authority);
        await writeFile(
          path.join(setup.workspacePath, "src", "tracked.txt"),
          "changed after completion\n",
        );

        await expect(materializer.materialize(authority)).rejects.toMatchObject(
          {
            code: "materialization_refused",
            message: expect.stringContaining("recorded input manifest"),
          },
        );
        expect(
          await command("git", [
            "-C",
            setup.workspacePath,
            "rev-parse",
            "refs/heads/symphony/widgets",
          ]),
        ).toBe(completed.commitSha);
        expect(
          setup.store.getSession(setup.session.id)?.materializations[0],
        ).toMatchObject({
          phase: "branch_updated",
          commitSha: completed.commitSha,
        });
      } finally {
        setup.store.close();
      }
    });
  });
});
