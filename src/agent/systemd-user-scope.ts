import { createHash } from "node:crypto";
import { execFile } from "node:child_process";

import { SymphonyError } from "../errors.js";
import type { RepositoryCleanupAuthority } from "../repository/driver.js";
import type { ManagedProcessContainmentConfig } from "../workflow/config.js";
import type { DirectAppServerCommand } from "./process-transport.js";

const CONTROL_ENVIRONMENT_NAMES = [
  "DBUS_SESSION_BUS_ADDRESS",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "USER",
  "XDG_RUNTIME_DIR",
] as const;
const MAX_CONTROL_OUTPUT_BYTES = 64 * 1024;

interface CommandResult {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}

interface ScopeState {
  readonly activeState: string;
  readonly controlGroup: string;
  readonly loadState: string;
  readonly subState: string;
}

export interface SystemdUserScope {
  readonly command: DirectAppServerCommand;
  readonly unit: string;
  quiesce(): Promise<void>;
}

function refusal(
  message: string,
  unit: string,
  cause?: unknown,
): SymphonyError {
  return new SymphonyError("runtime_quiescence_refused", message, {
    ...(cause === undefined ? {} : { cause }),
    context: { unit },
  });
}

function controlEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {};
  for (const name of CONTROL_ENVIRONMENT_NAMES) {
    const value = source[name];
    if (value !== undefined) selected[name] = value;
  }
  return selected;
}

function command(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      {
        encoding: "utf8",
        env: environment,
        killSignal: "SIGKILL",
        maxBuffer: MAX_CONTROL_OUTPUT_BYTES,
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ exitCode: 0, stderr, stdout, timedOut: false });
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (typeof code !== "number") {
          if ((error as NodeJS.ErrnoException & { killed?: boolean }).killed) {
            resolve({
              exitCode: null,
              stderr: String(stderr),
              stdout: String(stdout),
              timedOut: true,
            });
            return;
          }
          reject(error);
          return;
        }
        resolve({
          exitCode: code,
          stderr: String(stderr),
          stdout: String(stdout),
          timedOut: false,
        });
      },
    );
  });
}

export function systemdScopeUnit(
  authority: RepositoryCleanupAuthority,
): string {
  const identity = createHash("sha256")
    .update(authority.workSessionId)
    .update("\0")
    .update(String(authority.controllerGeneration))
    .digest("hex")
    .slice(0, 40);
  return `symphony-agent-${identity}.scope`;
}

function parseScopeState(stdout: string, unit: string): ScopeState {
  const fields = new Map<string, string>();
  for (const line of stdout.trim().split("\n")) {
    if (line === "") continue;
    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw refusal(`systemctl returned malformed state for ${unit}`, unit);
    }
    fields.set(line.slice(0, separator), line.slice(separator + 1));
  }
  const loadState = fields.get("LoadState");
  const activeState = fields.get("ActiveState");
  const subState = fields.get("SubState");
  const controlGroup = fields.get("ControlGroup");
  if (
    loadState === undefined ||
    activeState === undefined ||
    subState === undefined ||
    controlGroup === undefined
  ) {
    throw refusal(`systemctl omitted required state for ${unit}`, unit);
  }
  return { activeState, controlGroup, loadState, subState };
}

async function inspectScope(
  config: ManagedProcessContainmentConfig,
  unit: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs = config.shutdownTimeoutMs,
): Promise<ScopeState> {
  let result: CommandResult;
  try {
    result = await command(
      config.systemctlExecutable,
      [
        "--user",
        "show",
        unit,
        "--property=LoadState",
        "--property=ActiveState",
        "--property=SubState",
        "--property=ControlGroup",
        "--no-pager",
      ],
      environment,
      Math.max(timeoutMs, 1),
    );
  } catch (error) {
    throw refusal(`Could not inspect systemd scope ${unit}`, unit, error);
  }
  if (result.exitCode !== 0 || result.timedOut) {
    throw refusal(
      `Could not inspect systemd scope ${unit}: ${result.stderr.trim() || (result.timedOut ? "timed out" : `exit ${String(result.exitCode)}`)}`,
      unit,
    );
  }
  return parseScopeState(result.stdout, unit);
}

function quiescent(state: ScopeState): boolean {
  if (state.loadState === "not-found") return true;
  return (
    (state.activeState === "inactive" || state.activeState === "failed") &&
    state.controlGroup === ""
  );
}

