import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  openSystemdUserScope,
  quiesceSystemdUserScope,
  systemdScopeUnit,
} from "../../src/agent/systemd-user-scope.js";
import type { RepositoryCleanupAuthority } from "../../src/repository/driver.js";
import type { ManagedProcessContainmentConfig } from "../../src/workflow/config.js";
import { withTempDirectory } from "../support/factories.js";

const authority: RepositoryCleanupAuthority = {
  workSessionId: "session/with unsafe characters",
  controllerGeneration: 7,
};

async function fakeControl(
  directory: string,
  mode: "normal" | "stuck" = "normal",
): Promise<{
  readonly config: ManagedProcessContainmentConfig;
  readonly logPath: string;
  readonly statePath: string;
}> {
  const systemdRunExecutable = path.join(directory, "systemd-run");
  const systemctlExecutable = path.join(directory, "systemctl");
  const logPath = path.join(directory, "systemctl.log");
  const statePath = path.join(directory, "active");
  await writeFile(systemdRunExecutable, "#!/bin/sh\nexit 0\n");
  await writeFile(
    systemctlExecutable,
    `#!${process.execPath}\n` +
      `const fs = require("node:fs");\n` +
      `const args = process.argv.slice(2);\n` +
      `fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, secret: process.env.TEST_SECRET ?? null }) + "\\n");\n` +
      `if (args.includes("--property=Version")) { process.stdout.write("Version=259\\n"); process.exit(0); }\n` +
      `if (args[1] === "show") {\n` +
      `  const active = fs.existsSync(${JSON.stringify(statePath)});\n` +
      `  process.stdout.write(active ? "LoadState=loaded\\nActiveState=active\\nSubState=running\\nControlGroup=/user.slice/test.scope\\n" : "LoadState=not-found\\nActiveState=inactive\\nSubState=dead\\nControlGroup=\\n");\n` +
      `  process.exit(0);\n` +
      `}\n` +
      `if (args[1] === "kill") { ${mode === "normal" ? `try { fs.unlinkSync(${JSON.stringify(statePath)}); } catch {}` : ""} process.exit(0); }\n` +
      `process.exit(1);\n`,
  );
  await Promise.all([
    chmod(systemdRunExecutable, 0o755),
    chmod(systemctlExecutable, 0o755),
  ]);
  return {
    config: {
      provider: "systemd-user-scope",
      shutdownTimeoutMs: 150,
      systemdRunExecutable,
      systemctlExecutable,
    },
    logPath,
    statePath,
  };
}

describe("systemd user-scope process boundary", () => {
  it("wraps the exact app-server command in one deterministic control-group scope", async () => {
    await withTempDirectory(async (directory) => {
      const fixture = await fakeControl(directory);
      const scope = await openSystemdUserScope(
        fixture.config,
        authority,
        { executable: "/trusted/codex", args: ["app-server"] },
        {
          XDG_RUNTIME_DIR: "/run/user/1000",
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
          TEST_SECRET: "must-not-reach-systemctl",
        },
      );

      expect(scope.unit).toBe(systemdScopeUnit(authority));
      expect(scope.unit).toMatch(/^symphony-agent-[0-9a-f]{40}\.scope$/u);
      expect(scope.command).toEqual({
        executable: fixture.config.systemdRunExecutable,
        args: [
          "--user",
          "--scope",
          "--expand-environment=no",
          "--quiet",
          "--collect",
          `--unit=${scope.unit}`,
          "--property=KillMode=control-group",
          "--",
          "/trusted/codex",
          "app-server",
        ],
      });
      await scope.quiesce();
      const observations = (await readFile(fixture.logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { secret: string | null });
      expect(observations.every((entry) => entry.secret === null)).toBe(true);
    });
  });

  it("signals the complete scope and verifies it is empty", async () => {
    await withTempDirectory(async (directory) => {
      const fixture = await fakeControl(directory);
      await writeFile(fixture.statePath, "active");

      await quiesceSystemdUserScope(fixture.config, authority, {});

      const log = await readFile(fixture.logPath, "utf8");
      expect(log).toContain('"--signal=SIGTERM"');
      expect(log).toContain('"--kill-whom=all"');
    });
  });

  it("refuses to launch over an existing WorkSession controller scope", async () => {
    await withTempDirectory(async (directory) => {
      const fixture = await fakeControl(directory);
      await writeFile(fixture.statePath, "active");

      await expect(
        openSystemdUserScope(
          fixture.config,
          authority,
          { executable: "/trusted/codex", args: ["app-server"] },
          {},
        ),
      ).rejects.toMatchObject({ code: "runtime_quiescence_refused" });
    });
  });

  it("refuses lease release when descendants remain in the scope", async () => {
    await withTempDirectory(async (directory) => {
      const fixture = await fakeControl(directory, "stuck");
      await writeFile(fixture.statePath, "active");

      await expect(
        quiesceSystemdUserScope(fixture.config, authority, {}),
      ).rejects.toMatchObject({ code: "runtime_quiescence_refused" });
      const log = await readFile(fixture.logPath, "utf8");
      expect(log).toContain('"--signal=SIGTERM"');
      expect(log).toContain('"--signal=SIGKILL"');
    });
  });
});
