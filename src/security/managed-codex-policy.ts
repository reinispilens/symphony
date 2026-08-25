import type { JsonObject } from "../shared/json.js";

export const MANAGED_CODEX_COMMAND = "codex app-server";
export const MANAGED_CODEX_APPROVAL_POLICY = "never";
export const MANAGED_CODEX_THREAD_SANDBOX = "workspace-write";

/** Symphony-owned policy for commands authored inside a managed worktree. */
export function managedCodexTurnSandboxPolicy(
  writableRoots: readonly string[] = [],
): JsonObject {
  return {
    type: "workspaceWrite",
    writableRoots: [...writableRoots],
    networkAccess: false,
    excludeSlashTmp: true,
    excludeTmpdirEnvVar: true,
  };
}
