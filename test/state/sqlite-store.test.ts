import { stat } from "node:fs/promises";
import path from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { SqliteSymphonyStateStore } from "../../src/state/sqlite-store.js";
import { withTempDirectory } from "../support/factories.js";

const START = "2026-08-25T10:00:00.000Z";

function trackerInput() {
  return {
    trackerKind: "github-projects",
    repositoryIdentity: "reinispilens/symphony",
    issueId: "opaque-1",
    issueIdentifier: "SYM-1",
    issueUrl: "https://example.test/issues/1",
    intent: "Build one durable state model",
    controllerId: "tracker:github-projects:reinispilens/symphony",
    doctrine: null,
    configuration: null,
    now: START,
  } as const;
}

function acceptedConfiguration() {
  return {
    productProfile: {
      repositoryIdentity: "reinispilens/symphony",
      path: ".symphony/repository-profile.json",
      revision: "a".repeat(40),
      digest: "sha256:profile",
    },
    authoringContext: {
      repositoryIdentity: "reinispilens/symphony",
      revision: "a".repeat(40),
      manifestDigest: "sha256:context-manifest",
      entries: [
        { path: "AGENTS.md", digest: "sha256:agents" },
        { path: "SPEC.md", digest: "sha256:spec" },
      ],
    },
    deploymentBinding: {
      id: "personal-symphony",
      digest: "sha256:binding",
    },
    deliveryGrant: null,
  } as const;
}

function acceptedDeliveryConfiguration(
  authority: "owner-gated" | "full-in-scope" = "owner-gated",
) {
  return {
    ...acceptedConfiguration(),
    deliveryGrant: {
      authority,
      governingPolicy: {
        repositoryIdentity: "reinispilens/.github",
        path: "agent-system/delivery-policy.json",
        revision: "b".repeat(40),
        digest: "sha256:delivery-policy",
      },
      requiredChecks: ["proof / Protected final"],
    },
  } as const;
}

function interactiveInput(initiatingActor = "reinis") {
  return {
    repositoryIdentity: "reinispilens/symphony",
    initiatingActor,
    intent: "Drive one boardless WorkSession",
    controllerId: `human:${initiatingActor}`,
    doctrine: {
      repositoryIdentity: "reinispilens/.github",
      path: "agent-system/golden-principles.md",
      revision: "b".repeat(40),
      digest: "sha256:golden-principles",
    },
    configuration: acceptedConfiguration(),
    now: START,
  } as const;
}

function startAttempt(
  store: SqliteSymphonyStateStore,
  sessionId: string,
  overrides: Partial<Parameters<typeof store.startAttempt>[0]> = {},
) {
  return store.startAttempt({
    sessionId,
    controllerGeneration: 1,
    holderId: "daemon-a",
    trackerAttempt: null,
    freshAttemptGeneration: null,
    now: START,
    leaseExpiresAt: "2026-08-25T10:02:00.000Z",
    ...overrides,
  });
}

function downgradeToV1Attached(
  databasePath: string,
  sessionId: string,
  workspacePath: string,
): void {
  const raw = new Database(databasePath);
  try {
    const row = raw
      .prepare("SELECT document_json FROM work_sessions WHERE id = ?")
      .get(sessionId) as { document_json: string };
    const document = JSON.parse(row.document_json) as Record<string, unknown>;
    const attempts = document["attempts"] as Array<Record<string, unknown>>;
    const attempt = attempts[0];
    if (attempt === undefined)
      throw new Error("migration fixture needs attempt");
    attempt["workspaceLease"] = {
      mode: "attached",
      path: workspacePath,
      workspaceKey: "legacy-attached",
      removalPolicy: "never",
      recordedAt: "2026-08-25T10:00:01.000Z",
    };
    document["schemaVersion"] = 1;
    delete document["configuration"];
    delete document["plan"];
    delete document["humanAttachment"];
    delete document["materializations"];
    raw
      .prepare("UPDATE work_sessions SET document_json = ? WHERE id = ?")
      .run(JSON.stringify(document), sessionId);
    raw.pragma("user_version = 1");
  } finally {
    raw.close();
  }
}

