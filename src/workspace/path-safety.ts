import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { SymphonyError } from "../errors.js";

const UNSAFE_WORKSPACE_CHARACTER = /[^A-Za-z0-9._-]/gu;
const RESERVED_WORKSPACE_KEYS = new Set([".symphony"]);

export interface WorkspaceLocation {
  readonly path: string;
  readonly root: string;
  readonly workspaceKey: string;
}

export function workspaceKey(identifier: string): string {
  const sanitized = identifier.replace(UNSAFE_WORKSPACE_CHARACTER, "_");
  if (
    sanitized === identifier &&
    !RESERVED_WORKSPACE_KEYS.has(sanitized.toLowerCase())
  ) {
    return sanitized;
  }
  const suffix = createHash("sha256")
    .update(identifier)
    .digest("hex")
    .slice(0, 16);
  return `${sanitized}-${suffix}`;
}

function isStrictChild(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function workspaceLocation(
  root: string,
  identifier: string,
): WorkspaceLocation {
  const normalizedRoot = path.resolve(root);
  const key = workspaceKey(identifier);
  const workspacePath = path.resolve(normalizedRoot, key);
  if (!isStrictChild(normalizedRoot, workspacePath)) {
    throw new SymphonyError(
      "workspace_path_unsafe",
      `Workspace path for identifier ${JSON.stringify(identifier)} is not a strict child of ${normalizedRoot}`,
      {
        context: {
          workspace_root: normalizedRoot,
          workspace_path: workspacePath,
          workspace_key: key,
        },
      },
    );
  }
  return { path: workspacePath, root: normalizedRoot, workspaceKey: key };
}

export async function assertSafeExistingWorkspace(
  root: string,
  workspacePath: string,
): Promise<void> {
  const normalizedRoot = path.resolve(root);
  const normalizedWorkspace = path.resolve(workspacePath);
  if (!isStrictChild(normalizedRoot, normalizedWorkspace)) {
    throw new SymphonyError(
      "workspace_path_unsafe",
      "Workspace path is outside its configured root",
      {
        context: {
          workspace_root: normalizedRoot,
          workspace_path: normalizedWorkspace,
        },
      },
    );
  }

  const entry = await lstat(normalizedWorkspace);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new SymphonyError(
      "workspace_not_directory",
      `Workspace path ${normalizedWorkspace} must be a real directory, not a file or symbolic link`,
      {
        context: {
          workspace_root: normalizedRoot,
          workspace_path: normalizedWorkspace,
        },
      },
    );
  }

  const [realRoot, realWorkspace] = await Promise.all([
    realpath(normalizedRoot),
    realpath(normalizedWorkspace),
  ]);
  if (!isStrictChild(realRoot, realWorkspace)) {
    throw new SymphonyError(
      "workspace_path_unsafe",
      `Resolved workspace path ${realWorkspace} escapes resolved root ${realRoot}`,
      { context: { workspace_root: realRoot, workspace_path: realWorkspace } },
    );
  }
}

export async function assertAgentCwd(
  root: string,
  workspacePath: string,
  agentCwd: string,
): Promise<void> {
  await assertSafeExistingWorkspace(root, workspacePath);
  const [realWorkspace, realCwd] = await Promise.all([
    realpath(workspacePath),
    realpath(agentCwd),
  ]);
  if (realWorkspace !== realCwd) {
    throw new SymphonyError(
      "workspace_path_unsafe",
      `Coding-agent cwd ${realCwd} does not equal workspace path ${realWorkspace}`,
      { context: { workspace_path: realWorkspace, agent_cwd: realCwd } },
    );
  }
}
