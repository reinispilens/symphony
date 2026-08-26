import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import type { GovernanceBinding } from "../deployment/model.js";
import { SymphonyError } from "../errors.js";
import {
  trustedGitArguments,
  trustedGitEnvironment,
} from "../repository/git-process.js";
import { parseRemoteIdentity } from "../repository/remote-identity.js";
import type { RepositoryContentSnapshot } from "../state/model.js";
import type { ResolvedGovernance } from "./model.js";
import {
  parseAcceptedGovernanceManifest,
  parseTrackerPolicy,
} from "./tracker-policy.js";

const MAX_GOVERNANCE_BLOB_BYTES = 4 * 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });

interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface GovernanceResolutionOptions {
  readonly authority: GovernanceBinding;
  readonly gitExecutable: string;
  readonly bindingPath: string;
  readonly productSourceRoot: string;
  readonly stateRoot: string;
  readonly workspaceRoot: string;
}

function refuse(message: string, cause?: unknown): never {
  throw new SymphonyError("governance_refused", message, {
    ...(cause === undefined ? {} : { cause }),
  });
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function insideOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function disjoint(first: string, second: string): boolean {
  return !insideOrEqual(first, second) && !insideOrEqual(second, first);
}

function command(
  gitExecutable: string,
  sourceRoot: string,
  args: readonly string[],
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      gitExecutable,
      [...trustedGitArguments(sourceRoot, args)],
      {
        encoding: "utf8",
        env: trustedGitEnvironment(),
        maxBuffer: MAX_GOVERNANCE_BLOB_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        resolve({
          exitCode: error === null ? 0 : typeof code === "number" ? code : 1,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

async function git(
  gitExecutable: string,
  sourceRoot: string,
  args: readonly string[],
): Promise<string> {
  const result = await command(gitExecutable, sourceRoot, args);
  if (result.exitCode !== 0) {
    refuse(
      `Git could not resolve accepted governance (${args[0] ?? "unknown"}): ${result.stderr.trim() || `exit ${result.exitCode}`}`,
    );
  }
  return result.stdout.trim();
}

function gitBytes(
  gitExecutable: string,
  sourceRoot: string,
  args: readonly string[],
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      gitExecutable,
      [...trustedGitArguments(sourceRoot, args)],
      {
        encoding: "buffer",
        env: trustedGitEnvironment(),
        maxBuffer: MAX_GOVERNANCE_BLOB_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(
            new SymphonyError(
              "governance_refused",
              `Git could not read accepted governance bytes (${args[0] ?? "unknown"}): ${Buffer.from(stderr).toString("utf8").trim() || error.message}`,
              { cause: error },
            ),
          );
          return;
        }
        resolve(Buffer.from(stdout));
      },
    );
  });
}

async function acceptedBlob(
  gitExecutable: string,
  sourceRoot: string,
  revision: string,
  repositoryPath: string,
): Promise<Buffer> {
  const tree = await git(gitExecutable, sourceRoot, [
    "ls-tree",
    revision,
    "--",
    repositoryPath,
  ]);
  const match = /^(100644|100755) blob [0-9a-f]{40}\t(.+)$/u.exec(tree);
  if (match === null || match[2] !== repositoryPath) {
    refuse(
      `Accepted governance ${repositoryPath} must be one regular Git blob at ${revision}`,
    );
  }
  const bytes = await gitBytes(gitExecutable, sourceRoot, [
    "show",
    `${revision}:${repositoryPath}`,
  ]);
  if (bytes.byteLength > MAX_GOVERNANCE_BLOB_BYTES) {
    refuse(
      `Accepted governance ${repositoryPath} exceeds ${MAX_GOVERNANCE_BLOB_BYTES} bytes`,
    );
  }
  return bytes;
}

function reference(
  repositoryIdentity: string,
  pathValue: string,
  revision: string,
  digest: string,
): RepositoryContentSnapshot {
  return {
    repositoryIdentity,
    path: pathValue,
    revision,
    digest,
  };
}

/** Resolve one operator-pinned publication without consulting candidate worktree bytes. */
export async function resolveAcceptedGovernance(
  options: GovernanceResolutionOptions,
): Promise<ResolvedGovernance> {
  const configuredRoot = path.resolve(options.authority.sourceRoot);
  let sourceRoot: string;
  try {
    const entry = await lstat(configuredRoot);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      refuse("Governance source root must be a real non-symlink directory");
    }
    sourceRoot = await realpath(configuredRoot);
  } catch (error) {
    if (error instanceof SymphonyError) throw error;
    refuse("Could not inspect governance source root", error);
  }
  if (sourceRoot !== configuredRoot) {
    refuse("Governance source root must contain no symbolic-link components");
  }
  const actualRoot = path.resolve(
    await git(options.gitExecutable, sourceRoot, [
      "rev-parse",
      "--show-toplevel",
    ]),
  );
  if (actualRoot !== sourceRoot) {
    refuse(`Governance source root ${sourceRoot} is not the Git worktree root`);
  }

  for (const [label, root] of [
    ["product source", path.resolve(options.productSourceRoot)],
    ["state", path.resolve(options.stateRoot)],
    ["workspace", path.resolve(options.workspaceRoot)],
  ] as const) {
    if (!disjoint(sourceRoot, root)) {
      refuse(`Governance source root must be disjoint from ${label}`);
    }
  }
  if (insideOrEqual(sourceRoot, path.resolve(options.bindingPath))) {
    refuse("Deployment binding must be outside the governance source root");
  }
  if (insideOrEqual(sourceRoot, path.resolve(options.gitExecutable))) {
    refuse(
      "Deployment Git executable must be outside the governance source root",
    );
  }

  const remote = await git(options.gitExecutable, sourceRoot, [
    "config",
    "--get",
    "remote.origin.url",
  ]);
  const remoteIdentity = parseRemoteIdentity(remote);
  if (
    remoteIdentity?.repositoryIdentity.toLowerCase() !==
    options.authority.repositoryIdentity.toLowerCase()
  ) {
    refuse(
      `Governance origin identity does not match ${options.authority.repositoryIdentity}`,
    );
  }

  const manifestRevision = await git(options.gitExecutable, sourceRoot, [
    "rev-parse",
    "--verify",
    `${options.authority.manifest.revision}^{commit}`,
  ]);
  if (manifestRevision !== options.authority.manifest.revision) {
    refuse("Governance manifest revision did not resolve exactly");
  }
  const manifestBytes = await acceptedBlob(
    options.gitExecutable,
    sourceRoot,
    manifestRevision,
    options.authority.manifest.path,
  );
  if (sha256(manifestBytes) !== options.authority.manifest.digest) {
    refuse("Accepted governance-manifest digest does not match its Git bytes");
  }
  const manifest = parseAcceptedGovernanceManifest(manifestBytes);
  if (
    manifest.repositoryIdentity.toLowerCase() !==
    options.authority.repositoryIdentity.toLowerCase()
  ) {
    refuse(
      "Governance manifest identity does not match its deployment binding",
    );
  }
  if (
    manifest.artifacts.doctrine.path === options.authority.manifest.path ||
    manifest.artifacts.trackerPolicy.path === options.authority.manifest.path
  ) {
    refuse(
      "Governance manifest must not identify itself as an accepted artifact",
    );
  }

  const acceptedRevision = await git(options.gitExecutable, sourceRoot, [
    "rev-parse",
    "--verify",
    `${manifest.acceptedRevision}^{commit}`,
  ]);
  if (acceptedRevision !== manifest.acceptedRevision) {
    refuse("Accepted governance revision did not resolve exactly");
  }
  const ancestry = await command(options.gitExecutable, sourceRoot, [
    "merge-base",
    "--is-ancestor",
    acceptedRevision,
    manifestRevision,
  ]);
  if (ancestry.exitCode !== 0) {
    refuse(
      "Accepted governance revision is not an ancestor of the manifest publication",
    );
  }

  const doctrineBytes = await acceptedBlob(
    options.gitExecutable,
    sourceRoot,
    acceptedRevision,
    manifest.artifacts.doctrine.path,
  );
  const policyBytes = await acceptedBlob(
    options.gitExecutable,
    sourceRoot,
    acceptedRevision,
    manifest.artifacts.trackerPolicy.path,
  );
  if (sha256(doctrineBytes) !== manifest.artifacts.doctrine.digest) {
    refuse("Accepted doctrine digest does not match its Git bytes");
  }
  if (sha256(policyBytes) !== manifest.artifacts.trackerPolicy.digest) {
    refuse("Accepted tracker-policy digest does not match its Git bytes");
  }
  try {
    if (utf8.decode(doctrineBytes).trim() === "") {
      refuse("Accepted doctrine must not be blank");
    }
  } catch (error) {
    if (error instanceof SymphonyError) throw error;
    refuse("Accepted doctrine must be valid UTF-8", error);
  }

  const manifestReference = reference(
    manifest.repositoryIdentity,
    options.authority.manifest.path,
    manifestRevision,
    options.authority.manifest.digest,
  );
  const doctrineReference = reference(
    manifest.repositoryIdentity,
    manifest.artifacts.doctrine.path,
    acceptedRevision,
    manifest.artifacts.doctrine.digest,
  );
  const policyReference = reference(
    manifest.repositoryIdentity,
    manifest.artifacts.trackerPolicy.path,
    acceptedRevision,
    manifest.artifacts.trackerPolicy.digest,
  );
  return {
    manifest,
    manifestReference,
    doctrineReference,
    trackerPolicy: parseTrackerPolicy(policyBytes, policyReference),
  };
}
