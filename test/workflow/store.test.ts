import { writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { WorkflowStore } from "../../src/workflow/store.js";
import {
  testTrackerProfiles,
  withTempDirectory,
} from "../support/factories.js";

function workflow(intervalMs: number): string {
  return `---
tracker:
  kind: test
polling:
  interval_ms: ${intervalMs}
---
Work on {{ issue.identifier }}.
`;
}

describe("WorkflowStore", () => {
  it("atomically reloads valid edits and retains the last-known-good snapshot after an invalid edit", async () => {
    await withTempDirectory(async (directory) => {
      const workflowPath = path.join(directory, "WORKFLOW.md");
      await writeFile(workflowPath, workflow(1000), "utf8");
      const onReloadError = vi.fn();
      const store = new WorkflowStore({
        workflowPath,
        trackerProfiles: testTrackerProfiles,
        onReloadError,
      });

      const initial = await store.loadInitial();
      expect(initial.config.polling.intervalMs).toBe(1000);

      await writeFile(workflowPath, workflow(2000), "utf8");
      await expect(store.checkForUpdates()).resolves.toMatchObject({
        status: "reloaded",
      });
      expect(store.current.config.polling.intervalMs).toBe(2000);

      await writeFile(workflowPath, "---\ntracker: [\n---\nPrompt", "utf8");
      await expect(store.checkForUpdates()).resolves.toMatchObject({
        status: "rejected",
      });
      expect(store.current.config.polling.intervalMs).toBe(2000);
      expect(onReloadError).toHaveBeenCalledOnce();

      await expect(store.checkForUpdates()).resolves.toMatchObject({
        status: "rejected",
      });
      expect(onReloadError).toHaveBeenCalledTimes(2);

      await writeFile(workflowPath, workflow(3000), "utf8");
      await expect(store.checkForUpdates()).resolves.toMatchObject({
        status: "reloaded",
      });
      expect(store.current.config.polling.intervalMs).toBe(3000);
    });
  });

  it("detects workflow changes while watching", async () => {
    await withTempDirectory(async (directory) => {
      const workflowPath = path.join(directory, "WORKFLOW.md");
      await writeFile(workflowPath, workflow(1000), "utf8");

      let resolveReload: ((value: number) => void) | undefined;
      const reloaded = new Promise<number>((resolve) => {
        resolveReload = resolve;
      });
      const store = new WorkflowStore({
        workflowPath,
        trackerProfiles: testTrackerProfiles,
        watchIntervalMs: 20,
        onReload: (snapshot) =>
          resolveReload?.(snapshot.config.polling.intervalMs),
      });
      await store.loadInitial();
      store.startWatching();

      try {
        await writeFile(workflowPath, workflow(2500), "utf8");
        await expect(
          Promise.race([
            reloaded,
            new Promise((resolve) =>
              setTimeout(() => resolve("timeout"), 2000),
            ),
          ]),
        ).resolves.toBe(2500);
      } finally {
        store.close();
      }
    });
  });

  it("keeps callback failures outside the atomic configuration decision", async () => {
    await withTempDirectory(async (directory) => {
      const workflowPath = path.join(directory, "WORKFLOW.md");
      await writeFile(workflowPath, workflow(1000), "utf8");
      const store = new WorkflowStore({
        workflowPath,
        trackerProfiles: testTrackerProfiles,
        onReload: () => {
          throw new Error("consumer failed");
        },
        onReloadError: () => {
          throw new Error("error consumer failed");
        },
      });
      await store.loadInitial();

      await writeFile(workflowPath, workflow(2000), "utf8");
      await expect(store.checkForUpdates()).resolves.toMatchObject({
        status: "reloaded",
      });
      expect(store.current.config.polling.intervalMs).toBe(2000);

      await writeFile(workflowPath, "---\ntracker: [\n---\nPrompt", "utf8");
      await expect(store.checkForUpdates()).resolves.toMatchObject({
        status: "rejected",
      });
      expect(store.current.config.polling.intervalMs).toBe(2000);
    });
  });
});
