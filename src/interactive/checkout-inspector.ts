import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import type { ResolvedDeployment } from "../deployment/model.js";
import { SymphonyError } from "../errors.js";
import {
  trustedGitArguments,
  trustedGitEnvironment,
} from "../repository/git-process.js";
import { parseRemoteIdentity } from "../repository/remote-identity.js";
import type { HumanCheckoutInspection } from "../state/model.js";

const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;

interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface CheckoutObservation {
  readonly inspection: Extract<HumanCheckoutInspection, { status: "observed" }>;
  readonly path: string;
  readonly repositoryIdentity: string;
}

function refuse(message: string, cause?: unknown): never {
  throw new SymphonyError("interactive_control_refused", message, {
    ...(cause === undefined ? {} : { cause }),
  });
}

function insideOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function overlaps(left: string, right: string): boolean {
  return insideOrEqual(left, right) || insideOrEqual(right, left);
}

function command(
  executable: string,
  cwd: string,
  args: readonly string[],
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...trustedGitArguments(cwd, args)],
      {
        cwd: "/",
        encoding: "utf8",
        env: trustedGitEnvironment(),
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ exitCode: 0, stdout, stderr });
          return;
        }
        if (typeof error.code === "number") {
          resolve({ exitCode: error.code, stdout, stderr });
          return;
        }
        reject(error);
      },
    );
  });
}

async function git(
  deployment: ResolvedDeployment,
  cwd: string,
  args: readonly string[],
  label: string,
): Promise<string> {
  let result: CommandResult;
  try {
    result = await command(deployment.binding.gitExecutable, cwd, args);
  } catch (error) {
    refuse(`Could not ${label}`, error);
  }
  if (result.exitCode !== 0) {
    refuse(
      `Could not ${label}: ${result.stderr.trim() || `Git exited ${result.exitCode}`}`,
    );
  }
  return result.stdout.trim();
}

function assertOutsideControlRoots(
  deployment: ResolvedDeployment,
  repositoryRoot: string,
): void {
  for (const [label, root] of [
    ["Symphony state", deployment.binding.stateRoot],
    ["Symphony managed-workspace", deployment.binding.workspaceRoot],
    ...(deployment.binding.governance === null
      ? []
      : [["accepted-governance", deployment.binding.governance.sourceRoot]]),
  ] as const) {
    if (overlaps(root, repositoryRoot)) {
      refuse(`Human checkout must be disjoint from the ${label} root`);
    }
  }
  if (insideOrEqual(repositoryRoot, deployment.bindingPath)) {
    refuse("Human checkout must not contain the operator deployment binding");
  }
}

export async function inspectHumanCheckout(input: {
  readonly deployment: ResolvedDeployment;
  readonly observedAt: string;
  readonly path: string;
}): Promise<CheckoutObservation> {
  if (!path.isAbsolute(input.path)) {
    refuse("Human checkout path must be absolute");
  }
  if (/[\0\r\n]/u.test(input.path)) {
    refuse("Human checkout path contains unsupported control characters");
  }
  const requested = path.resolve(input.path);
  let requestedEntry;
  let requestedRealPath: string;
  try {
    requestedEntry = await lstat(requested);
    requestedRealPath = await realpath(requested);
  } catch (error) {
    refuse(`Could not inspect human checkout ${requested}`, error);
  }
  if (!requestedEntry.isDirectory() || requestedEntry.isSymbolicLink()) {
    refuse(`Human checkout ${requested} must be a real non-symlink directory`);
  }
  if (requestedRealPath !== requested) {
    refuse(
      `Human checkout ${requested} must contain no symbolic-link components`,
    );
  }

  const rootText = await git(
    input.deployment,
    requestedRealPath,
    ["rev-parse", "--show-toplevel"],
    "resolve the human checkout Git root",
  );
  if (/[\0\r\n]/u.test(rootText)) {
    refuse("Human checkout Git root contains unsupported control characters");
  }
  const repositoryRoot = path.resolve(rootText);
  let repositoryRealPath: string;
  try {
    repositoryRealPath = await realpath(repositoryRoot);
  } catch (error) {
    refuse(
      `Could not resolve human checkout Git root ${repositoryRoot}`,
      error,
    );
  }
  if (repositoryRealPath !== repositoryRoot) {
    refuse(`Human checkout Git root ${repositoryRoot} is not canonical`);
  }
  assertOutsideControlRoots(input.deployment, repositoryRoot);

  const remote = await git(
    input.deployment,
    repositoryRoot,
    ["config", "--get", "remote.origin.url"],
    "read the human checkout origin",
  );
  const identity = parseRemoteIdentity(remote);
  const expected = input.deployment.serviceConfig.repository;
  if (
    expected === null ||
    identity?.hostname !== expected.hostname.toLowerCase() ||
    identity.repositoryIdentity.toLowerCase() !==
      expected.identity.toLowerCase()
  ) {
    refuse(
      `Human checkout origin does not match ${expected?.hostname ?? "the accepted host"}/${input.deployment.profile.repositoryIdentity}`,
    );
  }

  const executableFilters = await command(
    input.deployment.binding.gitExecutable,
    repositoryRoot,
    ["config", "--get-regexp", "^filter\\..*\\.(clean|smudge|process)$"],
  );
  if (
    (executableFilters.exitCode !== 0 && executableFilters.exitCode !== 1) ||
    executableFilters.stderr.trim() !== ""
  ) {
    refuse(
      `Could not inspect human checkout filter configuration: ${executableFilters.stderr.trim() || `Git exited ${executableFilters.exitCode}`}`,
    );
  }
  if (executableFilters.stdout.trim() !== "") {
    refuse(
      "Human checkout inspection refuses executable Git clean/smudge/process filters",
    );
  }

  const headResult = await command(
    input.deployment.binding.gitExecutable,
    repositoryRoot,
    ["rev-parse", "--verify", "HEAD"],
  );
  const headSha =
    headResult.exitCode === 0 &&
    /^[0-9a-f]{40,64}$/u.test(headResult.stdout.trim())
      ? headResult.stdout.trim()
      : headResult.exitCode === 128
        ? null
        : refuse(
            `Could not inspect human checkout HEAD: ${headResult.stderr.trim() || `Git exited ${headResult.exitCode}`}`,
          );

  const status = await git(
    input.deployment,
    repositoryRoot,
    [
      "status",
      "--porcelain=v1",
      "--untracked-files=normal",
      "--ignored=matching",
      "--ignore-submodules=all",
    ],
    "inspect human checkout status",
  );
  const lines = status === "" ? [] : status.split("\n");
  return {
    path: repositoryRoot,
    repositoryIdentity: identity.repositoryIdentity,
    inspection: {
      status: "observed",
      headSha,
      trackedChanges: lines.some(
        (line) => !line.startsWith("?? ") && !line.startsWith("!! "),
      ),
      untrackedChanges: lines.some((line) => line.startsWith("?? ")),
      ignoredChanges: lines.some((line) => line.startsWith("!! ")),
      observedAt: input.observedAt,
    },
  };
}
