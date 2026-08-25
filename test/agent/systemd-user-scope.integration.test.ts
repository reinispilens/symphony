import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  openSystemdUserScope,
  quiesceSystemdUserScope,
} from "../../src/agent/systemd-user-scope.js";
import type { RepositoryCleanupAuthority } from "../../src/repository/driver.js";
import type { ManagedProcessContainmentConfig } from "../../src/workflow/config.js";

const ENABLED = process.env["SYMPHONY_SYSTEMD_INTEGRATION"] === "1";
const config: ManagedProcessContainmentConfig = {
  provider: "systemd-user-scope",
  shutdownTimeoutMs: 2_000,
  systemdRunExecutable: "/usr/bin/systemd-run",
  systemctlExecutable: "/usr/bin/systemctl",
};

function alive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function firstLine(
  stream: NodeJS.ReadableStream,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let bytes = "";
    const timeout = setTimeout(
      () => reject(new Error("timed out waiting for detached child PID")),
      timeoutMs,
    );
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      bytes += chunk;
      const newline = bytes.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timeout);
      resolve(bytes.slice(0, newline));
    });
    stream.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    stream.on("end", () => {
      clearTimeout(timeout);
      reject(new Error("scoped process exited before reporting its child PID"));
    });
  });
}

async function waitForExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("timed out waiting for scoped launcher exit")),
      timeoutMs,
    );
    child.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function waitUntilGone(processId: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (alive(processId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(alive(processId)).toBe(false);
}

describe.runIf(ENABLED)("systemd user-scope host integration", () => {
  it("removes a detached descendant after its app-server parent exits", async () => {
    const authority: RepositoryCleanupAuthority = {
      workSessionId: `systemd-integration-${process.pid}-${Date.now()}`,
      controllerGeneration: 1,
    };
    const program = [
      'const { spawn } = require("node:child_process");',
      'const child = spawn("/usr/bin/sleep", ["300"], { detached: true, stdio: "ignore" });',
      "process.stdout.write(`${child.pid}\\n`);",
      "child.unref();",
      "setInterval(() => undefined, 1_000);",
    ].join("\n");
    let launcher: ReturnType<typeof spawn> | null = null;
    let descendantPid: number | null = null;

    try {
      const scope = await openSystemdUserScope(
        config,
        authority,
        { executable: process.execPath, args: ["-e", program] },
        process.env,
      );
      launcher = spawn(scope.command.executable, [...scope.command.args], {
        detached: true,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      descendantPid = Number(await firstLine(launcher.stdout!, 2_000));
      if (!Number.isSafeInteger(descendantPid) || descendantPid <= 1) {
        throw new Error(`invalid detached child PID ${String(descendantPid)}`);
      }
      expect(alive(descendantPid)).toBe(true);

      // App-server exit is not proof that its deliberately detached child is
      // gone. The systemd scope remains the authoritative descendant set.
      launcher.kill("SIGTERM");
      await waitForExit(launcher, 2_000);
      expect(alive(descendantPid)).toBe(true);

      await scope.quiesce();
      await waitUntilGone(descendantPid, 2_000);
    } finally {
      if (launcher?.pid !== undefined && launcher.exitCode === null) {
        try {
          launcher.kill("SIGKILL");
        } catch {}
      }
      await quiesceSystemdUserScope(config, authority, process.env).catch(
        () => undefined,
      );
      if (descendantPid !== null && descendantPid > 1 && alive(descendantPid)) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {}
      }
    }
  });
});