describe("SqliteSymphonyStateStore", () => {
  it("creates one tracker WorkSession and pins doctrine without replacing it", () => {
    const store = SqliteSymphonyStateStore.openInMemory();
    try {
      const created = store.getOrCreateTrackerSession(trackerInput());
      expect(created.origin).toMatchObject({
        kind: "tracker",
        issueId: "opaque-1",
      });
      expect(created.revision).toBe(1);

      const pinned = store.getOrCreateTrackerSession({
        ...trackerInput(),
        doctrine: {
          repositoryIdentity: "reinispilens/.github",
          path: "agent-system/golden-principles.md",
          revision: "abc123",
          digest: "sha256:first",
        },
        configuration: acceptedConfiguration(),
        now: "2026-08-25T10:00:01.000Z",
      });
      const retained = store.getOrCreateTrackerSession({
        ...trackerInput(),
        doctrine: {
          repositoryIdentity: "reinispilens/.github",
          path: "agent-system/golden-principles.md",
          revision: "newer",
          digest: "sha256:newer",
        },
        configuration: {
          ...acceptedConfiguration(),
          deploymentBinding: {
            id: "replacement-binding",
            digest: "sha256:replacement-binding",
          },
        },
        now: "2026-08-25T10:00:02.000Z",
      });

      expect(pinned.id).toBe(created.id);
      expect(retained.doctrine).toEqual(pinned.doctrine);
      expect(retained.configuration).toEqual(pinned.configuration);
      expect(store.listActiveSessions()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("refuses to rewrite Attempt history by pinning accepted inputs late", () => {
    const store = SqliteSymphonyStateStore.openInMemory();
    try {
      const session = store.getOrCreateTrackerSession(trackerInput());
      const started = startAttempt(store, session.id);
      store.finishAttempt({
        sessionId: session.id,
        attemptId: started.attemptId,
        runtimeLeaseToken: started.runtimeLeaseToken,
        controllerGeneration: started.controllerGeneration,
        status: "completed",
        error: null,
        now: "2026-08-25T10:00:01.000Z",
      });

      expect(() =>
        store.getOrCreateTrackerSession({
          ...trackerInput(),
          doctrine: interactiveInput().doctrine,
          configuration: acceptedConfiguration(),
          now: "2026-08-25T10:00:02.000Z",
        }),
      ).toThrowError(expect.objectContaining({ code: "input_conflict" }));
      expect(store.getSession(session.id)).toMatchObject({
        doctrine: null,
        configuration: null,
      });
    } finally {
      store.close();
    }
  });

  it("keeps plans, decisions, and a human checkout on the WorkSession root", () => {
    const store = SqliteSymphonyStateStore.openInMemory();
    try {
      const session = store.createInteractiveSession(interactiveInput());
      expect(session).toMatchObject({
        schemaVersion: 2,
        configuration: acceptedConfiguration(),
        attempts: [],
        humanAttachment: null,
      });

      const planned = store.replacePlan({
        sessionId: session.id,
        expectedRevision: session.revision,
        controllerGeneration: session.controller.generation,
        summary: "Align the orchestration estate",
        acceptanceCriteria: [
          "Human checkout remains human-owned",
          "Product repositories keep only thin adapters",
        ],
        recordedBy: session.controller.controllerId,
        now: "2026-08-25T10:00:01.000Z",
      });
      expect(planned.plan).toMatchObject({
        version: 1,
        summary: "Align the orchestration estate",
      });

      const steered = store.appendDecision({
        sessionId: session.id,
        expectedRevision: planned.revision,
        controllerGeneration: session.controller.generation,
        kind: "steering",
        text: "Keep manual authoring in the same WorkSession model",
        acceptedBy: session.controller.controllerId,
        principleId: null,
        now: "2026-08-25T10:00:02.000Z",
      });
      expect(steered.decisions[0]).toMatchObject({
        kind: "steering",
        principleId: null,
        doctrine: null,
      });

      const excepted = store.appendDecision({
        sessionId: session.id,
        expectedRevision: steered.revision,
        controllerGeneration: session.controller.generation,
        kind: "exception",
        text: "Permit the documented local exception",
        acceptedBy: session.controller.controllerId,
        principleId: "GP-15",
        now: "2026-08-25T10:00:03.000Z",
      });
      expect(excepted.decisions[1]).toMatchObject({
        kind: "exception",
        principleId: "GP-15",
        doctrine: interactiveInput().doctrine,
      });

      const attached = store.attachHumanWorkspace({
        sessionId: session.id,
        expectedRevision: excepted.revision,
        controllerId: session.controller.controllerId,
        path: "/worktrees/manual-symphony",
        repositoryIdentity: "reinispilens/symphony",
        inspection: {
          status: "observed",
          headSha: "c".repeat(40),
          trackedChanges: true,
          untrackedChanges: false,
          ignoredChanges: true,
          observedAt: "2026-08-25T10:00:04.000Z",
        },
        now: "2026-08-25T10:00:04.000Z",
      });
      expect(attached.humanAttachment).toMatchObject({
        kind: "human-attachment",
        ownership: "human",
        removalPolicy: "never",
        path: "/worktrees/manual-symphony",
      });
      expect(attached.attempts).toEqual([]);
      expect(() => startAttempt(store, session.id)).toThrowError(
        expect.objectContaining({ code: "workspace_conflict" }),
      );
      expect(() =>
        store.appendDecision({
          sessionId: session.id,
          expectedRevision: excepted.revision,
          controllerGeneration: session.controller.generation,
          kind: "steering",
          text: "This write is stale",
          acceptedBy: session.controller.controllerId,
          principleId: null,
          now: "2026-08-25T10:00:05.000Z",
        }),
      ).toThrowError(expect.objectContaining({ code: "stale_revision" }));
    } finally {
      store.close();
    }
  });

  it("refuses a human checkout already claimed by another active WorkSession", () => {
    const store = SqliteSymphonyStateStore.openInMemory();
    try {
      const first = store.createInteractiveSession(interactiveInput("first"));
      const second = store.createInteractiveSession(interactiveInput("second"));
      store.attachHumanWorkspace({
        sessionId: first.id,
        expectedRevision: first.revision,
        controllerId: first.controller.controllerId,
        path: "/worktrees/shared",
        repositoryIdentity: "reinispilens/symphony",
        inspection: {
          status: "observed",
          headSha: "d".repeat(40),
          trackedChanges: false,
          untrackedChanges: false,
          ignoredChanges: false,
          observedAt: "2026-08-25T10:00:01.000Z",
        },
        now: "2026-08-25T10:00:01.000Z",
      });

      expect(() =>
        store.attachHumanWorkspace({
          sessionId: second.id,
          expectedRevision: second.revision,
          controllerId: second.controller.controllerId,
          path: "/worktrees/shared",
          repositoryIdentity: "reinispilens/symphony",
          inspection: {
            status: "observed",
            headSha: "d".repeat(40),
            trackedChanges: false,
            untrackedChanges: false,
            ignoredChanges: false,
            observedAt: "2026-08-25T10:00:02.000Z",
          },
          now: "2026-08-25T10:00:02.000Z",
        }),
      ).toThrowError(expect.objectContaining({ code: "workspace_conflict" }));
    } finally {
      store.close();
    }
  });

  it("refuses managed allocation over a human-owned checkout", () => {
    const store = SqliteSymphonyStateStore.openInMemory();
    try {
      const human = store.createInteractiveSession(interactiveInput());
      store.attachHumanWorkspace({
        sessionId: human.id,
        expectedRevision: human.revision,
        controllerId: human.controller.controllerId,
        path: "/worktrees/human-owned",
        repositoryIdentity: "reinispilens/symphony",
        inspection: {
          status: "observed",
          headSha: "d".repeat(40),
          trackedChanges: false,
          untrackedChanges: false,
          ignoredChanges: false,
          observedAt: "2026-08-25T10:00:01.000Z",
        },
        now: "2026-08-25T10:00:01.000Z",
      });

      const tracker = store.getOrCreateTrackerSession({
        ...trackerInput(),
        issueId: "opaque-managed-conflict",
        issueIdentifier: "SYM-2",
      });
      const started = startAttempt(store, tracker.id);
      expect(() =>
        store.beginManagedWorkspace({
          sessionId: tracker.id,
          attemptId: started.attemptId,
          runtimeLeaseToken: started.runtimeLeaseToken,
          controllerGeneration: started.controllerGeneration,
          path: "/worktrees/human-owned",
          workspaceKey: "SYM-2",
          repositoryIdentity: "reinispilens/symphony",
          profileDigest: "sha256:profile",
          sourceRoot: "/repositories/symphony",
          workspaceRoot: "/worktrees",
          baseRef: "refs/remotes/origin/main",
          baseSha: "a".repeat(40),
          branch: "symphony/SYM-2",
          freshAttemptGeneration: null,
          now: "2026-08-25T10:00:02.000Z",
        }),
      ).toThrowError(expect.objectContaining({ code: "workspace_conflict" }));
      expect(
        store.getSession(tracker.id)?.attempts[0]?.workspaceLease,
      ).toBeNull();
    } finally {
      store.close();
    }
  });

  it("uses the WorkSession revision to fence concurrent controller edits", async () => {
    await withTempDirectory(async (directory) => {
      const databasePath = path.join(directory, "state.sqlite");
      const first = SqliteSymphonyStateStore.open(databasePath);
      const second = SqliteSymphonyStateStore.open(databasePath);
      try {
        const session = first.createInteractiveSession(interactiveInput());
        for (const suffix of ["", "-wal", "-shm"]) {
          expect((await stat(`${databasePath}${suffix}`)).mode & 0o777).toBe(
            0o600,
          );
        }
        const staleView = second.getSession(session.id);
        if (staleView === null)
          throw new Error("fixture session was not found");

        first.replacePlan({
          sessionId: session.id,
          expectedRevision: session.revision,
          controllerGeneration: session.controller.generation,
          summary: "First controller write",
          acceptanceCriteria: [],
          recordedBy: session.controller.controllerId,
          now: "2026-08-25T10:00:01.000Z",
        });

        expect(() =>
          second.appendDecision({
            sessionId: session.id,
            expectedRevision: staleView.revision,
            controllerGeneration: staleView.controller.generation,
            kind: "steering",
            text: "Stale concurrent write",
            acceptedBy: staleView.controller.controllerId,
            principleId: null,
            now: "2026-08-25T10:00:02.000Z",
          }),
        ).toThrowError(expect.objectContaining({ code: "stale_revision" }));
      } finally {
        second.close();
        first.close();
      }
    });
  });

  it("requires external quiescence before replacing an expired cross-process runtime lease", async () => {
    await withTempDirectory(async (directory) => {
      const databasePath = path.join(directory, "state", "symphony.sqlite");
      const first = SqliteSymphonyStateStore.open(databasePath);
      const second = SqliteSymphonyStateStore.open(databasePath);
      try {
        const session = first.getOrCreateTrackerSession(trackerInput());
        const oldAttempt = startAttempt(first, session.id);

        expect(() =>
          startAttempt(second, session.id, { holderId: "daemon-b" }),
        ).toThrowError(
          expect.objectContaining({ code: "active_runtime_lease" }),
        );

        const replacementInput = {
          holderId: "daemon-b",
          now: "2026-08-25T10:03:00.000Z",
          leaseExpiresAt: "2026-08-25T10:05:00.000Z",
        } as const;
        expect(() =>
          startAttempt(second, session.id, replacementInput),
        ).toThrowError(
          expect.objectContaining({ code: "active_runtime_lease" }),
        );

        const [candidate] = second.listExpiredRuntimeLeases(
          replacementInput.now,
        );
        expect(candidate).toMatchObject({
          sessionId: session.id,
          attemptId: oldAttempt.attemptId,
          runtimeLeaseToken: oldAttempt.runtimeLeaseToken,
        });
        second.expireRuntimeLease({
          ...candidate!,
          now: replacementInput.now,
        });
        const replacement = startAttempt(second, session.id, replacementInput);
        expect(replacement.session.attempts).toHaveLength(2);
        expect(replacement.session.attempts[0]?.status).toBe("interrupted");

        expect(() =>
          first.recordRuntimeCorrelation({
            sessionId: session.id,
            attemptId: oldAttempt.attemptId,
            runtimeLeaseToken: oldAttempt.runtimeLeaseToken,
            controllerGeneration: oldAttempt.controllerGeneration,
            sessionIdValue: "stale-thread",
            now: "2026-08-25T10:03:01.000Z",
          }),
        ).toThrowError(expect.objectContaining({ code: "stale_fence" }));
      } finally {
        second.close();
        first.close();
      }

      expect((await stat(databasePath)).mode & 0o777).toBe(0o600);
    });
  });

  it("fences attempt admission and makes matching terminal writes idempotent", () => {
    const store = SqliteSymphonyStateStore.openInMemory();
    try {
      const session = store.getOrCreateTrackerSession(trackerInput());
      expect(() =>
        startAttempt(store, session.id, {
          controllerGeneration: session.controller.generation + 1,
        }),
      ).toThrowError(expect.objectContaining({ code: "stale_fence" }));
      expect(store.getSession(session.id)?.attempts).toHaveLength(0);

      expect(() =>
        store.markSessionTerminal(
          session.id,
          session.controller.generation + 1,
          "completed",
          "2026-08-25T10:00:01.000Z",
        ),
      ).toThrowError(expect.objectContaining({ code: "stale_fence" }));
      const completed = store.markSessionTerminal(
        session.id,
        session.controller.generation,
        "completed",
        "2026-08-25T10:00:01.000Z",
      );
      expect(
        store.markSessionTerminal(
          session.id,
          session.controller.generation,
          "completed",
          "2026-08-25T10:00:02.000Z",
        ).revision,
      ).toBe(completed.revision);
      expect(() =>
        store.markSessionTerminal(
          session.id,
          session.controller.generation,
          "cancelled",
          "2026-08-25T10:00:03.000Z",
        ),
      ).toThrowError(expect.objectContaining({ code: "stale_fence" }));
    } finally {
      store.close();
    }
  });

  it("records workspace ownership and releases only through the active fence", () => {
    const store = SqliteSymphonyStateStore.openInMemory();
    try {
      const session = store.getOrCreateTrackerSession(trackerInput());
      const started = startAttempt(store, session.id);
      const workspace = store.recordWorkspace({
        sessionId: session.id,
        attemptId: started.attemptId,
        runtimeLeaseToken: started.runtimeLeaseToken,
        controllerGeneration: started.controllerGeneration,
        mode: "legacy-hook",
        path: "/worktrees/sym-1",
        workspaceKey: "SYM-1",
        now: "2026-08-25T10:00:01.000Z",
      });
      expect(workspace.attempts[0]?.workspaceLease).toMatchObject({
        mode: "legacy-hook",
        removalPolicy: "guarded",
      });
      expect(
        store.recordWorkspace({
          sessionId: session.id,
          attemptId: started.attemptId,
          runtimeLeaseToken: started.runtimeLeaseToken,
          controllerGeneration: started.controllerGeneration,
          mode: "legacy-hook",
          path: "/worktrees/sym-1",
          workspaceKey: "SYM-1",
          now: "2026-08-25T10:00:01.500Z",
        }).revision,
      ).toBe(workspace.revision);

      const finished = store.finishAttempt({
        sessionId: session.id,
        attemptId: started.attemptId,
        runtimeLeaseToken: started.runtimeLeaseToken,
        controllerGeneration: started.controllerGeneration,
        status: "completed",
        error: null,
        now: "2026-08-25T10:00:02.000Z",
      });
      expect(finished.attempts[0]?.runtimeLease.status).toBe("released");
      expect(() =>
        store.recordRuntimeCorrelation({
          sessionId: session.id,
          attemptId: started.attemptId,
          runtimeLeaseToken: started.runtimeLeaseToken,
          controllerGeneration: started.controllerGeneration,
          processId: 123,
          now: "2026-08-25T10:00:03.000Z",
        }),
      ).toThrowError(expect.objectContaining({ code: "stale_fence" }));
    } finally {
      store.close();
    }
  });

  it("records managed allocation before effects and guards every lifecycle transition", () => {
    const store = SqliteSymphonyStateStore.openInMemory();
    try {
      const session = store.getOrCreateTrackerSession(trackerInput());
      const started = startAttempt(store, session.id);
      const begun = store.beginManagedWorkspace({
        sessionId: session.id,
        attemptId: started.attemptId,
        runtimeLeaseToken: started.runtimeLeaseToken,
        controllerGeneration: started.controllerGeneration,
        path: "/workspaces/SYM-1",
        workspaceKey: "SYM-1",
        repositoryIdentity: "reinispilens/symphony",
        profileDigest: "sha256:profile",
        sourceRoot: "/repositories/symphony",
        workspaceRoot: "/workspaces",
        baseRef: "refs/heads/main",
        baseSha: "a".repeat(40),
        branch: "symphony/SYM-1-abc12345",
        freshAttemptGeneration: null,
        now: "2026-08-25T10:00:01.000Z",
      });
      expect(begun.session.attempts[0]?.workspaceLease).toMatchObject({
        mode: "managed",
        phase: "allocating",
      });

      const provisioned = store.transitionManagedWorkspace({
        sessionId: session.id,
        attemptId: started.attemptId,
        workspaceLeaseToken: begun.workspaceLeaseToken,
        controllerGeneration: started.controllerGeneration,
        runtimeLeaseToken: started.runtimeLeaseToken,
        expectedPhases: ["allocating"],
        phase: "provisioned",
        error: null,
        now: "2026-08-25T10:00:02.000Z",
      });
      expect(provisioned.attempts[0]?.workspaceLease).toMatchObject({
        phase: "provisioned",
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
        now: "2026-08-25T10:00:03.000Z",
      });

      expect(() =>
        store.transitionManagedWorkspace({
          sessionId: session.id,
          attemptId: started.attemptId,
          workspaceLeaseToken: begun.workspaceLeaseToken,
          controllerGeneration: started.controllerGeneration,
          runtimeLeaseToken: null,
          expectedPhases: ["ready"],
          phase: "removal_pending",
          error: null,
          now: "2026-08-25T10:00:04.000Z",
        }),
      ).toThrowError(expect.objectContaining({ code: "active_runtime_lease" }));

      store.finishAttempt({
        sessionId: session.id,
        attemptId: started.attemptId,
        runtimeLeaseToken: started.runtimeLeaseToken,
        controllerGeneration: started.controllerGeneration,
        status: "completed",
        error: null,
        now: "2026-08-25T10:00:05.000Z",
      });
      store.transitionManagedWorkspace({
        sessionId: session.id,
        attemptId: started.attemptId,
        workspaceLeaseToken: begun.workspaceLeaseToken,
        controllerGeneration: started.controllerGeneration,
        runtimeLeaseToken: null,
        expectedPhases: ["ready"],
        phase: "removal_pending",
        error: null,
        now: "2026-08-25T10:00:06.000Z",
      });
      const removed = store.transitionManagedWorkspace({
        sessionId: session.id,
        attemptId: started.attemptId,
        workspaceLeaseToken: begun.workspaceLeaseToken,
        controllerGeneration: started.controllerGeneration,
        runtimeLeaseToken: null,
        expectedPhases: ["removal_pending"],
        phase: "removed",
        error: null,
        now: "2026-08-25T10:00:07.000Z",
      });
      expect(removed.attempts[0]?.workspaceLease).toMatchObject({
        phase: "removed",
        removedAt: "2026-08-25T10:00:07.000Z",
      });
    } finally {
      store.close();
    }
  });

  it("refuses one live managed branch being claimed by two WorkSessions", () => {
    const store = SqliteSymphonyStateStore.openInMemory();
    try {
      const firstSession = store.getOrCreateTrackerSession({
        ...trackerInput(),
        issueId: "branch-owner-1",
        issueIdentifier: "SYM-branch-1",
      });
      const secondSession = store.getOrCreateTrackerSession({
        ...trackerInput(),
        issueId: "branch-owner-2",
        issueIdentifier: "SYM-branch-2",
      });
      const first = startAttempt(store, firstSession.id);
      const second = startAttempt(store, secondSession.id);
      store.beginManagedWorkspace({
        sessionId: firstSession.id,
        attemptId: first.attemptId,
        runtimeLeaseToken: first.runtimeLeaseToken,
        controllerGeneration: first.controllerGeneration,
        path: "/workspaces/branch-owner-1",
        workspaceKey: "branch-owner-1",
        repositoryIdentity: "reinispilens/symphony",
        profileDigest: "sha256:profile",
        sourceRoot: "/repositories/symphony",
        workspaceRoot: "/workspaces",
        baseRef: "refs/remotes/origin/main",
        baseSha: "a".repeat(40),
        branch: "symphony/shared-branch",
        freshAttemptGeneration: null,
        now: "2026-08-25T10:00:01.000Z",
      });

      expect(() =>
        store.beginManagedWorkspace({
          sessionId: secondSession.id,
          attemptId: second.attemptId,
          runtimeLeaseToken: second.runtimeLeaseToken,
          controllerGeneration: second.controllerGeneration,
          path: "/workspaces/branch-owner-2",
          workspaceKey: "branch-owner-2",
          repositoryIdentity: "reinispilens/symphony",
          profileDigest: "sha256:profile",
          sourceRoot: "/repositories/symphony",
          workspaceRoot: "/workspaces",
          baseRef: "refs/remotes/origin/main",
          baseSha: "a".repeat(40),
          branch: "symphony/shared-branch",
          freshAttemptGeneration: null,
          now: "2026-08-25T10:00:02.000Z",
        }),
      ).toThrowError(expect.objectContaining({ code: "workspace_conflict" }));
    } finally {
      store.close();
    }
  });

  it("keeps one managed repository base pinned across every WorkSession attempt", () => {
    const store = SqliteSymphonyStateStore.openInMemory();
    try {
      const session = store.getOrCreateTrackerSession(trackerInput());
      const first = startAttempt(store, session.id);
      store.beginManagedWorkspace({
        sessionId: session.id,
        attemptId: first.attemptId,
        runtimeLeaseToken: first.runtimeLeaseToken,
        controllerGeneration: first.controllerGeneration,
        path: "/workspaces/SYM-1",
        workspaceKey: "SYM-1",
        repositoryIdentity: "reinispilens/symphony",
        profileDigest: "sha256:profile",
        sourceRoot: "/repositories/symphony",
        workspaceRoot: "/workspaces",
        baseRef: "refs/remotes/origin/main",
        baseSha: "a".repeat(40),
        branch: "symphony/SYM-1-first",
        freshAttemptGeneration: "first",
        now: "2026-08-25T10:00:01.000Z",
      });
      store.finishAttempt({
        sessionId: session.id,
        attemptId: first.attemptId,
        runtimeLeaseToken: first.runtimeLeaseToken,
        controllerGeneration: first.controllerGeneration,
        status: "completed",
        error: null,
        now: "2026-08-25T10:00:02.000Z",
      });

      const second = startAttempt(store, session.id, {
        freshAttemptGeneration: "second",
        now: "2026-08-25T10:00:03.000Z",
        leaseExpiresAt: "2026-08-25T10:02:03.000Z",
      });
      expect(() =>
        store.beginManagedWorkspace({
          sessionId: session.id,
          attemptId: second.attemptId,
          runtimeLeaseToken: second.runtimeLeaseToken,
          controllerGeneration: second.controllerGeneration,
          path: "/workspaces/SYM-1",
          workspaceKey: "SYM-1",
          repositoryIdentity: "reinispilens/symphony",
          profileDigest: "sha256:profile",
          sourceRoot: "/repositories/symphony",
          workspaceRoot: "/workspaces",
          baseRef: "refs/remotes/origin/main",
          baseSha: "b".repeat(40),
          branch: "symphony/SYM-1-second",
          freshAttemptGeneration: "second",
          now: "2026-08-25T10:00:04.000Z",
        }),
      ).toThrowError(expect.objectContaining({ code: "stale_fence" }));
      expect(store.getSession(session.id)?.attempts[1]?.workspaceLease).toBe(
        null,
      );
    } finally {
      store.close();
    }
  });

  it("persists preparation under the workspace and interrupts it with an expired lease", () => {
    const store = SqliteSymphonyStateStore.openInMemory();
    try {
      const session = store.getOrCreateTrackerSession(trackerInput());
      const started = startAttempt(store, session.id);
      store.recordWorkspace({
        sessionId: session.id,
        attemptId: started.attemptId,
        runtimeLeaseToken: started.runtimeLeaseToken,
        controllerGeneration: started.controllerGeneration,
        mode: "legacy-directory",
        path: "/workspaces/SYM-1",
        workspaceKey: "SYM-1",
        now: "2026-08-25T10:00:01.000Z",
      });
      const preparing = store.startPreparation({
        sessionId: session.id,
        attemptId: started.attemptId,
        runtimeLeaseToken: started.runtimeLeaseToken,
        controllerGeneration: started.controllerGeneration,
        command: ["pnpm", "install", "--ignore-scripts"],
        manifestDigest: "sha256:manifest",
        lockfileDigest: "sha256:lockfile",
        inputDigest: "sha256:inputs",
        dependencyPolicy: {
          id: "offline-test-v1",
          digest: `sha256:${"1".repeat(64)}`,
          mode: "offline",
          registry: "https://registry.npmjs.org/",
          seedStoreRoot: "/dependency-stores/pnpm",
          pnpmVersion: "11.3.0",
        },
        cachePath: "/workspaces/.symphony/preparation/session/attempt",
        now: "2026-08-25T10:00:02.000Z",
      });
      expect(preparing.attempts[0]?.preparation).toMatchObject({
        driverVersion: 2,
        status: "running",
        lifecycleScripts: false,
      });

      const expiryTime = "2026-08-25T10:03:00.000Z";
      const candidates = store.listExpiredRuntimeLeases(expiryTime);
      expect(candidates).toEqual([
        {
          sessionId: session.id,
          attemptId: started.attemptId,
          runtimeLeaseToken: started.runtimeLeaseToken,
          controllerGeneration: started.controllerGeneration,
          expiresAt: "2026-08-25T10:02:00.000Z",
        },
      ]);
      const expired = store.expireRuntimeLease({
        ...candidates[0]!,
        now: expiryTime,
      });
      expect(expired.attempts[0]).toMatchObject({
        status: "interrupted",
        preparation: {
          status: "interrupted",
          error: "runtime lease expired during preparation",
        },
      });
      expect(store.listExpiredRuntimeLeases(expiryTime)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("persists retry admission and refuses an early attempt", () => {
    const store = SqliteSymphonyStateStore.openInMemory();
    try {
      const session = store.getOrCreateTrackerSession(trackerInput());
      const started = startAttempt(store, session.id);
      store.finishAttempt({
        sessionId: session.id,
        attemptId: started.attemptId,
        runtimeLeaseToken: started.runtimeLeaseToken,
        controllerGeneration: started.controllerGeneration,
        status: "failed",
        error: "provider unavailable",
        now: "2026-08-25T10:00:05.000Z",
      });
      expect(() =>
        store.scheduleRetry({
          sessionId: session.id,
          controllerGeneration: started.controllerGeneration + 1,
          retry: {
            kind: "failure",
            attempt: 1,
            dueAt: "2026-08-25T10:01:00.000Z",
            error: "provider unavailable",
            freshAttemptGeneration: null,
            recordedAt: "2026-08-25T10:00:05.000Z",
          },
        }),
      ).toThrowError(expect.objectContaining({ code: "stale_fence" }));
      store.scheduleRetry({
        sessionId: session.id,
        controllerGeneration: started.controllerGeneration,
        retry: {
          kind: "failure",
          attempt: 1,
          dueAt: "2026-08-25T10:01:00.000Z",
          error: "provider unavailable",
          freshAttemptGeneration: null,
          recordedAt: "2026-08-25T10:00:05.000Z",
        },
      });

      expect(() =>
        startAttempt(store, session.id, {
          now: "2026-08-25T10:00:30.000Z",
          leaseExpiresAt: "2026-08-25T10:02:30.000Z",
        }),
      ).toThrowError(expect.objectContaining({ code: "retry_not_due" }));
      const retried = startAttempt(store, session.id, {
        now: "2026-08-25T10:01:00.000Z",
        leaseExpiresAt: "2026-08-25T10:03:00.000Z",
      });
      expect(retried.session.retry).toBeNull();
      expect(retried.session.attempts).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it("durably fences materialization, proof, and owner-gated delivery", () => {
    const store = SqliteSymphonyStateStore.openInMemory();
    try {
      const session = store.getOrCreateTrackerSession({
        ...trackerInput(),
        configuration: acceptedDeliveryConfiguration(),
      });
      const started = startAttempt(store, session.id);
      const workspace = store.beginManagedWorkspace({
        sessionId: session.id,
        attemptId: started.attemptId,
        runtimeLeaseToken: started.runtimeLeaseToken,
        controllerGeneration: started.controllerGeneration,
        path: "/workspaces/SYM-delivery",
        workspaceKey: "SYM-delivery",
        repositoryIdentity: "reinispilens/symphony",
        profileDigest: acceptedDeliveryConfiguration().productProfile.digest,
        sourceRoot: "/repositories/symphony",
        workspaceRoot: "/workspaces",
        baseRef: "refs/heads/main",
        baseSha: "a".repeat(40),
        branch: "symphony/SYM-delivery",
        freshAttemptGeneration: null,
        now: "2026-08-25T10:00:01.000Z",
      });
      store.transitionManagedWorkspace({
        sessionId: session.id,
        attemptId: started.attemptId,
        workspaceLeaseToken: workspace.workspaceLeaseToken,
        controllerGeneration: started.controllerGeneration,
        runtimeLeaseToken: started.runtimeLeaseToken,
        expectedPhases: ["allocating"],
        phase: "provisioned",
        error: null,
        now: "2026-08-25T10:00:02.000Z",
      });
      store.transitionManagedWorkspace({
        sessionId: session.id,
        attemptId: started.attemptId,
        workspaceLeaseToken: workspace.workspaceLeaseToken,
        controllerGeneration: started.controllerGeneration,
        runtimeLeaseToken: started.runtimeLeaseToken,
        expectedPhases: ["provisioned"],
        phase: "ready",
        error: null,
        now: "2026-08-25T10:00:03.000Z",
      });

      expect(() =>
        store.beginMaterialization({
          sessionId: session.id,
          attemptId: started.attemptId,
          workspaceLeaseToken: workspace.workspaceLeaseToken,
          controllerGeneration: started.controllerGeneration,
          parentSha: "a".repeat(40),
          branch: "symphony/SYM-delivery",
          expectedOldSha: "a".repeat(40),
          inclusionPolicyDigest: "sha256:materialization-v1",
          now: "2026-08-25T10:00:03.500Z",
        }),
      ).toThrowError(expect.objectContaining({ code: "active_runtime_lease" }));

      store.finishAttempt({
        sessionId: session.id,
        attemptId: started.attemptId,
        runtimeLeaseToken: started.runtimeLeaseToken,
        controllerGeneration: started.controllerGeneration,
        status: "completed",
        error: null,
        now: "2026-08-25T10:00:04.000Z",
      });
      const begun = store.beginMaterialization({
        sessionId: session.id,
        attemptId: started.attemptId,
        workspaceLeaseToken: workspace.workspaceLeaseToken,
        controllerGeneration: started.controllerGeneration,
        parentSha: "a".repeat(40),
        branch: "symphony/SYM-delivery",
        expectedOldSha: "a".repeat(40),
        inclusionPolicyDigest: "sha256:materialization-v1",
        now: "2026-08-25T10:00:05.000Z",
      });
      expect(
        store.beginMaterialization({
          sessionId: session.id,
          attemptId: started.attemptId,
          workspaceLeaseToken: workspace.workspaceLeaseToken,
          controllerGeneration: started.controllerGeneration,
          parentSha: "a".repeat(40),
          branch: "symphony/SYM-delivery",
          expectedOldSha: "a".repeat(40),
          inclusionPolicyDigest: "sha256:materialization-v1",
          now: "2026-08-25T10:00:06.000Z",
        }).materializationId,
      ).toBe(begun.materializationId);
      store.transitionMaterialization({
        sessionId: session.id,
        materializationId: begun.materializationId,
        controllerGeneration: started.controllerGeneration,
        expectedPhases: ["intent_recorded"],
        phase: "snapshot_recorded",
        inputManifestDigest: "sha256:manifest",
        inputManifest: [],
        now: "2026-08-25T10:00:06.000Z",
      });
      store.transitionMaterialization({
        sessionId: session.id,
        materializationId: begun.materializationId,
        controllerGeneration: started.controllerGeneration,
        expectedPhases: ["snapshot_recorded"],
        phase: "tree_written",
        treeSha: "c".repeat(40),
        now: "2026-08-25T10:00:07.000Z",
      });
      store.transitionMaterialization({
        sessionId: session.id,
        materializationId: begun.materializationId,
        controllerGeneration: started.controllerGeneration,
        expectedPhases: ["tree_written"],
        phase: "commit_written",
        commitSha: "d".repeat(40),
        now: "2026-08-25T10:00:08.000Z",
      });
      store.transitionMaterialization({
        sessionId: session.id,
        materializationId: begun.materializationId,
        controllerGeneration: started.controllerGeneration,
        expectedPhases: ["commit_written"],
        phase: "branch_updated",
        now: "2026-08-25T10:00:09.000Z",
      });

      store.beginDelivery({
        sessionId: session.id,
        materializationId: begun.materializationId,
        controllerGeneration: started.controllerGeneration,
        expectedRemoteHeadSha: null,
        now: "2026-08-25T10:00:10.000Z",
      });
      store.transitionDelivery({
        sessionId: session.id,
        controllerGeneration: started.controllerGeneration,
        expectedPhases: ["intent_recorded"],
        phase: "push_pending",
        now: "2026-08-25T10:00:11.000Z",
      });
      store.transitionDelivery({
        sessionId: session.id,
        controllerGeneration: started.controllerGeneration,
        expectedPhases: ["push_pending"],
        phase: "pushed",
        remoteHeadSha: "d".repeat(40),
        now: "2026-08-25T10:00:12.000Z",
      });
      store.transitionDelivery({
        sessionId: session.id,
        controllerGeneration: started.controllerGeneration,
        expectedPhases: ["pushed"],
        phase: "pull_request_pending",
        now: "2026-08-25T10:00:13.000Z",
      });
      store.transitionDelivery({
        sessionId: session.id,
        controllerGeneration: started.controllerGeneration,
        expectedPhases: ["pull_request_pending"],
        phase: "pull_request_open",
        pullRequest: "https://github.com/reinispilens/symphony/pull/42",
        now: "2026-08-25T10:00:14.000Z",
      });
      store.transitionDelivery({
        sessionId: session.id,
        controllerGeneration: started.controllerGeneration,
        expectedPhases: ["pull_request_open"],
        phase: "checks_pending",
        now: "2026-08-25T10:00:15.000Z",
      });
      const pendingProof = {
        id: "proof-42",
        checkName: "proof / Protected final",
        checkRunId: "4200",
        workflowRunId: "420",
        sourceSha: "d".repeat(40),
        planDigest: "sha256:plan",
        adapterDigest: "sha256:adapter",
        policyDigest: "sha256:proof-policy",
        resultDigest: null,
        evidenceDigest: null,
        status: "pending" as const,
        recordedAt: "2026-08-25T10:00:16.000Z",
        observedAt: null,
      };
      store.recordProof({
        sessionId: session.id,
        controllerGeneration: started.controllerGeneration,
        proof: pendingProof,
        now: pendingProof.recordedAt,
      });
      store.recordProof({
        sessionId: session.id,
        controllerGeneration: started.controllerGeneration,
        proof: {
          ...pendingProof,
          status: "passed",
          resultDigest: "sha256:result",
          evidenceDigest: "sha256:evidence",
          observedAt: "2026-08-25T10:00:17.000Z",
        },
        now: "2026-08-25T10:00:17.000Z",
      });
      const passedChecks = [
        {
          name: "proof / Protected final",
          headSha: "d".repeat(40),
          checkRunId: "4200",
          workflowRunId: "420",
          status: "passed" as const,
          observedAt: "2026-08-25T10:00:17.000Z",
        },
      ];
      store.transitionDelivery({
        sessionId: session.id,
        controllerGeneration: started.controllerGeneration,
        expectedPhases: ["checks_pending"],
        phase: "review_pending",
        requiredChecks: passedChecks,
        now: "2026-08-25T10:00:18.000Z",
      });
      expect(() =>
        store.transitionDelivery({
          sessionId: session.id,
          controllerGeneration: started.controllerGeneration,
          expectedPhases: ["review_pending"],
          phase: "merge_pending",
          now: "2026-08-25T10:00:19.000Z",
        }),
      ).toThrowError(expect.objectContaining({ code: "controller_conflict" }));
      store.transitionDelivery({
        sessionId: session.id,
        controllerGeneration: started.controllerGeneration,
        expectedPhases: ["review_pending"],
        phase: "merged",
        mergeSha: "e".repeat(40),
        now: "2026-08-25T10:00:20.000Z",
      });
      store.transitionDelivery({
        sessionId: session.id,
        controllerGeneration: started.controllerGeneration,
        expectedPhases: ["merged"],
        phase: "cleanup_pending",
        cleanupStatus: "pending",
        releaseIntentId: "effect-release-42",
        now: "2026-08-25T10:00:21.000Z",
      });
      const completed = store.transitionDelivery({
        sessionId: session.id,
        controllerGeneration: started.controllerGeneration,
        expectedPhases: ["cleanup_pending"],
        phase: "completed",
        cleanupStatus: "completed",
        now: "2026-08-25T10:00:22.000Z",
      });
      expect(completed).toMatchObject({
        delivery: {
          phase: "completed",
          immutableHeadSha: "d".repeat(40),
          mergeSha: "e".repeat(40),
          cleanupStatus: "completed",
        },
        proof: [{ id: "proof-42", status: "passed" }],
      });

      store.transitionManagedWorkspace({
        sessionId: session.id,
        attemptId: started.attemptId,
        workspaceLeaseToken: workspace.workspaceLeaseToken,
        controllerGeneration: started.controllerGeneration,
        runtimeLeaseToken: null,
        expectedPhases: ["ready"],
        phase: "removal_pending",
        error: null,
        now: "2026-08-25T10:00:23.000Z",
      });
      store.transitionManagedWorkspace({
        sessionId: session.id,
        attemptId: started.attemptId,
        workspaceLeaseToken: workspace.workspaceLeaseToken,
        controllerGeneration: started.controllerGeneration,
        runtimeLeaseToken: null,
        expectedPhases: ["removal_pending"],
        phase: "removed",
        error: null,
        now: "2026-08-25T10:00:24.000Z",
      });
      const rework = startAttempt(store, session.id, {
        freshAttemptGeneration: "rework-2",
        now: "2026-08-25T10:00:25.000Z",
        leaseExpiresAt: "2026-08-25T10:02:25.000Z",
      });
      const reworkWorkspace = store.beginManagedWorkspace({
        sessionId: session.id,
        attemptId: rework.attemptId,
        runtimeLeaseToken: rework.runtimeLeaseToken,
        controllerGeneration: rework.controllerGeneration,
        path: "/workspaces/SYM-delivery",
        workspaceKey: "SYM-delivery",
        repositoryIdentity: "reinispilens/symphony",
        profileDigest: acceptedDeliveryConfiguration().productProfile.digest,
        sourceRoot: "/repositories/symphony",
        workspaceRoot: "/workspaces",
        baseRef: "refs/heads/main",
        baseSha: "a".repeat(40),
        branch: "symphony/SYM-delivery-rework",
        freshAttemptGeneration: "rework-2",
        now: "2026-08-25T10:00:26.000Z",
      });
      store.transitionManagedWorkspace({
        sessionId: session.id,
        attemptId: rework.attemptId,
        workspaceLeaseToken: reworkWorkspace.workspaceLeaseToken,
        controllerGeneration: rework.controllerGeneration,
        runtimeLeaseToken: rework.runtimeLeaseToken,
        expectedPhases: ["allocating"],
        phase: "provisioned",
        error: null,
        now: "2026-08-25T10:00:27.000Z",
      });
      store.transitionManagedWorkspace({
        sessionId: session.id,
        attemptId: rework.attemptId,
        workspaceLeaseToken: reworkWorkspace.workspaceLeaseToken,
        controllerGeneration: rework.controllerGeneration,
        runtimeLeaseToken: rework.runtimeLeaseToken,
        expectedPhases: ["provisioned"],
        phase: "ready",
        error: null,
        now: "2026-08-25T10:00:28.000Z",
      });
      store.finishAttempt({
        sessionId: session.id,
        attemptId: rework.attemptId,
        runtimeLeaseToken: rework.runtimeLeaseToken,
        controllerGeneration: rework.controllerGeneration,
        status: "completed",
        error: null,
        now: "2026-08-25T10:00:29.000Z",
      });
      const secondMaterialization = store.beginMaterialization({
        sessionId: session.id,
        attemptId: rework.attemptId,
        workspaceLeaseToken: reworkWorkspace.workspaceLeaseToken,
        controllerGeneration: rework.controllerGeneration,
        parentSha: "a".repeat(40),
        branch: "symphony/SYM-delivery-rework",
        expectedOldSha: "a".repeat(40),
        inclusionPolicyDigest: "sha256:materialization-v1",
        now: "2026-08-25T10:00:30.000Z",
      });
      store.transitionMaterialization({
        sessionId: session.id,
        materializationId: secondMaterialization.materializationId,
        controllerGeneration: rework.controllerGeneration,
        expectedPhases: ["intent_recorded"],
        phase: "snapshot_recorded",
        inputManifestDigest: "sha256:manifest-2",
        inputManifest: [],
        now: "2026-08-25T10:00:31.000Z",
      });
      store.transitionMaterialization({
        sessionId: session.id,
        materializationId: secondMaterialization.materializationId,
        controllerGeneration: rework.controllerGeneration,
        expectedPhases: ["snapshot_recorded"],
        phase: "tree_written",
        treeSha: "f".repeat(40),
        now: "2026-08-25T10:00:32.000Z",
      });
      store.transitionMaterialization({
        sessionId: session.id,
        materializationId: secondMaterialization.materializationId,
        controllerGeneration: rework.controllerGeneration,
        expectedPhases: ["tree_written"],
        phase: "commit_written",
        commitSha: "1".repeat(40),
        now: "2026-08-25T10:00:33.000Z",
      });
      store.transitionMaterialization({
        sessionId: session.id,
        materializationId: secondMaterialization.materializationId,
        controllerGeneration: rework.controllerGeneration,
        expectedPhases: ["commit_written"],
        phase: "branch_updated",
        now: "2026-08-25T10:00:34.000Z",
      });
      const redelivering = store.beginDelivery({
        sessionId: session.id,
        materializationId: secondMaterialization.materializationId,
        controllerGeneration: rework.controllerGeneration,
        expectedRemoteHeadSha: null,
        now: "2026-08-25T10:00:35.000Z",
      });
      expect(redelivering.deliveryHistory).toHaveLength(1);
      expect(redelivering.deliveryHistory[0]).toEqual(completed.delivery);
      expect(redelivering.delivery).toMatchObject({
        phase: "intent_recorded",
        materializationId: secondMaterialization.materializationId,
        immutableHeadSha: "1".repeat(40),
      });
    } finally {
      store.close();
    }
  });

  it("makes effect intents idempotent and preserves terminal observations", () => {
    const store = SqliteSymphonyStateStore.openInMemory();
    try {
      const session = store.getOrCreateTrackerSession(trackerInput());
      const effect = store.enqueueEffect({
        sessionId: session.id,
        controllerGeneration: session.controller.generation,
        kind: "github.create_pull_request",
        idempotencyKey: "session-1:pr",
        payload: { head: "abc123" },
        now: START,
      });
      expect(
        store.enqueueEffect({
          sessionId: session.id,
          controllerGeneration: session.controller.generation,
          kind: "github.create_pull_request",
          idempotencyKey: "session-1:pr",
          payload: { head: "abc123" },
          now: START,
        }).id,
      ).toBe(effect.id);
      expect(store.listPendingEffects()).toHaveLength(1);

      expect(() =>
        store.finishEffect({
          effectId: effect.id,
          controllerGeneration: session.controller.generation + 1,
          status: "applied",
          result: { pull_request: 42 },
          now: "2026-08-25T10:00:01.000Z",
        }),
      ).toThrowError(expect.objectContaining({ code: "stale_fence" }));

      const applied = store.finishEffect({
        effectId: effect.id,
        controllerGeneration: session.controller.generation,
        status: "applied",
        result: { pull_request: 42 },
        now: "2026-08-25T10:00:01.000Z",
      });
      expect(applied).toMatchObject({
        status: "applied",
        result: { pull_request: 42 },
      });
      expect(store.listPendingEffects()).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("recovers a pending effect after restart without allocating a second intent", async () => {
    await withTempDirectory(async (directory) => {
      const databasePath = path.join(directory, "state.sqlite");
      const first = SqliteSymphonyStateStore.open(databasePath);
      const session = first.getOrCreateTrackerSession(trackerInput());
      const pending = first.enqueueEffect({
        sessionId: session.id,
        controllerGeneration: session.controller.generation,
        kind: "git.create_worktree",
        idempotencyKey: `${session.id}:workspace:1`,
        payload: { branch: "symphony/SYM-1" },
        now: START,
      });
      first.close();

      const recovered = SqliteSymphonyStateStore.open(databasePath);
      try {
        expect(recovered.listPendingEffects()).toEqual([pending]);
        expect(
          recovered.enqueueEffect({
            sessionId: session.id,
            controllerGeneration: session.controller.generation,
            kind: "git.create_worktree",
            idempotencyKey: `${session.id}:workspace:1`,
            payload: { branch: "symphony/SYM-1" },
            now: "2026-08-25T10:00:01.000Z",
          }).id,
        ).toBe(pending.id);
      } finally {
        recovered.close();
      }
    });
  });

  it("refuses impossible aggregate state and immediately expired leases", async () => {
    const inMemory = SqliteSymphonyStateStore.openInMemory();
    try {
      const session = inMemory.getOrCreateTrackerSession(trackerInput());
      expect(() =>
        startAttempt(inMemory, session.id, {
          leaseExpiresAt: START,
        }),
      ).toThrowError("leaseExpiresAt must be after now");
    } finally {
      inMemory.close();
    }

    await withTempDirectory(async (directory) => {
      const databasePath = path.join(directory, "state.sqlite");
      const store = SqliteSymphonyStateStore.open(databasePath);
      const session = store.getOrCreateTrackerSession(trackerInput());
      startAttempt(store, session.id);
      store.close();

      const projectionRaw = new Database(databasePath);
      projectionRaw
        .prepare("UPDATE work_sessions SET status = 'completed' WHERE id = ?")
        .run(session.id);
      projectionRaw.close();

      expect(() => SqliteSymphonyStateStore.open(databasePath)).toThrowError(
        expect.objectContaining({ code: "state_corrupt" }),
      );

      const raw = new Database(databasePath);
      raw
        .prepare("UPDATE work_sessions SET status = 'active' WHERE id = ?")
        .run(session.id);
      const row = raw
        .prepare("SELECT document_json FROM work_sessions WHERE id = ?")
        .get(session.id) as { document_json: string };
      const document = JSON.parse(row.document_json) as {
        attempts: Array<Record<string, unknown>>;
        retry: unknown;
      };
      document.retry = {
        kind: "failure",
        attempt: 1,
        dueAt: "2026-08-25T10:01:00.000Z",
        error: "impossible while running",
        freshAttemptGeneration: null,
        recordedAt: "2026-08-25T10:00:01.000Z",
      };
      raw
        .prepare("UPDATE work_sessions SET document_json = ? WHERE id = ?")
        .run(JSON.stringify(document), session.id);
      raw.close();

      expect(() => SqliteSymphonyStateStore.open(databasePath)).toThrowError(
        expect.objectContaining({ code: "state_corrupt" }),
      );
    });
  });

  it("migrates a stopped v1 attached lease into a session-level human attachment", async () => {
    await withTempDirectory(async (directory) => {
      const databasePath = path.join(directory, "state.sqlite");
      const first = SqliteSymphonyStateStore.open(databasePath);
      const session = first.getOrCreateTrackerSession(trackerInput());
      const started = startAttempt(first, session.id);
      const finished = first.finishAttempt({
        sessionId: session.id,
        attemptId: started.attemptId,
        runtimeLeaseToken: started.runtimeLeaseToken,
        controllerGeneration: started.controllerGeneration,
        status: "completed",
        error: null,
        now: "2026-08-25T10:00:02.000Z",
      });
      first.close();

      downgradeToV1Attached(
        databasePath,
        session.id,
        "/worktrees/legacy-human",
      );

      const migrated = SqliteSymphonyStateStore.open(databasePath);
      try {
        const recovered = migrated.getSession(session.id);
        expect(recovered).toMatchObject({
          schemaVersion: 2,
          revision: finished.revision,
          configuration: null,
          humanAttachment: {
            kind: "human-attachment",
            ownership: "human",
            path: "/worktrees/legacy-human",
            inspection: { status: "unknown" },
            removalPolicy: "never",
          },
        });
        expect(recovered?.attempts[0]?.workspaceLease).toBeNull();
      } finally {
        migrated.close();
      }

      const raw = new Database(databasePath, { readonly: true });
      expect(raw.pragma("user_version", { simple: true })).toBe(2);
      raw.close();
    });
  });

  it("rolls back v1 migration rather than reclassifying an active attached Attempt", async () => {
    await withTempDirectory(async (directory) => {
      const databasePath = path.join(directory, "state.sqlite");
      const first = SqliteSymphonyStateStore.open(databasePath);
      const session = first.getOrCreateTrackerSession(trackerInput());
      startAttempt(first, session.id);
      first.close();
      downgradeToV1Attached(
        databasePath,
        session.id,
        "/worktrees/unsafe-active-human",
      );

      expect(() => SqliteSymphonyStateStore.open(databasePath)).toThrowError(
        expect.objectContaining({ code: "state_corrupt" }),
      );

      const raw = new Database(databasePath, { readonly: true });
      try {
        expect(raw.pragma("user_version", { simple: true })).toBe(1);
        const row = raw
          .prepare("SELECT document_json FROM work_sessions WHERE id = ?")
          .get(session.id) as { document_json: string };
        expect(
          (JSON.parse(row.document_json) as Record<string, unknown>)[
            "schemaVersion"
          ],
        ).toBe(1);
      } finally {
        raw.close();
      }
    });
  });

  it("backs up a source-consistent database and refuses unknown document schemas", async () => {
    await withTempDirectory(async (directory) => {
      const databasePath = path.join(directory, "state.sqlite");
      const backupPath = path.join(directory, "backups", "state.sqlite");
      const store = SqliteSymphonyStateStore.open(databasePath);
      const session = store.getOrCreateTrackerSession(trackerInput());
      await store.backup(backupPath);
      store.close();

      const backup = SqliteSymphonyStateStore.open(backupPath);
      expect(backup.getSession(session.id)?.id).toBe(session.id);
      backup.close();

      const raw = new Database(databasePath);
      const row = raw
        .prepare("SELECT document_json FROM work_sessions WHERE id = ?")
        .get(session.id) as { document_json: string };
      const document = JSON.parse(row.document_json) as Record<string, unknown>;
      document["schemaVersion"] = 999;
      raw
        .prepare("UPDATE work_sessions SET document_json = ? WHERE id = ?")
        .run(JSON.stringify(document), session.id);
      raw.close();

      expect(() => SqliteSymphonyStateStore.open(databasePath)).toThrowError(
        expect.objectContaining({ code: "state_corrupt" }),
      );
    });
  });
});
