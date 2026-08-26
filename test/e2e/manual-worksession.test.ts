import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  acceptedGovernanceFixture,
  withTempDirectory,
} from "../support/factories.js";

interface ProcessResult {
  readonly stderr: string;
  readonly stdout: string;
}

interface ManualFixture {
  readonly bindingPath: string;
  readonly productRoot: string;
  readonly stateDatabasePath: string;
}

function processResult(
  executable: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly environment?: NodeJS.ProcessEnv },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      {
        cwd: options.cwd,
        encoding: "utf8",
        env: options.environment ?? process.env,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(
            new Error(
              `${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

async function command(
  executable: string,
  args: readonly string[],
  cwd: string,
): Promise<string> {
  return (await processResult(executable, args, { cwd })).stdout.trim();
}

function digest(bytes: string | Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function executable(filePath: string): Promise<void> {
  await writeFile(filePath, "#!/bin/sh\nexit 0\n");
  await chmod(filePath, 0o755);
}

async function createManualFixture(directory: string): Promise<ManualFixture> {
  const productRoot = path.join(directory, "product");
  const governanceRoot = path.join(directory, "governance");
  const operatorRoot = path.join(directory, "operator");
  const stateRoot = path.join(directory, "state");
  const workspaceRoot = path.join(directory, "managed-workspaces");
  const binRoot = path.join(directory, "trusted-bin");
  await Promise.all([
    mkdir(path.join(productRoot, ".symphony"), { recursive: true }),
    mkdir(path.join(governanceRoot, "agent-system"), { recursive: true }),
    mkdir(operatorRoot),
    mkdir(binRoot),
  ]);

  await command("git", ["init", "--initial-branch=main"], productRoot);
  await command("git", ["config", "user.name", "Symphony Test"], productRoot);
  await command(
    "git",
    ["config", "user.email", "symphony@example.test"],
    productRoot,
  );
  await command(
    "git",
    ["remote", "add", "origin", "https://github.com/acme/widgets.git"],
    productRoot,
  );
  const profilePath = ".symphony/repository-profile.json";
  const profile = {
    schemaVersion: 1,
    repositoryIdentity: "acme/widgets",
    baseRef: "refs/heads/main",
    authoringContext: {
      promptPath: ".symphony/prompt.md",
      paths: ["AGENTS.md"],
    },
    preparationClass: "none",
  } as const;
  const profileBytes = `${JSON.stringify(profile, null, 2)}\n`;
  await Promise.all([
    writeFile(path.join(productRoot, profilePath), profileBytes),
    writeFile(
      path.join(productRoot, ".symphony", "prompt.md"),
      "Use accepted product context only.\n",
    ),
    writeFile(path.join(productRoot, "AGENTS.md"), "# Product context\n"),
  ]);
  await command("git", ["add", "."], productRoot);
  await command(
    "git",
    ["commit", "-m", "accepted product context"],
    productRoot,
  );
  const productRevision = await command(
    "git",
    ["rev-parse", "HEAD"],
    productRoot,
  );

  await command("git", ["init", "--initial-branch=main"], governanceRoot);
  await command(
    "git",
    ["config", "user.name", "Symphony Test"],
    governanceRoot,
  );
  await command(
    "git",
    ["config", "user.email", "symphony@example.test"],
    governanceRoot,
  );
  await command(
    "git",
    ["remote", "add", "origin", "https://github.com/reinispilens/.github.git"],
    governanceRoot,
  );
  const doctrinePath = "agent-system/golden-principles.md";
  const policyPath = "agent-system/tracker-policy.json";
  const manifestPath = "agent-system/accepted-governance.json";
  const doctrineBytes =
    "# Accepted test doctrine\n\nExplicit local human initiation is valid.\n";
  const policySnapshot = acceptedGovernanceFixture().trackerPolicy;
  const policy = Object.fromEntries(
    Object.entries(policySnapshot).filter(([key]) => key !== "source"),
  );
  const policyBytes = `${JSON.stringify(policy, null, 2)}\n`;
  await Promise.all([
    writeFile(path.join(governanceRoot, doctrinePath), doctrineBytes),
    writeFile(path.join(governanceRoot, policyPath), policyBytes),
  ]);
  await command("git", ["add", "."], governanceRoot);
  await command(
    "git",
    ["commit", "-m", "accepted governance artifacts"],
    governanceRoot,
  );
  const acceptedRevision = await command(
    "git",
    ["rev-parse", "HEAD"],
    governanceRoot,
  );
  const manifest = {
    schemaVersion: 1,
    repositoryIdentity: "reinispilens/.github",
    acceptedRevision,
    artifacts: {
      doctrine: { path: doctrinePath, digest: digest(doctrineBytes) },
      trackerPolicy: { path: policyPath, digest: digest(policyBytes) },
    },
  } as const;
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path.join(governanceRoot, manifestPath), manifestBytes);
  await command("git", ["add", manifestPath], governanceRoot);
  await command(
    "git",
    ["commit", "-m", "publish accepted governance"],
    governanceRoot,
  );
  const manifestRevision = await command(
    "git",
    ["rev-parse", "HEAD"],
    governanceRoot,
  );

  const codexExecutable = path.join(binRoot, "codex");
  const systemdRunExecutable = path.join(binRoot, "systemd-run");
  const systemctlExecutable = path.join(binRoot, "systemctl");
  await Promise.all([
    executable(codexExecutable),
    executable(systemdRunExecutable),
    executable(systemctlExecutable),
  ]);
  const gitExecutable = await realpath(
    await command("which", ["git"], directory),
  );
  const binding = {
    schemaVersion: 3,
    id: "manual-e2e",
    productProfile: {
      repositoryIdentity: "acme/widgets",
      sourceRoot: productRoot,
      path: profilePath,
      revision: productRevision,
      digest: digest(profileBytes),
    },
    governance: {
      repositoryIdentity: "reinispilens/.github",
      sourceRoot: governanceRoot,
      manifest: {
        path: manifestPath,
        revision: manifestRevision,
        digest: digest(manifestBytes),
      },
    },
    stateRoot,
    workspaceRoot,
    branchPrefix: "symphony/",
    gitExecutable,
    tracker: {
      kind: "github-projects",
      provider: {
        hostname: "github.com",
        owner: "acme",
        repo: "widgets",
        project: 1,
      },
    },
    polling: { intervalMs: 30_000 },
    preparation: null,
    agent: {
      maxConcurrentAgents: 1,
      maxTurns: 10,
      maxRetryBackoffMs: 300_000,
      maxConcurrentAgentsByState: {},
    },
    runtime: {
      codexExecutable,
      turnTimeoutMs: 3_600_000,
      readTimeoutMs: 5_000,
      stallTimeoutMs: 300_000,
      containment: {
        provider: "systemd-user-scope",
        shutdownTimeoutMs: 2_000,
        systemdRunExecutable,
        systemctlExecutable,
      },
    },
    deliveryProvider: null,
  } as const;
  const bindingPath = path.join(operatorRoot, "manual.json");
  await writeFile(bindingPath, `${JSON.stringify(binding, null, 2)}\n`);
  return {
    bindingPath,
    productRoot,
    stateDatabasePath: path.join(stateRoot, "state.sqlite"),
  };
}

describe("manual WorkSession process journey", () => {
  it("continues one boardless session across five fresh CLI processes", async () => {
    await withTempDirectory(async (directory) => {
      const fixture = await createManualFixture(directory);
      const repositoryRoot = path.resolve(import.meta.dirname, "../..");
      const cliPath = path.join(repositoryRoot, "src", "cli.ts");
      const environment: NodeJS.ProcessEnv = {
        PATH: process.env["PATH"],
        LANG: "C",
        LC_ALL: "C",
        MANUAL_SECRET_DO_NOT_RECORD: "super-secret-value",
      };
      const run = async (args: readonly string[]) => {
        const result = await processResult(
          process.execPath,
          ["--import", "tsx", cliPath, ...args],
          { cwd: repositoryRoot, environment },
        );
        expect(result.stderr).toBe("");
        return result.stdout;
      };

      const started = await run([
        "work",
        "start",
        "--binding",
        fixture.bindingPath,
        "--intent",
        "Finish the manual restart journey",
      ]);
      const sessionId = started.match(
        /^WorkSession ([0-9a-f-]+) started\./u,
      )?.[1];
      expect(sessionId).toBeDefined();
      expect(started).toContain("Revision: 1");

      await writeFile(path.join(fixture.productRoot, "manual.tmp"), "dirty\n");
      const beforeAttach = await command(
        "git",
        ["status", "--porcelain"],
        fixture.productRoot,
      );
      const attached = await run([
        "work",
        "attach",
        "--binding",
        fixture.bindingPath,
        "--session",
        sessionId!,
        "--expected-revision",
        "1",
        "--path",
        fixture.productRoot,
      ]);
      expect(attached).toContain("Revision: 2");
      expect(
        await command("git", ["status", "--porcelain"], fixture.productRoot),
      ).toBe(beforeAttach);

      const planPath = path.join(directory, "manual-plan.md");
      await writeFile(
        planPath,
        "## Plan\nPersist control without a board.\n\n## Acceptance criteria\n- Reopen the same session\n- Never adopt the checkout\n",
      );
      expect(
        await run([
          "work",
          "plan",
          "--binding",
          fixture.bindingPath,
          "--session",
          sessionId!,
          "--expected-revision",
          "2",
          "--file",
          planPath,
        ]),
      ).toContain("Revision: 3");
      expect(
        await run([
          "work",
          "steer",
          "--binding",
          fixture.bindingPath,
          "--session",
          sessionId!,
          "--expected-revision",
          "3",
          "--message",
          "Keep the product repository thin",
        ]),
      ).toContain("Revision: 4");

      const json = await run([
        "work",
        "status",
        "--binding",
        fixture.bindingPath,
        "--session",
        sessionId!,
        "--json",
      ]);
      expect(JSON.parse(json)).toMatchObject({
        schemaVersion: 1,
        session: {
          id: sessionId,
          revision: 4,
          origin: { kind: "interactive" },
        },
        plan: {
          version: 1,
          summary: "Persist control without a board.",
        },
        humanAttachment: {
          ownership: "human",
          removalPolicy: "never",
        },
        runtime: { attemptCount: 0, activeAttempt: null },
        evidence: { posture: "advisory" },
        decisions: {
          count: 1,
          recent: [{ text: "Keep the product repository thin" }],
        },
      });
      expect(json).not.toContain("super-secret-value");
      expect(json).not.toContain("runtimeLeaseToken");

      const database = new Database(fixture.stateDatabasePath, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        const rows = database
          .prepare("SELECT document_json FROM work_sessions")
          .all() as Array<{ document_json: string }>;
        expect(rows).toHaveLength(1);
        expect(rows[0]!.document_json).not.toContain("super-secret-value");
        expect(JSON.parse(rows[0]!.document_json)).toMatchObject({
          attempts: [],
          humanAttachment: {
            ownership: "human",
            removalPolicy: "never",
          },
        });
        expect(
          database
            .prepare("SELECT COUNT(*) AS count FROM effect_intents")
            .get(),
        ).toEqual({ count: 0 });
      } finally {
        database.close();
      }
    });
  }, 30_000);
});
