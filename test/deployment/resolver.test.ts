import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { DeploymentBindingDocument } from "../../src/deployment/model.js";
import { resolveDeploymentBinding } from "../../src/deployment/resolver.js";
import {
  acceptedGovernanceFixture,
  testTrackerProfiles,
  withTempDirectory,
} from "../support/factories.js";

function command(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(String(stderr) || error.message));
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}

function digest(bytes: string | Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

interface Fixture {
  readonly binding: Extract<
    DeploymentBindingDocument,
    { readonly schemaVersion: 1 }
  >;
  readonly bindingPath: string;
  readonly profilePath: string;
  readonly sourceRoot: string;
}

async function fixture(directory: string): Promise<Fixture> {
  const sourceRoot = path.join(directory, "product");
  const operatorRoot = path.join(directory, "operator");
  const stateRoot = path.join(directory, "state");
  const workspaceRoot = path.join(directory, "workspaces");
  const binRoot = path.join(directory, "trusted-bin");
  const seedStoreRoot = path.join(directory, "dependency-store");
  await Promise.all([
    mkdir(path.join(sourceRoot, ".symphony"), { recursive: true }),
    mkdir(operatorRoot),
    mkdir(binRoot),
    mkdir(seedStoreRoot),
  ]);
  await command("git", ["init", "-b", "main", sourceRoot]);
  await command("git", ["-C", sourceRoot, "config", "user.name", "Test"]);
  await command("git", [
    "-C",
    sourceRoot,
    "config",
    "user.email",
    "test@example.test",
  ]);
  await command("git", [
    "-C",
    sourceRoot,
    "remote",
    "add",
    "origin",
    "https://github.com/acme/widgets.git",
  ]);

  const profilePath = ".symphony/repository-profile.json";
  const profile = {
    schemaVersion: 1,
    repositoryIdentity: "acme/widgets",
    baseRef: "refs/heads/main",
    authoringContext: {
      promptPath: ".symphony/prompt.md",
      paths: ["AGENTS.md"],
    },
    preparationClass: "pnpm",
  };
  const profileBytes = `${JSON.stringify(profile, null, 2)}\n`;
  await Promise.all([
    writeFile(path.join(sourceRoot, profilePath), profileBytes),
    writeFile(
      path.join(sourceRoot, ".symphony", "prompt.md"),
      "Work only from accepted product context.\n",
    ),
    writeFile(path.join(sourceRoot, "AGENTS.md"), "# Product instructions\n"),
  ]);
  await command("git", ["-C", sourceRoot, "add", "."]);
  await command("git", ["-C", sourceRoot, "commit", "-m", "product profile"]);
  const revision = await command("git", [
    "-C",
    sourceRoot,
    "rev-parse",
    "HEAD",
  ]);

  const codexExecutable = path.join(binRoot, "codex");
  const nodeExecutable = process.execPath;
  const pnpmEntryPoint = path.join(binRoot, "pnpm.mjs");
  const sandboxExecutable = path.join(binRoot, "bwrap");
  const systemdRunExecutable = path.join(binRoot, "systemd-run");
  const systemctlExecutable = path.join(binRoot, "systemctl");
  for (const executable of [
    codexExecutable,
    sandboxExecutable,
    systemdRunExecutable,
    systemctlExecutable,
  ]) {
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o755);
  }
  await writeFile(
    pnpmEntryPoint,
    [
      "#!/usr/bin/env node",
      "if (process.env.NODE_OPTIONS || process.env.HOME || process.env.PATH) {",
      '  process.stderr.write("ambient process authority reached the pnpm probe\\n");',
      "  process.exit(97);",
      "}",
      'process.stdout.write("11.3.0\\n");',
      "",
    ].join("\n"),
  );
  await chmod(pnpmEntryPoint, 0o755);
  const binding: Extract<
    DeploymentBindingDocument,
    { readonly schemaVersion: 1 }
  > = {
    schemaVersion: 1,
    id: "widgets-local",
    productProfile: {
      repositoryIdentity: "acme/widgets",
      sourceRoot,
      path: profilePath,
      revision,
      digest: digest(profileBytes),
    },
    stateRoot,
    workspaceRoot,
    branchPrefix: "symphony/",
    gitExecutable: await realpath(await command("which", ["git"])),
    tracker: {
      kind: "test",
      provider: {
        hostname: "github.com",
        owner: "acme",
        repo: "widgets",
      },
      requiredLabels: ["driver:symphony"],
      excludedLabels: ["driver:direct"],
      activeStates: ["Todo", "Rework"],
      terminalStates: ["Done"],
      freshAttemptStates: ["Rework"],
      freshAttemptFailureState: "Human Review",
    },
    polling: { intervalMs: 30_000 },
    preparation: {
      timeoutMs: 120_000,
      nodeExecutable,
      pnpmEntryPoint,
      sandboxExecutable,
      dependencyPolicy: {
        id: "public-npm-offline-v1",
        mode: "offline",
        registry: "https://registry.npmjs.org/",
        seedStoreRoot,
        pnpmVersion: "11.3.0",
      },
    },
    agent: {
      maxConcurrentAgents: 1,
      maxTurns: 20,
      maxRetryBackoffMs: 300_000,
      maxConcurrentAgentsByState: { Rework: 1 },
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
  };
  const bindingPath = path.join(operatorRoot, "widgets.json");
  await writeFile(bindingPath, `${JSON.stringify(binding, null, 2)}\n`);
  return { binding, bindingPath, profilePath, sourceRoot };
}

async function selectPreparationClass(
  setup: Fixture,
  preparationClass: "none" | "pnpm",
): Promise<DeploymentBindingDocument["productProfile"]> {
  const profileFile = path.join(setup.sourceRoot, setup.profilePath);
  const profile = JSON.parse(await readFile(profileFile, "utf8")) as Record<
    string,
    unknown
  >;
  profile["preparationClass"] = preparationClass;
  const profileBytes = `${JSON.stringify(profile, null, 2)}\n`;
  await writeFile(profileFile, profileBytes);
  await command("git", ["-C", setup.sourceRoot, "add", setup.profilePath]);
  await command("git", [
    "-C",
    setup.sourceRoot,
    "commit",
    "-m",
    `select ${preparationClass} preparation`,
  ]);
  return {
    ...setup.binding.productProfile,
    revision: await command("git", [
      "-C",
      setup.sourceRoot,
      "rev-parse",
      "HEAD",
    ]),
    digest: digest(profileBytes),
  };
}

async function selectDeliveryGrant(
  setup: Fixture,
  authority: "owner-gated" | "full-in-scope" = "owner-gated",
): Promise<DeploymentBindingDocument> {
  const profileFile = path.join(setup.sourceRoot, setup.profilePath);
  const profile = JSON.parse(await readFile(profileFile, "utf8")) as Record<
    string,
    unknown
  >;
  profile["schemaVersion"] = 2;
  profile["deliveryGrant"] = {
    authority,
    governingPolicy: {
      repositoryIdentity: "acme/.github",
      path: "agent-system/delivery-policy.json",
      revision: "2".repeat(40),
      digest: `sha256:${"3".repeat(64)}`,
    },
    requiredChecks: ["proof / Protected final"],
  };
  const profileBytes = `${JSON.stringify(profile, null, 2)}\n`;
  await writeFile(profileFile, profileBytes);
  await command("git", ["-C", setup.sourceRoot, "add", setup.profilePath]);
  await command("git", [
    "-C",
    setup.sourceRoot,
    "commit",
    "-m",
    "select delivery authority",
  ]);
  const providerExecutable = path.join(
    path.dirname(setup.binding.runtime.codexExecutable),
    "delivery-provider",
  );
  await writeFile(providerExecutable, "#!/bin/sh\nexit 0\n");
  await chmod(providerExecutable, 0o755);
  const binding: DeploymentBindingDocument = {
    ...setup.binding,
    schemaVersion: 2,
    productProfile: {
      ...setup.binding.productProfile,
      revision: await command("git", [
        "-C",
        setup.sourceRoot,
        "rev-parse",
        "HEAD",
      ]),
      digest: digest(profileBytes),
    },
    deliveryProvider: {
      protocolVersion: 1,
      executable: providerExecutable,
      timeoutMs: 30_000,
      secretEnvironmentNames: ["DELIVERY_TOKEN"],
    },
  };
  await writeFile(setup.bindingPath, `${JSON.stringify(binding, null, 2)}\n`);
  return binding;
}

interface V3Fixture {
  readonly binding: Extract<
    DeploymentBindingDocument,
    { readonly schemaVersion: 3 }
  >;
  readonly doctrine: {
    readonly revision: string;
    readonly digest: string;
  };
  readonly governanceRoot: string;
  readonly policy: {
    readonly path: string;
    readonly revision: string;
    readonly digest: string;
  };
}

async function selectAcceptedGovernance(setup: Fixture): Promise<V3Fixture> {
  const root = path.dirname(setup.sourceRoot);
  const governanceRoot = path.join(root, "governance");
  await mkdir(path.join(governanceRoot, "agent-system"), { recursive: true });
  await command("git", ["init", "-b", "main", governanceRoot]);
  await command("git", ["-C", governanceRoot, "config", "user.name", "Test"]);
  await command("git", [
    "-C",
    governanceRoot,
    "config",
    "user.email",
    "test@example.test",
  ]);
  await command("git", [
    "-C",
    governanceRoot,
    "remote",
    "add",
    "origin",
    "https://github.com/reinispilens/.github.git",
  ]);

  const policyPath = "agent-system/tracker-policy.json";
  const doctrinePath = "agent-system/golden-principles.md";
  const manifestPath = "agent-system/accepted-governance.json";
  const policySnapshot = acceptedGovernanceFixture().trackerPolicy;
  const policyDocument = Object.fromEntries(
    Object.entries(policySnapshot).filter(([key]) => key !== "source"),
  );
  const policyBytes = `${JSON.stringify(policyDocument, null, 2)}\n`;
  const doctrineBytes =
    "# Accepted test doctrine\n\n- Keep authority explicit.\n";
  await Promise.all([
    writeFile(path.join(governanceRoot, policyPath), policyBytes),
    writeFile(path.join(governanceRoot, doctrinePath), doctrineBytes),
  ]);
  await command("git", ["-C", governanceRoot, "add", "."]);
  await command("git", [
    "-C",
    governanceRoot,
    "commit",
    "-m",
    "accepted governance artifacts",
  ]);
  const acceptedRevision = await command("git", [
    "-C",
    governanceRoot,
    "rev-parse",
    "HEAD",
  ]);
  const manifest = {
    schemaVersion: 1,
    repositoryIdentity: "reinispilens/.github",
    acceptedRevision,
    artifacts: {
      doctrine: { path: doctrinePath, digest: digest(doctrineBytes) },
      trackerPolicy: { path: policyPath, digest: digest(policyBytes) },
    },
  };
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path.join(governanceRoot, manifestPath), manifestBytes);
  await command("git", ["-C", governanceRoot, "add", manifestPath]);
  await command("git", [
    "-C",
    governanceRoot,
    "commit",
    "-m",
    "publish accepted governance",
  ]);
  const manifestRevision = await command("git", [
    "-C",
    governanceRoot,
    "rev-parse",
    "HEAD",
  ]);

  const profileFile = path.join(setup.sourceRoot, setup.profilePath);
  const profile = JSON.parse(await readFile(profileFile, "utf8")) as Record<
    string,
    unknown
  >;
  profile["schemaVersion"] = 2;
  profile["deliveryGrant"] = {
    authority: "full-in-scope",
    governingPolicy: {
      repositoryIdentity: "reinispilens/.github",
      path: policyPath,
      revision: acceptedRevision,
      digest: digest(policyBytes),
    },
    requiredChecks: ["proof / Protected final"],
  };
  const profileBytes = `${JSON.stringify(profile, null, 2)}\n`;
  await writeFile(profileFile, profileBytes);
  await command("git", ["-C", setup.sourceRoot, "add", setup.profilePath]);
  await command("git", [
    "-C",
    setup.sourceRoot,
    "commit",
    "-m",
    "select accepted governance",
  ]);
  const profileRevision = await command("git", [
    "-C",
    setup.sourceRoot,
    "rev-parse",
    "HEAD",
  ]);
  const providerExecutable = path.join(
    path.dirname(setup.binding.runtime.codexExecutable),
    "delivery-provider-v3",
  );
  await writeFile(providerExecutable, "#!/bin/sh\nexit 0\n");
  await chmod(providerExecutable, 0o755);

  const binding: Extract<
    DeploymentBindingDocument,
    { readonly schemaVersion: 3 }
  > = {
    ...setup.binding,
    schemaVersion: 3,
    productProfile: {
      ...setup.binding.productProfile,
      revision: profileRevision,
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
    tracker: {
      kind: setup.binding.tracker.kind,
      provider: setup.binding.tracker.provider,
    },
    deliveryProvider: {
      protocolVersion: 1,
      executable: providerExecutable,
      timeoutMs: 30_000,
      secretEnvironmentNames: ["DELIVERY_TOKEN"],
      proofAuthority: {
        kind: "github-actions-reusable-workflow-v1",
        requiredCheck: "proof / Protected final",
        eventName: "pull_request_target",
        callerWorkflowPath: ".github/workflows/protected-proof-v2.yml",
        controlWorkflow: {
          repositoryIdentity: "reinispilens/workspace-control-plane",
          path: ".github/workflows/protected-proof-v2.yml",
          revision: "4".repeat(40),
        },
      },
    },
  };
  await writeFile(setup.bindingPath, `${JSON.stringify(binding, null, 2)}\n`);
  return {
    binding,
    doctrine: { revision: acceptedRevision, digest: digest(doctrineBytes) },
    governanceRoot,
    policy: {
      path: policyPath,
      revision: acceptedRevision,
      digest: digest(policyBytes),
    },
  };
}

describe("deployment binding resolver", () => {
  it("resolves v3 governance from exact Git blobs and removes policy duplication from the binding", async () => {
    await withTempDirectory(async (directory) => {
      const setup = await fixture(directory);
      const accepted = await selectAcceptedGovernance(setup);
      await writeFile(
        path.join(accepted.governanceRoot, accepted.policy.path),
        '{"candidate":"must not win"}\n',
      );

      const resolved = await resolveDeploymentBinding({
        bindingPath: setup.bindingPath,
        trackerProfiles: testTrackerProfiles,
        environment: { DELIVERY_TOKEN: "operator-secret" },
      });

      expect(resolved.governance?.manifest.acceptedRevision).toBe(
        accepted.policy.revision,
      );
      expect(resolved.serviceConfig.deployment?.doctrine).toMatchObject(
        accepted.doctrine,
      );
      expect(resolved.acceptedConfiguration.governanceManifest).toEqual(
        resolved.governance?.manifestReference,
      );
      expect(resolved.acceptedConfiguration.trackerPolicy?.source).toEqual({
        repositoryIdentity: "reinispilens/.github",
        ...accepted.policy,
      });
      expect(
        resolved.acceptedConfiguration.deliveryGrant?.governingPolicy,
      ).toEqual(resolved.acceptedConfiguration.trackerPolicy?.source);
      expect(resolved.acceptedConfiguration.proofAuthority).toEqual(
        accepted.binding.deliveryProvider?.proofAuthority,
      );
      expect(resolved.serviceConfig.tracker).toMatchObject({
        requiredLabels: ["driver:symphony"],
        excludedLabels: ["driver:direct"],
        activeStates: ["Todo", "In Progress", "Merging", "Rework"],
        freshAttemptFailureState: "Human Review",
      });
      expect(accepted.binding.tracker).toEqual({
        kind: "test",
        provider: {
          hostname: "github.com",
          owner: "acme",
          repo: "widgets",
        },
      });
    });
  });

  it("pins a v2 product-owner delivery grant while keeping provider credentials operator-owned", async () => {
    await withTempDirectory(async (directory) => {
      const setup = await fixture(directory);
      const binding = await selectDeliveryGrant(setup, "full-in-scope");
      const resolved = await resolveDeploymentBinding({
        bindingPath: setup.bindingPath,
        trackerProfiles: testTrackerProfiles,
        environment: { DELIVERY_TOKEN: "operator-secret" },
      });

      expect(resolved.acceptedConfiguration.deliveryGrant).toEqual({
        authority: "full-in-scope",
        governingPolicy: {
          repositoryIdentity: "acme/.github",
          path: "agent-system/delivery-policy.json",
          revision: "2".repeat(40),
          digest: `sha256:${"3".repeat(64)}`,
        },
        requiredChecks: ["proof / Protected final"],
      });
      expect(resolved.serviceConfig.deployment?.deliveryProvider).toEqual({
        ...binding.deliveryProvider,
        proofAuthority: null,
      });
      expect(resolved.acceptedConfiguration.proofAuthority).toBeNull();
      expect(resolved.serviceConfig.tracker.secretEnvironmentNames).toContain(
        "DELIVERY_TOKEN",
      );
      expect(JSON.stringify(resolved)).not.toContain("operator-secret");
    });
  });

  it("refuses v2 delivery when its separately named operator secret is absent", async () => {
    await withTempDirectory(async (directory) => {
      const setup = await fixture(directory);
      await selectDeliveryGrant(setup);

      await expect(
        resolveDeploymentBinding({
          bindingPath: setup.bindingPath,
          trackerProfiles: testTrackerProfiles,
          environment: {},
        }),
      ).rejects.toMatchObject({
        code: "deployment_binding_refused",
        message: expect.stringContaining("DELIVERY_TOKEN is missing"),
      });
    });
  });

  it("composes operator topology with product facts from one exact Git revision", async () => {
    await withTempDirectory(async (directory) => {
      const setup = await fixture(directory);
      await Promise.all([
        writeFile(
          path.join(setup.sourceRoot, ".symphony", "prompt.md"),
          "MUTABLE WORKTREE PROMPT MUST NOT WIN\n",
        ),
        writeFile(
          path.join(setup.sourceRoot, setup.profilePath),
          '{"schemaVersion":999}\n',
        ),
      ]);

      const resolved = await resolveDeploymentBinding({
        bindingPath: setup.bindingPath,
        trackerProfiles: testTrackerProfiles,
        environment: {},
        now: () => new Date("2026-08-25T10:00:00.000Z"),
      });

      expect(resolved.workflow.definition).toEqual({
        config: {},
        promptTemplate: "Work only from accepted product context.",
      });
      expect(resolved.serviceConfig).toMatchObject({
        deployment: {
          bindingId: "widgets-local",
          sourceRoot: setup.sourceRoot,
          acceptedConfiguration: resolved.acceptedConfiguration,
          preparation: {
            nodeExecutable: process.execPath,
            dependencyPolicy: {
              mode: "offline",
              registry: "https://registry.npmjs.org/",
              seedStoreRoot: path.join(directory, "dependency-store"),
              digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
            },
          },
        },
        repository: {
          identity: "acme/widgets",
          baseRef: "refs/heads/main",
          branchPrefix: "symphony/",
          profileDigest: setup.binding.productProfile.digest,
        },
        workspace: {
          provider: "git-worktree",
          root: path.join(directory, "workspaces"),
        },
        preparation: { driver: "pnpm", timeoutMs: 120_000 },
        agent: { maxConcurrentAgents: 1 },
      });
      expect(resolved.acceptedConfiguration.authoringContext.entries).toEqual([
        {
          path: ".symphony/prompt.md",
          digest: digest("Work only from accepted product context.\n"),
        },
        { path: "AGENTS.md", digest: digest("# Product instructions\n") },
      ]);
      expect(resolved.bindingDigest).toBe(
        digest(await readFile(setup.bindingPath)),
      );
    });
  });

  it("refuses a deployment reference whose accepted profile digest is wrong", async () => {
    await withTempDirectory(async (directory) => {
      const setup = await fixture(directory);
      const binding = {
        ...setup.binding,
        productProfile: {
          ...setup.binding.productProfile,
          digest: `sha256:${"0".repeat(64)}`,
        },
      };
      await writeFile(setup.bindingPath, `${JSON.stringify(binding)}\n`);

      await expect(
        resolveDeploymentBinding({
          bindingPath: setup.bindingPath,
          trackerProfiles: testTrackerProfiles,
          environment: {},
        }),
      ).rejects.toMatchObject({ code: "deployment_binding_refused" });
    });
  });

  it("refuses operator topology smuggled into the product profile", async () => {
    await withTempDirectory(async (directory) => {
      const setup = await fixture(directory);
      const profile = JSON.parse(
        await readFile(path.join(setup.sourceRoot, setup.profilePath), "utf8"),
      ) as Record<string, unknown>;
      profile["workspaceRoot"] = "/candidate/chosen/root";
      const bytes = `${JSON.stringify(profile)}\n`;
      await writeFile(path.join(setup.sourceRoot, setup.profilePath), bytes);
      await command("git", ["-C", setup.sourceRoot, "add", "."]);
      await command("git", [
        "-C",
        setup.sourceRoot,
        "commit",
        "-m",
        "hostile profile",
      ]);
      const revision = await command("git", [
        "-C",
        setup.sourceRoot,
        "rev-parse",
        "HEAD",
      ]);
      const binding = {
        ...setup.binding,
        productProfile: {
          ...setup.binding.productProfile,
          revision,
          digest: digest(bytes),
        },
      };
      await writeFile(setup.bindingPath, `${JSON.stringify(binding)}\n`);

      await expect(
        resolveDeploymentBinding({
          bindingPath: setup.bindingPath,
          trackerProfiles: testTrackerProfiles,
          environment: {},
        }),
      ).rejects.toMatchObject({ code: "repository_profile_invalid" });
    });
  });

  it("refuses a binding stored inside the product repository", async () => {
    await withTempDirectory(async (directory) => {
      const setup = await fixture(directory);
      const inside = path.join(setup.sourceRoot, "deployment-binding.json");
      await writeFile(inside, `${JSON.stringify(setup.binding)}\n`);

      await expect(
        resolveDeploymentBinding({
          bindingPath: inside,
          trackerProfiles: testTrackerProfiles,
          environment: {},
        }),
      ).rejects.toMatchObject({ code: "deployment_binding_refused" });
    });
  });

  it("refuses an in-product Git executable before invoking it", async () => {
    await withTempDirectory(async (directory) => {
      const setup = await fixture(directory);
      const marker = path.join(directory, "git-was-invoked");
      const wrapper = path.join(setup.sourceRoot, "candidate-git");
      await writeFile(
        wrapper,
        [
          `#!${process.execPath}`,
          `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "unsafe");`,
          'const { spawnSync } = require("node:child_process");',
          `const result = spawnSync(${JSON.stringify(setup.binding.gitExecutable)}, process.argv.slice(2), { stdio: "inherit" });`,
          "process.exit(result.status ?? 1);",
          "",
        ].join("\n"),
      );
      await chmod(wrapper, 0o755);
      await writeFile(
        setup.bindingPath,
        `${JSON.stringify({ ...setup.binding, gitExecutable: wrapper })}\n`,
      );

      await expect(
        resolveDeploymentBinding({
          bindingPath: setup.bindingPath,
          trackerProfiles: testTrackerProfiles,
          environment: {},
        }),
      ).rejects.toThrow(
        "Deployment Git executable must be outside product, state, and workspace roots",
      );
      await expect(readFile(marker, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("refuses any online dependency policy", async () => {
    await withTempDirectory(async (directory) => {
      const setup = await fixture(directory);
      const binding = {
        ...setup.binding,
        preparation: {
          ...setup.binding.preparation,
          dependencyPolicy: {
            ...setup.binding.preparation!.dependencyPolicy,
            mode: "online",
          },
        },
      };
      await writeFile(setup.bindingPath, `${JSON.stringify(binding)}\n`);

      await expect(
        resolveDeploymentBinding({
          bindingPath: setup.bindingPath,
          trackerProfiles: testTrackerProfiles,
          environment: {},
        }),
      ).rejects.toMatchObject({ code: "deployment_binding_invalid" });
    });
  });

  it("does not require pnpm authority when the product selects no preparation", async () => {
    await withTempDirectory(async (directory) => {
      const setup = await fixture(directory);
      const binding: DeploymentBindingDocument = {
        ...setup.binding,
        productProfile: await selectPreparationClass(setup, "none"),
        preparation: null,
      };
      await writeFile(setup.bindingPath, `${JSON.stringify(binding)}\n`);

      const resolved = await resolveDeploymentBinding({
        bindingPath: setup.bindingPath,
        trackerProfiles: testTrackerProfiles,
        environment: {},
      });

      expect(resolved.serviceConfig.preparation.driver).toBe("none");
      expect(resolved.serviceConfig.deployment?.preparation).toBeNull();
    });
  });

  it("refuses missing pnpm authority when the product selects pnpm", async () => {
    await withTempDirectory(async (directory) => {
      const setup = await fixture(directory);
      const binding: DeploymentBindingDocument = {
        ...setup.binding,
        preparation: null,
      };
      await writeFile(setup.bindingPath, `${JSON.stringify(binding)}\n`);

      await expect(
        resolveDeploymentBinding({
          bindingPath: setup.bindingPath,
          trackerProfiles: testTrackerProfiles,
          environment: {},
        }),
      ).rejects.toThrow(
        "must be present exactly when the accepted product profile selects 'pnpm'",
      );
    });
  });

  it("refuses unused pnpm authority when the product selects no preparation", async () => {
    await withTempDirectory(async (directory) => {
      const setup = await fixture(directory);
      const binding: DeploymentBindingDocument = {
        ...setup.binding,
        productProfile: await selectPreparationClass(setup, "none"),
      };
      await writeFile(setup.bindingPath, `${JSON.stringify(binding)}\n`);

      await expect(
        resolveDeploymentBinding({
          bindingPath: setup.bindingPath,
          trackerProfiles: testTrackerProfiles,
          environment: {},
        }),
      ).rejects.toThrow(
        "must be present exactly when the accepted product profile selects 'pnpm'",
      );
    });
  });

  it.each([
    "https://127.0.0.1:4873/",
    "https://[::1]/",
    "https://[fc00::1]/",
    "https://[fe80::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://localhost./",
    "https://metadata.google.internal./",
  ])("refuses unsafe dependency registry identity %s", async (registry) => {
    await withTempDirectory(async (directory) => {
      const setup = await fixture(directory);
      const binding = {
        ...setup.binding,
        preparation: {
          ...setup.binding.preparation,
          dependencyPolicy: {
            ...setup.binding.preparation!.dependencyPolicy,
            registry,
          },
        },
      };
      await writeFile(setup.bindingPath, `${JSON.stringify(binding)}\n`);

      await expect(
        resolveDeploymentBinding({
          bindingPath: setup.bindingPath,
          trackerProfiles: testTrackerProfiles,
          environment: {},
        }),
      ).rejects.toMatchObject({ code: "deployment_binding_invalid" });
    });
  });

  it("refuses a pnpm entry point that does not match the pinned version", async () => {
    await withTempDirectory(async (directory) => {
      const setup = await fixture(directory);
      const binding = {
        ...setup.binding,
        preparation: {
          ...setup.binding.preparation,
          dependencyPolicy: {
            ...setup.binding.preparation!.dependencyPolicy,
            pnpmVersion: "11.4.0",
          },
        },
      };
      await writeFile(setup.bindingPath, `${JSON.stringify(binding)}\n`);

      await expect(
        resolveDeploymentBinding({
          bindingPath: setup.bindingPath,
          trackerProfiles: testTrackerProfiles,
          environment: {},
        }),
      ).rejects.toThrow("must report version 11.4.0");
    });
  });

  it("refuses a dependency seed that overlaps the product source", async () => {
    await withTempDirectory(async (directory) => {
      const setup = await fixture(directory);
      const binding = {
        ...setup.binding,
        preparation: {
          ...setup.binding.preparation,
          dependencyPolicy: {
            ...setup.binding.preparation!.dependencyPolicy,
            seedStoreRoot: setup.sourceRoot,
          },
        },
      };
      await writeFile(setup.bindingPath, `${JSON.stringify(binding)}\n`);

      await expect(
        resolveDeploymentBinding({
          bindingPath: setup.bindingPath,
          trackerProfiles: testTrackerProfiles,
          environment: {},
        }),
      ).rejects.toThrow("must be disjoint from product source");
    });
  });
});
