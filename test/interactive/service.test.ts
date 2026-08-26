import path from "node:path";

import { describe, expect, it } from "vitest";

import { InteractiveWorkService } from "../../src/interactive/service.js";
import { projectWorkStatus } from "../../src/interactive/status.js";
import {
  SqliteSymphonyStateStore,
  stateDatabasePathFromStateRoot,
} from "../../src/state/sqlite-store.js";
import { withTempDirectory } from "../support/factories.js";
import { resolvedDeploymentFixture, TEST_ACTOR } from "./support.js";

const NOW = new Date("2026-08-26T08:00:00.000Z");

function observation(
  repositoryIdentity = "reinispilens/symphony",
  dirty = true,
) {
  return async (input: { readonly observedAt: string }) => ({
    path: "/worktrees/manual-symphony",
    repositoryIdentity,
    inspection: {
      status: "observed" as const,
      headSha: "a".repeat(40),
      trackedChanges: dirty,
      untrackedChanges: false,
      ignoredChanges: false,
      observedAt: input.observedAt,
    },
  });
}

describe("InteractiveWorkService", () => {
  it("starts one boardless session with exact accepted authority", async () => {
    await withTempDirectory(async (directory) => {
      const store = SqliteSymphonyStateStore.openInMemory();
      try {
        const deployment = resolvedDeploymentFixture(directory);
        const service = new InteractiveWorkService({
          actorId: TEST_ACTOR,
          clock: () => NOW,
          deployment,
          stateStore: store,
        });
        const session = service.startInteractive("  Build manual control  ");
        expect(session).toMatchObject({
          origin: {
            kind: "interactive",
            initiatingActor: TEST_ACTOR,
          },
          repositoryIdentity: "reinispilens/symphony",
          intent: "Build manual control",
          attempts: [],
          humanAttachment: null,
          controller: {
            kind: "human",
            controllerId: TEST_ACTOR,
            generation: 1,
          },
          doctrine: deployment.governance!.doctrineReference,
          configuration: deployment.acceptedConfiguration,
        });
        expect(() =>
          service.startInteractive("line one\nline two"),
        ).toThrowError(
          expect.objectContaining({ code: "interactive_input_invalid" }),
        );
        expect(() => service.getStatus("not-a-uuid")).toThrowError(
          expect.objectContaining({ code: "interactive_input_invalid" }),
        );
      } finally {
        store.close();
      }
    });
  });

  it("refuses compatibility bindings without accepted governance", async () => {
    await withTempDirectory(async (directory) => {
      const store = SqliteSymphonyStateStore.openInMemory();
      try {
        const current = resolvedDeploymentFixture(directory);
        const legacy = {
          ...current,
          binding: { ...current.binding, schemaVersion: 2, governance: null },
          governance: null,
        } as unknown as typeof current;
        const service = new InteractiveWorkService({
          actorId: TEST_ACTOR,
          clock: () => NOW,
          deployment: legacy,
          stateStore: store,
        });
        expect(() =>
          service.startInteractive("Unpinned doctrine"),
        ).toThrowError(
          expect.objectContaining({ code: "deployment_binding_refused" }),
        );
      } finally {
        store.close();
      }
    });
  });

  it("fences plan, steering, and exceptions by revision and human controller", async () => {
    await withTempDirectory(async (directory) => {
      const store = SqliteSymphonyStateStore.openInMemory();
      try {
        const deployment = resolvedDeploymentFixture(directory);
        const service = new InteractiveWorkService({
          actorId: TEST_ACTOR,
          clock: () => NOW,
          deployment,
          stateStore: store,
        });
        const intruder = new InteractiveWorkService({
          actorId: "local-user:1001:intruder",
          clock: () => NOW,
          deployment,
          stateStore: store,
        });
        const started = service.startInteractive("Build manual control");
        const planned = service.replacePlan({
          sessionId: started.id,
          expectedRevision: started.revision,
          plan: {
            summary: "Keep one state aggregate",
            acceptanceCriteria: ["No sidecar store"],
          },
        });
        expect(planned.plan).toMatchObject({
          version: 1,
          recordedBy: TEST_ACTOR,
        });
        expect(() =>
          service.appendSteering({
            sessionId: started.id,
            expectedRevision: started.revision,
            message: "This stale write must fail",
          }),
        ).toThrowError(expect.objectContaining({ code: "stale_revision" }));
        expect(() =>
          intruder.appendSteering({
            sessionId: started.id,
            expectedRevision: planned.revision,
            message: "EXCEPTION GP-07: accept from the wrong actor",
          }),
        ).toThrowError(
          expect.objectContaining({ code: "controller_conflict" }),
        );
        expect(() =>
          service.appendSteering({
            sessionId: started.id,
            expectedRevision: planned.revision,
            message: "EXCEPTION without a cited principle",
          }),
        ).toThrowError(
          expect.objectContaining({ code: "interactive_input_invalid" }),
        );

        const steered = service.appendSteering({
          sessionId: started.id,
          expectedRevision: planned.revision,
          message: "Keep product adapters thin",
        });
        const excepted = service.appendSteering({
          sessionId: started.id,
          expectedRevision: steered.revision,
          message: "EXCEPTION GP-07: documented temporary exception",
        });
        expect(excepted.decisions).toMatchObject([
          { kind: "steering", text: "Keep product adapters thin" },
          {
            kind: "exception",
            principleId: "GP-07",
            text: "documented temporary exception",
            doctrine: deployment.governance!.doctrineReference,
          },
        ]);
      } finally {
        store.close();
      }
    });
  });

  it("attaches only a matching observed human checkout and creates no Attempt", async () => {
    await withTempDirectory(async (directory) => {
      const store = SqliteSymphonyStateStore.openInMemory();
      try {
        const deployment = resolvedDeploymentFixture(directory);
        const started = new InteractiveWorkService({
          actorId: TEST_ACTOR,
          clock: () => NOW,
          deployment,
          stateStore: store,
        }).startInteractive("Attach existing work");
        const service = new InteractiveWorkService({
          actorId: TEST_ACTOR,
          clock: () => NOW,
          deployment,
          inspectCheckout: observation(),
          stateStore: store,
        });
        const attached = await service.attachWorkspace({
          sessionId: started.id,
          expectedRevision: started.revision,
          path: "/worktrees/manual-symphony/nested",
        });
        expect(attached).toMatchObject({
          attempts: [],
          humanAttachment: {
            ownership: "human",
            removalPolicy: "never",
            path: "/worktrees/manual-symphony",
          },
        });
        await expect(
          service.attachWorkspace({
            sessionId: started.id,
            expectedRevision: attached.revision,
            path: "/worktrees/second",
          }),
        ).rejects.toMatchObject({ code: "workspace_conflict" });
      } finally {
        store.close();
      }
    });
  });

  it("refuses a checkout or binding from another repository authority", async () => {
    await withTempDirectory(async (directory) => {
      const store = SqliteSymphonyStateStore.openInMemory();
      try {
        const deployment = resolvedDeploymentFixture(directory);
        const started = new InteractiveWorkService({
          actorId: TEST_ACTOR,
          clock: () => NOW,
          deployment,
          stateStore: store,
        }).startInteractive("Keep identity pinned");
        const mismatch = new InteractiveWorkService({
          actorId: TEST_ACTOR,
          clock: () => NOW,
          deployment,
          inspectCheckout: observation("reinispilens/dyslexify"),
          stateStore: store,
        });
        await expect(
          mismatch.attachWorkspace({
            sessionId: started.id,
            expectedRevision: started.revision,
            path: "/worktrees/dyslexify",
          }),
        ).rejects.toMatchObject({ code: "repository_mismatch" });

        const repinned = new InteractiveWorkService({
          actorId: TEST_ACTOR,
          clock: () => NOW,
          deployment: resolvedDeploymentFixture(directory, {
            bindingDigest: `sha256:${"9".repeat(64)}`,
          }),
          stateStore: store,
        });
        expect(() => repinned.getStatus(started.id)).toThrowError(
          expect.objectContaining({ code: "interactive_control_refused" }),
        );
      } finally {
        store.close();
      }
    });
  });

  it("claims protected evidence only for an exact clean HEAD and current plan digest", async () => {
    await withTempDirectory(async (directory) => {
      const store = SqliteSymphonyStateStore.openInMemory();
      try {
        const deployment = resolvedDeploymentFixture(directory);
        const service = new InteractiveWorkService({
          actorId: TEST_ACTOR,
          clock: () => NOW,
          deployment,
          inspectCheckout: observation("reinispilens/symphony", false),
          stateStore: store,
        });
        const started = service.startInteractive("Prove evidence honestly");
        const attached = await service.attachWorkspace({
          sessionId: started.id,
          expectedRevision: started.revision,
          path: "/worktrees/manual-symphony",
        });
        const planned = service.replacePlan({
          sessionId: started.id,
          expectedRevision: attached.revision,
          plan: {
            summary: "Prove this exact plan",
            acceptanceCriteria: ["Match source and plan"],
          },
        });
        const before = service.getStatus(started.id);
        expect(before.evidence).toMatchObject({ posture: "unproven" });
        const planDigest = before.evidence.planDigest;
        expect(planDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);

        const proof = {
          id: "proof-1",
          checkName: "proof / Protected final",
          checkRunId: "101",
          workflowRunId: "202",
          sourceSha: "a".repeat(40),
          planDigest: planDigest!,
          adapterDigest: null,
          policyDigest: null,
          resultDigest: `sha256:${"b".repeat(64)}`,
          evidenceDigest: `sha256:${"c".repeat(64)}`,
          status: "passed",
          recordedAt: NOW.toISOString(),
          observedAt: NOW.toISOString(),
        } as const;
        expect(
          projectWorkStatus({ ...planned, proof: [proof] }).evidence,
        ).toMatchObject({
          posture: "protected",
          matchingProofId: "proof-1",
        });

        const changed = service.replacePlan({
          sessionId: started.id,
          expectedRevision: planned.revision,
          plan: {
            summary: "Changed after proof",
            acceptanceCriteria: ["Requires a new proof"],
          },
        });
        expect(
          projectWorkStatus({ ...changed, proof: [proof] }).evidence,
        ).toMatchObject({
          posture: "unproven",
          matchingProofId: null,
        });
      } finally {
        store.close();
      }
    });
  });

  it("survives process-style reopen and exposes a bounded secret-free projection", async () => {
    await withTempDirectory(async (directory) => {
      const deployment = resolvedDeploymentFixture(directory);
      const databasePath = stateDatabasePathFromStateRoot(
        deployment.binding.stateRoot,
      );
      const firstStore = SqliteSymphonyStateStore.open(databasePath);
      const first = new InteractiveWorkService({
        actorId: TEST_ACTOR,
        clock: () => NOW,
        deployment,
        stateStore: firstStore,
      }).startInteractive("Continue after restart");
      firstStore.close();

      const secondStore = SqliteSymphonyStateStore.open(databasePath);
      const secondService = new InteractiveWorkService({
        actorId: TEST_ACTOR,
        clock: () => NOW,
        deployment,
        inspectCheckout: observation(),
        stateStore: secondStore,
      });
      const attached = await secondService.attachWorkspace({
        sessionId: first.id,
        expectedRevision: first.revision,
        path: "/worktrees/manual-symphony",
      });
      const planned = secondService.replacePlan({
        sessionId: first.id,
        expectedRevision: attached.revision,
        plan: {
          summary: "Persist the same manual WorkSession",
          acceptanceCriteria: [
            "State survives reopen",
            "Checkout stays human-owned",
          ],
        },
      });
      secondService.appendSteering({
        sessionId: first.id,
        expectedRevision: planned.revision,
        message: "Do not launch an agent",
      });
      secondStore.close();

      const thirdStore = SqliteSymphonyStateStore.open(databasePath);
      try {
        const status = new InteractiveWorkService({
          actorId: TEST_ACTOR,
          clock: () => NOW,
          deployment,
          stateStore: thirdStore,
        }).getStatus(first.id);
        expect(status).toMatchObject({
          schemaVersion: 1,
          session: { intent: "Continue after restart", revision: 4 },
          plan: { version: 1, summary: "Persist the same manual WorkSession" },
          humanAttachment: { ownership: "human", removalPolicy: "never" },
          runtime: { attemptCount: 0, activeAttempt: null },
          evidence: { posture: "advisory" },
        });
        expect(status.decisions).toMatchObject({
          count: 1,
          truncated: false,
          recent: [{ kind: "steering", text: "Do not launch an agent" }],
        });
        const serialized = JSON.stringify(status);
        expect(serialized).not.toContain("runtimeLeaseToken");
        expect(serialized).not.toContain("workspaceLeaseToken");
        expect(serialized).not.toContain("secret-value");
        expect(status.configuration?.authoringContext).toEqual({
          repositoryIdentity: "reinispilens/symphony",
          revision: "a".repeat(40),
          manifestDigest: `sha256:${"6".repeat(64)}`,
          entryCount: 2,
        });
      } finally {
        thirdStore.close();
      }
      expect(path.isAbsolute(databasePath)).toBe(true);
    });
  });
});
