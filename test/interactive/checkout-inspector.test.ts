import { execFileSync } from "node:child_process";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { inspectHumanCheckout } from "../../src/interactive/checkout-inspector.js";
import { withTempDirectory } from "../support/factories.js";
import { resolvedDeploymentFixture } from "./support.js";

const OBSERVED_AT = "2026-08-26T09:00:00.000Z";

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env["PATH"],
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  }).trim();
}

async function gitExecutable(): Promise<string> {
  return realpath(execFileSync("which", ["git"], { encoding: "utf8" }).trim());
}

async function repositoryFixture(
  directory: string,
  identity = "reinispilens/symphony",
): Promise<string> {
  const repository = path.join(directory, "checkout");
  await mkdir(path.join(repository, "nested"), { recursive: true });
  git(repository, ["init", "--initial-branch=main"]);
  git(repository, ["config", "user.email", "test@example.test"]);
  git(repository, ["config", "user.name", "Symphony Test"]);
  await writeFile(path.join(repository, "README.md"), "# Test\n");
  await writeFile(path.join(repository, ".gitignore"), "ignored.log\n");
  git(repository, ["add", "README.md", ".gitignore"]);
  git(repository, ["commit", "-m", "fixture"]);
  git(repository, [
    "remote",
    "add",
    "origin",
    `https://github.com/${identity}.git`,
  ]);
  return repository;
}

describe("human checkout inspection", () => {
  it("resolves a nested path to its clean matching Git root", async () => {
    await withTempDirectory(async (directory) => {
      const repository = await repositoryFixture(directory);
      const deployment = resolvedDeploymentFixture(directory, {
        gitExecutable: await gitExecutable(),
      });
      await expect(
        inspectHumanCheckout({
          deployment,
          observedAt: OBSERVED_AT,
          path: path.join(repository, "nested"),
        }),
      ).resolves.toEqual({
        path: repository,
        repositoryIdentity: "reinispilens/symphony",
        inspection: {
          status: "observed",
          headSha: git(repository, ["rev-parse", "HEAD"]),
          trackedChanges: false,
          untrackedChanges: false,
          ignoredChanges: false,
          observedAt: OBSERVED_AT,
        },
      });
    });
  });

  it("records tracked, untracked, and ignored facts without changing bytes", async () => {
    await withTempDirectory(async (directory) => {
      const repository = await repositoryFixture(directory);
      await writeFile(path.join(repository, "README.md"), "changed\n");
      await writeFile(path.join(repository, "new.txt"), "untracked\n");
      await writeFile(path.join(repository, "ignored.log"), "ignored\n");
      const deployment = resolvedDeploymentFixture(directory, {
        gitExecutable: await gitExecutable(),
      });
      const before = git(repository, ["status", "--porcelain", "--ignored"]);
      const result = await inspectHumanCheckout({
        deployment,
        observedAt: OBSERVED_AT,
        path: repository,
      });
      const after = git(repository, ["status", "--porcelain", "--ignored"]);
      expect(result.inspection).toMatchObject({
        trackedChanges: true,
        untrackedChanges: true,
        ignoredChanges: true,
      });
      expect(after).toBe(before);
    });
  });

  it("refuses symlink aliases and repository identity mismatch", async () => {
    await withTempDirectory(async (directory) => {
      const repository = await repositoryFixture(
        directory,
        "reinispilens/dyslexify",
      );
      const alias = path.join(directory, "checkout-alias");
      await symlink(repository, alias);
      const deployment = resolvedDeploymentFixture(directory, {
        gitExecutable: await gitExecutable(),
      });
      await expect(
        inspectHumanCheckout({
          deployment,
          observedAt: OBSERVED_AT,
          path: alias,
        }),
      ).rejects.toThrow("non-symlink directory");
      await expect(
        inspectHumanCheckout({
          deployment,
          observedAt: OBSERVED_AT,
          path: repository,
        }),
      ).rejects.toThrow("origin does not match");
    });
  });

  it("refuses any checkout overlapping Symphony control roots", async () => {
    await withTempDirectory(async (directory) => {
      const repository = await repositoryFixture(directory);
      const deployment = resolvedDeploymentFixture(directory, {
        gitExecutable: await gitExecutable(),
        stateRoot: repository,
      });
      await expect(
        inspectHumanCheckout({
          deployment,
          observedAt: OBSERVED_AT,
          path: repository,
        }),
      ).rejects.toThrow("disjoint from the Symphony state root");
    });
  });

  it("refuses repository-configured executable filters before status inspection", async () => {
    await withTempDirectory(async (directory) => {
      const repository = await repositoryFixture(directory);
      git(repository, ["config", "filter.hostile.clean", "/usr/bin/false"]);
      const deployment = resolvedDeploymentFixture(directory, {
        gitExecutable: await gitExecutable(),
      });
      await expect(
        inspectHumanCheckout({
          deployment,
          observedAt: OBSERVED_AT,
          path: repository,
        }),
      ).rejects.toThrow("refuses executable Git clean/smudge/process filters");
    });
  });

  it("records a detached HEAD and accepts an unborn matching repository", async () => {
    await withTempDirectory(async (directory) => {
      const repository = await repositoryFixture(directory);
      const head = git(repository, ["rev-parse", "HEAD"]);
      git(repository, ["checkout", "--detach", head]);
      const deployment = resolvedDeploymentFixture(directory, {
        gitExecutable: await gitExecutable(),
      });
      await expect(
        inspectHumanCheckout({
          deployment,
          observedAt: OBSERVED_AT,
          path: repository,
        }),
      ).resolves.toMatchObject({ inspection: { headSha: head } });

      const unborn = path.join(directory, "unborn");
      await mkdir(unborn);
      git(unborn, ["init", "--initial-branch=main"]);
      git(unborn, [
        "remote",
        "add",
        "origin",
        "git@github.com:reinispilens/symphony.git",
      ]);
      await expect(
        inspectHumanCheckout({
          deployment,
          observedAt: OBSERVED_AT,
          path: unborn,
        }),
      ).resolves.toMatchObject({ inspection: { headSha: null } });
    });
  });
});