async function managerAvailable(
  config: ManagedProcessContainmentConfig,
  unit: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  let result: CommandResult;
  try {
    result = await command(
      config.systemctlExecutable,
      ["--user", "show", "--property=Version", "--no-pager"],
      environment,
      config.shutdownTimeoutMs,
    );
  } catch (error) {
    throw refusal(
      "Could not contact the configured systemd user manager",
      unit,
      error,
    );
  }
  if (
    result.exitCode !== 0 ||
    result.timedOut ||
    !/^Version=\S+/mu.test(result.stdout)
  ) {
    throw refusal(
      `Could not contact the configured systemd user manager: ${result.stderr.trim() || (result.timedOut ? "timed out" : "version unavailable")}`,
      unit,
    );
  }
}

async function signalScope(
  config: ManagedProcessContainmentConfig,
  unit: string,
  signal: "SIGKILL" | "SIGTERM",
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  try {
    await command(
      config.systemctlExecutable,
      ["--user", "kill", `--signal=${signal}`, "--kill-whom=all", unit],
      environment,
      config.shutdownTimeoutMs,
    );
  } catch (error) {
    throw refusal(`Could not signal systemd scope ${unit}`, unit, error);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForQuiescence(
  config: ManagedProcessContainmentConfig,
  unit: string,
  environment: NodeJS.ProcessEnv,
  deadline: number,
): Promise<ScopeState> {
  let state = await inspectScope(
    config,
    unit,
    environment,
    Math.max(deadline - Date.now(), 1),
  );
  while (!quiescent(state) && Date.now() < deadline) {
    await delay(Math.min(50, Math.max(deadline - Date.now(), 1)));
    try {
      state = await inspectScope(
        config,
        unit,
        environment,
        Math.max(deadline - Date.now(), 1),
      );
    } catch (error) {
      // A control query started at the edge of this phase can exhaust the
      // remaining phase budget. Preserve the last proven state so the caller
      // can escalate from TERM to KILL (or refuse final release) instead of
      // accidentally treating the observation timeout as quiescence.
      if (Date.now() >= deadline) return state;
      throw error;
    }
  }
  return state;
}

export async function quiesceSystemdUserScope(
  config: ManagedProcessContainmentConfig,
  authority: RepositoryCleanupAuthority,
  sourceEnvironment: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const unit = systemdScopeUnit(authority);
  const environment = controlEnvironment(sourceEnvironment);
  await managerAvailable(config, unit, environment);
  let state = await inspectScope(config, unit, environment);
  if (quiescent(state)) return;

  const startedAt = Date.now();
  const deadline = startedAt + config.shutdownTimeoutMs;
  await signalScope(config, unit, "SIGTERM", environment);
  state = await waitForQuiescence(
    config,
    unit,
    environment,
    startedAt + Math.floor(config.shutdownTimeoutMs / 2),
  );
  if (!quiescent(state)) {
    await signalScope(config, unit, "SIGKILL", environment);
    state = await waitForQuiescence(config, unit, environment, deadline);
  }
  if (!quiescent(state)) {
    throw refusal(
      `Systemd scope ${unit} remained ${state.activeState}/${state.subState} with control group ${state.controlGroup || "<unknown>"}`,
      unit,
    );
  }
}

export async function openSystemdUserScope(
  config: ManagedProcessContainmentConfig,
  authority: RepositoryCleanupAuthority,
  appServerCommand: DirectAppServerCommand,
  sourceEnvironment: Readonly<Record<string, string | undefined>>,
): Promise<SystemdUserScope> {
  const unit = systemdScopeUnit(authority);
  const environment = controlEnvironment(sourceEnvironment);
  await managerAvailable(config, unit, environment);
  const existing = await inspectScope(config, unit, environment);
  if (existing.loadState !== "not-found") {
    throw refusal(
      `Systemd scope ${unit} already exists as ${existing.activeState}/${existing.subState}`,
      unit,
    );
  }
  return {
    unit,
    command: {
      executable: config.systemdRunExecutable,
      args: [
        "--user",
        "--scope",
        "--expand-environment=no",
        "--quiet",
        "--collect",
        `--unit=${unit}`,
        "--property=KillMode=control-group",
        "--",
        appServerCommand.executable,
        ...appServerCommand.args,
      ],
    },
    quiesce: () =>
      quiesceSystemdUserScope(config, authority, sourceEnvironment),
  };
}
