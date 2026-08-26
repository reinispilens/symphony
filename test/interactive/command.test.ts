import { existsSync } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { executeManualWorkCommand } from "../../src/interactive/command.js";
import { stateDatabasePathFromStateRoot } from "../../src/state/sqlite-store.js";
import { withTempDirectory } from "../support/factories.js";
import { resolvedDeploymentFixture, TEST_ACTOR } from "./support.js";

const NOW = new Date("2026-08-26T10:00:00.000Z");

describe("manual WorkSession command application", () => {
  it("runs start, attach, plan, steer, and status through one reopened store", async () => {
    await withTempDirectory(async (directory) => {
      const deployment = resolvedDeploymentFixture(directory);
      const bindingPath = path.join(directory, "operator", "binding.json");
      const resolveBinding = vi.fn(async () => deployment);
      const dependencies = {
        actorId: TEST_ACTOR,
        clock: () => NOW,
        inspectCheckout: async (input: { readonly observedAt: string }) => ({
          path: "/worktrees/manual-symphony",
          repositoryIdentity: "reinispilens/symphony",
          inspection: {
            status: "observed" as const,
            headSha: "a".repeat(40),
            trackedChanges: false,
            untrackedChanges: true,
            ignoredChanges: false,
            observedAt: input.observedAt,
          },
        }),
        resolveBinding,
      };
      const context = { environment: {} };
      const started = await executeManualWorkCommand(
        {
          action: "start",
          bindingPath,
          intent: "Finish manual control",
        },
        context,
        dependencies,
      );
      const sessionId = started.match(
        /^WorkSession ([0-9a-f-]+) started\./u,
      )?.[1];
      expect(sessionId).toBeDefined();
      expect(started).toContain("Revision: 1");

      const attached = await executeManualWorkCommand(
        {
          action: "attach",
          bindingPath,
          sessionId: sessionId!,
          expectedRevision: 1,
          path: "/worktrees/manual-symphony",
        },
        context,
        dependencies,
      );
      expect(attached).toContain("Revision: 2");

      const planFile = path.join(directory, "plan.md");
      await writeFile(
        planFile,
        "## Plan\nFinish the five commands.\n\n## Acceptance criteria\n- State survives restart\n- Product repository remains untouched\n",
      );
      const planned = await executeManualWorkCommand(
        {
          action: "plan",
          bindingPath,
          sessionId: sessionId!,
          expectedRevision: 2,
          filePath: planFile,
        },
        context,
        dependencies,
      );
      expect(planned).toContain("recorded plan v1");
      expect(planned).toContain("Revision: 3");

      await executeManualWorkCommand(
        {
          action: "steer",
          bindingPath,
          sessionId: sessionId!,
          expectedRevision: 3,
          message: "Keep all lifecycle ownership in Symphony",
        },
        context,
        dependencies,
      );
      await executeManualWorkCommand(
        {
          action: "steer",
          bindingPath,
          sessionId: sessionId!,
          expectedRevision: 4,
          message: "EXCEPTION GP-09: accepted by the local human controller",
        },
        context,
        dependencies,
      );

      const json = await executeManualWorkCommand(
        {
          action: "status",
          bindingPath,
          sessionId: sessionId!,
          json: true,
        },
        context,
        dependencies,
      );
      expect(JSON.parse(json)).toMatchObject({
        schemaVersion: 1,
        session: { id: sessionId, revision: 5 },
        plan: { version: 1, summary: "Finish the five commands." },
        evidence: { posture: "advisory" },
        decisions: {
          count: 2,
          recent: [
            { kind: "steering" },
            { kind: "exception", principleId: "GP-09" },
          ],
        },
      });
      expect(resolveBinding).toHaveBeenCalledTimes(6);
      expect(resolveBinding).toHaveBeenLastCalledWith(
        expect.objectContaining({ requireDeliverySecrets: false }),
      );

      const databasePath = stateDatabasePathFromStateRoot(
        deployment.binding.stateRoot,
      );
      expect((await stat(path.dirname(databasePath))).mode & 0o777).toBe(0o700);
      expect((await stat(databasePath)).mode & 0o777).toBe(0o600);
    });
  });

  it("refuses relative authority and does not create state for a missing follow-up", async () => {
    await withTempDirectory(async (directory) => {
      const deployment = resolvedDeploymentFixture(directory);
      const resolveBinding = vi.fn(async () => deployment);
      await expect(
        executeManualWorkCommand(
          {
            action: "start",
            bindingPath: "binding.json",
            intent: "unsafe",
          },
          { environment: {} },
          { resolveBinding },
        ),
      ).rejects.toMatchObject({ code: "interactive_control_refused" });
      expect(resolveBinding).not.toHaveBeenCalled();

      const databasePath = stateDatabasePathFromStateRoot(
        deployment.binding.stateRoot,
      );
      const legacy = {
        ...deployment,
        binding: { ...deployment.binding, schemaVersion: 2, governance: null },
        governance: null,
      } as unknown as typeof deployment;
      await expect(
        executeManualWorkCommand(
          {
            action: "start",
            bindingPath: path.join(directory, "operator", "binding.json"),
            intent: "must remain uncreated",
          },
          { environment: {} },
          { resolveBinding: async () => legacy },
        ),
      ).rejects.toMatchObject({ code: "deployment_binding_refused" });
      expect(existsSync(databasePath)).toBe(false);

      await expect(
        executeManualWorkCommand(
          {
            action: "status",
            bindingPath: path.join(directory, "operator", "binding.json"),
            sessionId: "missing",
            json: false,
          },
          { environment: {} },
          { resolveBinding },
        ),
      ).rejects.toMatchObject({ code: "state_not_found" });
      expect(existsSync(databasePath)).toBe(false);
    });
  });
});
