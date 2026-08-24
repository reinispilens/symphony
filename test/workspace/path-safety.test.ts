import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertAgentCwd,
  assertSafeExistingWorkspace,
  workspaceKey,
  workspaceLocation,
} from "../../src/workspace/path-safety.js";
import { withTempDirectory } from "../support/factories.js";

describe("workspace path safety", () => {
  it("keeps already-safe identifiers unchanged", () => {
    expect(workspaceKey("SYM-123.release_1")).toBe("SYM-123.release_1");
  });

  it("adds a stable 64-bit hash when sanitization changes an identifier", () => {
    const slash = workspaceKey("A/B");
    const question = workspaceKey("A?B");
    expect(slash).toMatch(/^A_B-[a-f0-9]{16}$/u);
    expect(workspaceKey("A/B")).toBe(slash);
    expect(question).not.toBe(slash);
    expect(workspaceKey(".symphony")).toMatch(/^\.symphony-[a-f0-9]{16}$/u);
  });

  it("rejects identifiers whose otherwise-valid key is not a strict root child", () => {
    expect(() => workspaceLocation("/workspaces", ".")).toThrowError(
      expect.objectContaining({ code: "workspace_path_unsafe" }),
    );
    expect(() => workspaceLocation("/workspaces", "..")).toThrowError(
      expect.objectContaining({ code: "workspace_path_unsafe" }),
    );
  });

  it("rejects a symbolic-link workspace that escapes the root", async () => {
    await withTempDirectory(async (directory) => {
      const root = path.join(directory, "root");
      const outside = path.join(directory, "outside");
      await Promise.all([mkdir(root), mkdir(outside)]);
      const candidate = path.join(root, "SYM-123");
      await symlink(outside, candidate, "dir");

      await expect(
        assertSafeExistingWorkspace(root, candidate),
      ).rejects.toMatchObject({
        code: "workspace_not_directory",
      });
    });
  });

  it("requires the coding-agent cwd to equal the real workspace path", async () => {
    await withTempDirectory(async (directory) => {
      const root = path.join(directory, "root");
      const workspace = path.join(root, "SYM-123");
      const other = path.join(root, "SYM-456");
      await mkdir(workspace, { recursive: true });
      await mkdir(other);

      await expect(
        assertAgentCwd(root, workspace, workspace),
      ).resolves.toBeUndefined();
      await expect(
        assertAgentCwd(root, workspace, other),
      ).rejects.toMatchObject({
        code: "workspace_path_unsafe",
      });
    });
  });
});
