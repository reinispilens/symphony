import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import Database from "better-sqlite3";

import { SymphonyError, errorMessage } from "../errors.js";
import { nullLogger, type Logger } from "../observability/logger.js";
import type {
  RepositoryCleanupAuthority,
  WorkspaceLifecycleConfig,
} from "../repository/driver.js";
import { redactEnvironmentSecrets } from "../security/secrets.js";
import type { SymphonyStateStore } from "../state/store.js";
import type { PreparationDriver, PreparationInput } from "./driver.js";
import { inspectPnpmInputs } from "./pnpm-policy.js";

const MAX_SEED_INDEX_BYTES = 512 * 1024 * 1024;

interface CommandResult {
  readonly aborted: boolean;
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface PnpmPreparationDriverOptions {
  readonly logger?: Logger;
  readonly now?: () => Date;
  readonly processEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly stateStore: SymphonyStateStore;
}

interface ResolvedProgram {
  readonly bindRoot: string | null;
  readonly invocationPath: string;
  readonly realPath: string;
}

function strictChild(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function secretNames(
  environment: Readonly<Record<string, string | undefined>>,
  configured: readonly string[],
): readonly string[] {
  return [
    ...new Set([
      ...configured,
      ...Object.keys(environment).filter((name) =>
        /(TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE|PRIVATE.*KEY)/iu.test(
          name,
        ),
      ),
    ]),
  ];
}

function safeOutput(
  text: string,
  environment: Readonly<Record<string, string | undefined>>,
  configuredSecrets: readonly string[],
): string {
  return redactEnvironmentSecrets(
    text,
    environment,
    secretNames(environment, configuredSecrets),
  )
    .trim()
    .slice(-4_000);
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new SymphonyError(
      "preparation_refused",
      `Preparation path ${directory} must be a real directory`,
    );
  }
  await chmod(directory, 0o700);
}

async function verifySeedStore(directory: string): Promise<void> {
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new SymphonyError(
      "preparation_refused",
      `Dependency seed store ${directory} must be a real directory`,
    );
  }
  const resolved = await realpath(directory);
  if (resolved !== path.resolve(directory)) {
    throw new SymphonyError(
      "preparation_refused",
      `Dependency seed store ${directory} must contain no symbolic-link components`,
    );
  }
  for (const [relative, kind] of [
    ["v11", "directory"],
    ["v11/files", "directory"],
    ["v11/index.db", "file"],
  ] as const) {
    const entryPath = path.join(directory, relative);
    const child = await lstat(entryPath);
    if (
      child.isSymbolicLink() ||
      (kind === "directory" ? !child.isDirectory() : !child.isFile())
    ) {
      throw new SymphonyError(
        "preparation_refused",
        `Dependency seed store ${relative} must be a real ${kind}`,
      );
    }
    if (kind === "file" && child.size > MAX_SEED_INDEX_BYTES) {
      throw new SymphonyError(
        "preparation_refused",
        `Dependency seed store ${relative} must not exceed ${MAX_SEED_INDEX_BYTES} bytes`,
      );
    }
    if ((await realpath(entryPath)) !== path.resolve(entryPath)) {
      throw new SymphonyError(
        "preparation_refused",
        `Dependency seed store ${relative} must contain no symbolic-link components`,
      );
    }
  }
}

async function prepareAttemptStore(
  seedStoreRoot: string,
  privateStoreRoot: string,
): Promise<void> {
  await rm(privateStoreRoot, { recursive: true, force: true });
  const privateVersionRoot = path.join(privateStoreRoot, "v11");
  await ensurePrivateDirectory(privateVersionRoot);
  const source = new Database(path.join(seedStoreRoot, "v11", "index.db"), {
    fileMustExist: true,
    readonly: true,
  });
  try {
    await source.backup(path.join(privateVersionRoot, "index.db"));
  } finally {
    source.close();
  }
  await symlink(
    "/dependency-seed/v11/files",
    path.join(privateVersionRoot, "files"),
    "dir",
  );
}

function restrictedEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  home: string,
  temporary: string,
  userConfig: string,
  registry: string,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    CI: "true",
    HOME: home,
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    TMPDIR: temporary,
    TEMP: temporary,
    TMP: temporary,
    NPM_CONFIG_USERCONFIG: userConfig,
    npm_config_userconfig: userConfig,
    npm_config_ignore_scripts: "true",
    npm_config_ignore_pnpmfile: "true",
    npm_config_offline: "true",
    npm_config_registry: registry,
    npm_config_verify_store_integrity: "true",
  };
  for (const name of [
    "PATH",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
  ]) {
    const value = source[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

async function resolveProgram(
  executable: string,
  environment: Readonly<Record<string, string | undefined>>,
  executableRequired = true,
): Promise<ResolvedProgram> {
  const candidates = path.isAbsolute(executable)
    ? [executable]
    : (environment["PATH"] ?? "")
        .split(path.delimiter)
        .filter((entry) => entry !== "")
        .map((directory) => path.join(directory, executable));
  for (const candidate of candidates) {
    try {
      await access(
        candidate,
        executableRequired ? fsConstants.X_OK : fsConstants.R_OK,
      );
      const invocationPath = path.resolve(candidate);
      const resolved = await realpath(invocationPath);
      const marker = `${path.sep}bin${path.sep}`;
      const markerIndex = invocationPath.lastIndexOf(marker);
      const bindRoot =
        markerIndex > 0 ? invocationPath.slice(0, markerIndex) : null;
      return { bindRoot, invocationPath, realPath: resolved };
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new SymphonyError(
    "preparation_refused",
    `Required executable ${executable} is unavailable`,
  );
}

async function existingPaths(paths: readonly string[]): Promise<string[]> {
  const existing: string[] = [];
  for (const candidate of paths) {
    try {
      await lstat(candidate);
      existing.push(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return existing;
}

function parentDirectories(target: string): string[] {
  const directories: string[] = [];
  let current = path.dirname(target);
  while (current !== path.parse(current).root) {
    directories.unshift(current);
    current = path.dirname(current);
  }
  return directories;
}

async function sandboxInvocation(
  sandboxExecutable: string,
  nodeExecutable: string,
  pnpmEntryPoint: string,
  logicalArgs: readonly string[],
  options: {
    readonly cachePath: string;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly registry: string;
    readonly seedStoreRoot: string;
    readonly workspacePath: string;
  },
): Promise<{
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly executable: string;
}> {
  const [sandbox, node, pnpm] = await Promise.all([
    resolveProgram(sandboxExecutable, options.environment),
    resolveProgram(nodeExecutable, options.environment),
    resolveProgram(pnpmEntryPoint, options.environment, false),
  ]);
  const standardRoots = await existingPaths(["/usr", "/bin", "/lib", "/lib64"]);
  const configurationFiles = await existingPaths([
    "/etc/nsswitch.conf",
    "/etc/passwd",
    "/etc/group",
  ]);
  const toolRoots = [node.bindRoot, pnpm.bindRoot].filter(
    (entry): entry is string =>
      entry !== null &&
      !standardRoots.some(
        (root) => entry === root || entry.startsWith(`${root}${path.sep}`),
      ),
  );
  const uniqueToolRoots = [...new Set(toolRoots)];
  const args: string[] = [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    "--cap-drop",
    "ALL",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--dir",
    "/etc",
  ];
  for (const root of standardRoots) args.push("--ro-bind", root, root);
  for (const file of configurationFiles) {
    args.push("--ro-bind", file, file);
  }
  for (const root of uniqueToolRoots) {
    for (const directory of parentDirectories(root)) {
      args.push("--dir", directory);
    }
    args.push("--ro-bind", root, root);
  }
  args.push(
    "--dir",
    "/workspace",
    "--bind",
    options.workspacePath,
    "/workspace",
    "--dir",
    "/cache",
    "--bind",
    options.cachePath,
    "/cache",
    "--dir",
    "/dependency-seed",
    "--ro-bind",
    options.seedStoreRoot,
    "/dependency-seed",
    "--chdir",
    "/workspace",
  );

  const bindStandaloneProgram = (
    program: ResolvedProgram,
    target: string,
  ): string => {
    if (
      program.bindRoot !== null ||
      standardRoots.some(
        (root) =>
          program.realPath === root ||
          program.realPath.startsWith(`${root}${path.sep}`),
      )
    ) {
      return program.invocationPath;
    }
    args.push("--dir", "/tool", "--ro-bind", program.realPath, target);
    return target;
  };
  const inSandboxNode = bindStandaloneProgram(node, "/tool/node");
  const inSandboxPnpm = bindStandaloneProgram(pnpm, "/tool/pnpm.mjs");
  const sandboxPath = [
    ...uniqueToolRoots.map((root) => path.join(root, "bin")),
    "/usr/bin",
    "/bin",
  ].join(":");
  const environment = restrictedEnvironment(
    options.environment,
    "/cache/home",
    "/tmp",
    "/cache/empty-npmrc",
    options.registry,
  );
  environment["PATH"] = sandboxPath;
  args.push("--", inSandboxNode, inSandboxPnpm, ...logicalArgs);
  return {
    executable: sandbox.invocationPath,
    args,
    environment,
  };
}

function execute(
  executable: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly signal: AbortSignal;
  },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const outputLimit = 4 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let aborted = options.signal.aborted;
    let overflow = false;
    let killTimer: NodeJS.Timeout | null = null;
    let settled = false;
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: options.environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const signalTree = (signal: NodeJS.Signals): void => {
      const pid = child.pid;
      if (pid === undefined || pid <= 1) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          stderr += `\nCould not signal preparation process tree: ${errorMessage(error)}`;
        }
      }
    };
    const terminate = (): void => {
      signalTree("SIGTERM");
      if (killTimer === null) {
        killTimer = setTimeout(() => signalTree("SIGKILL"), 1_000);
        killTimer.unref();
      }
    };
    const onAbort = (): void => {
      aborted = true;
      terminate();
    };
    const append = (target: "stderr" | "stdout", chunk: Buffer): void => {
      if (overflow) return;
      if (outputBytes + chunk.length > outputLimit) {
        overflow = true;
        stderr += "\nPreparation output exceeded the 4 MiB limit";
        terminate();
        return;
      }
      outputBytes += chunk.length;
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };

    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", (error) => {
      stderr += `\n${errorMessage(error)}`;
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      if (killTimer !== null) clearTimeout(killTimer);
      options.signal.removeEventListener("abort", onAbort);
      resolve({
        aborted,
        exitCode:
          code === 0 && !overflow ? 0 : typeof code === "number" ? code : 1,
        stdout,
        stderr,
      });
    });
    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) onAbort();
  });
}

/** Built-in, credential-minimized pnpm preparation with scripts disabled. */
export class PnpmPreparationDriver implements PreparationDriver {
  readonly #logger: Logger;
  readonly #now: () => Date;
  readonly #processEnvironment: Readonly<Record<string, string | undefined>>;
  readonly #stateStore: SymphonyStateStore;

  constructor(options: PnpmPreparationDriverOptions) {
    this.#logger = options.logger ?? nullLogger;
    this.#now = options.now ?? (() => new Date());
    this.#processEnvironment = options.processEnvironment ?? process.env;
    this.#stateStore = options.stateStore;
  }

  async prepare(input: PreparationInput): Promise<void> {
    if (input.config.preparation.driver !== "pnpm") return;
    const authority = input.authority;
    if (authority === undefined) {
      throw new SymphonyError(
        "preparation_refused",
        "pnpm preparation requires a fenced WorkSession attempt",
      );
    }
    if (input.config.workspace.provider !== "git-worktree") {
      throw new SymphonyError(
        "preparation_refused",
        "pnpm preparation runs only in a Symphony-managed Git worktree",
      );
    }
    const deployment = input.config.deployment;
    if (deployment === null) {
      throw new SymphonyError(
        "preparation_refused",
        "pnpm preparation requires an accepted operator deployment binding",
      );
    }
    const preparationAuthority = deployment.preparation;
    if (preparationAuthority === null) {
      throw new SymphonyError(
        "preparation_refused",
        "pnpm preparation requires operator-owned pnpm authority",
      );
    }
    const dependencyPolicy = preparationAuthority.dependencyPolicy;
    const session = this.#stateStore.getSession(authority.workSessionId);
    const managedLease = session?.attempts.find(
      (attempt) => attempt.id === authority.attemptId,
    )?.workspaceLease;
    if (
      session === null ||
      session.controller.generation !== authority.controllerGeneration ||
      managedLease?.mode !== "managed" ||
      managedLease.phase !== "ready" ||
      managedLease.controllerGeneration !== authority.controllerGeneration ||
      path.resolve(managedLease.path) !== path.resolve(input.workspace.path)
    ) {
      throw new SymphonyError(
        "preparation_refused",
        "pnpm preparation requires the attempt's ready managed workspace lease",
      );
    }
    const cachePath = this.#cachePath(
      input.config,
      authority.workSessionId,
      authority.attemptId,
    );
    const homePath = path.join(cachePath, "home");
    const storePath = path.join(cachePath, "store");
    const temporaryPath = path.join(cachePath, "tmp");
    const userConfig = path.join(cachePath, "empty-npmrc");
    const args = [
      "install",
      "--offline",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--ignore-pnpmfile",
      "--no-runtime",
      "--verify-store-integrity",
      "--trust-lockfile",
      "--package-import-method=copy",
      "--force",
      "--store-dir",
      "/cache/store",
    ];
    const recordedCommand = [
      preparationAuthority.nodeExecutable,
      preparationAuthority.pnpmEntryPoint,
      ...args,
    ];

    let manifestDigest: string | null = null;
    let lockfileDigest: string | null = null;
    let inputDigest: string | null = null;
    let preflightError: string | null = null;
    try {
      await verifySeedStore(dependencyPolicy.seedStoreRoot);
      const inspection = await inspectPnpmInputs(
        input.workspace.path,
        dependencyPolicy.pnpmVersion,
      );
      manifestDigest = inspection.manifestDigest;
      lockfileDigest = inspection.lockfileDigest;
      inputDigest = inspection.inputDigest;
    } catch (error) {
      preflightError = errorMessage(error);
    }

    const started = this.#stateStore.startPreparation({
      sessionId: authority.workSessionId,
      attemptId: authority.attemptId,
      runtimeLeaseToken: authority.runtimeLeaseToken,
      controllerGeneration: authority.controllerGeneration,
      command: recordedCommand,
      manifestDigest,
      lockfileDigest,
      inputDigest,
      dependencyPolicy,
      cachePath,
      now: this.#timestamp(),
    });
    const preparation = started.attempts.find(
      (attempt) => attempt.id === authority.attemptId,
    )?.preparation;
    if (preparation?.status === "succeeded") return;

    if (preflightError !== null) {
      this.#finish(input, "setup_refused", preflightError);
      throw new SymphonyError("preparation_refused", preflightError);
    }

    const controller = new AbortController();
    const forwardAbort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", forwardAbort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error("preparation timed out")),
      input.config.preparation.timeoutMs,
    );
    try {
      await ensurePrivateDirectory(this.#preparationRoot(input.config));
      await ensurePrivateDirectory(path.dirname(cachePath));
      await ensurePrivateDirectory(cachePath);
      await Promise.all([
        ensurePrivateDirectory(homePath),
        ensurePrivateDirectory(temporaryPath),
      ]);
      await prepareAttemptStore(dependencyPolicy.seedStoreRoot, storePath);
      await writeFile(
        userConfig,
        [
          `registry=${dependencyPolicy.registry}`,
          "offline=true",
          "ignore-scripts=true",
          "ignore-pnpmfile=true",
          "verify-store-integrity=true",
          "",
        ].join("\n"),
        { encoding: "utf8", mode: 0o600 },
      );
      await chmod(userConfig, 0o600);
      const sandbox = await sandboxInvocation(
        preparationAuthority.sandboxExecutable,
        preparationAuthority.nodeExecutable,
        preparationAuthority.pnpmEntryPoint,
        args,
        {
          cachePath,
          environment: this.#processEnvironment,
          registry: dependencyPolicy.registry,
          seedStoreRoot: dependencyPolicy.seedStoreRoot,
          workspacePath: input.workspace.path,
        },
      );
      const result = await execute(sandbox.executable, sandbox.args, {
        cwd: input.workspace.path,
        environment: sandbox.environment,
        signal: controller.signal,
      });
      if (result.aborted) {
        const reason =
          input.signal?.aborted === true
            ? "preparation interrupted by attempt cancellation"
            : `preparation timed out after ${input.config.preparation.timeoutMs}ms`;
        const output = safeOutput(
          `${result.stderr}\n${result.stdout}`,
          this.#processEnvironment,
          input.config.secretEnvironmentNames,
        );
        const message = `${reason}${output === "" ? "" : `: ${output}`}`;
        this.#finish(input, "interrupted", message);
        throw new SymphonyError("preparation_failed", message);
      }
      if (result.exitCode !== 0) {
        const output = safeOutput(
          `${result.stderr}\n${result.stdout}`,
          this.#processEnvironment,
          input.config.secretEnvironmentNames,
        );
        const message = `pnpm preparation exited with status ${result.exitCode}${output === "" ? "" : `: ${output}`}`;
        this.#finish(input, "failed", message);
        throw new SymphonyError("preparation_failed", message);
      }
      const postflight = await inspectPnpmInputs(
        input.workspace.path,
        dependencyPolicy.pnpmVersion,
      );
      if (
        postflight.manifestDigest !== manifestDigest ||
        postflight.lockfileDigest !== lockfileDigest ||
        postflight.inputDigest !== inputDigest
      ) {
        throw new SymphonyError(
          "preparation_refused",
          "Product-controlled pnpm inputs changed during preparation",
        );
      }
      this.#finish(input, "succeeded", null);
      this.#logger.info("preparation outcome=succeeded", {
        work_session_id: authority.workSessionId,
        attempt_id: authority.attemptId,
        driver: "pnpm",
      });
    } catch (error) {
      const current = this.#stateStore.getSession(authority.workSessionId);
      const status = current?.attempts.find(
        (attempt) => attempt.id === authority.attemptId,
      )?.preparation?.status;
      if (status === "running") {
        this.#finish(
          input,
          error instanceof SymphonyError && error.code === "preparation_refused"
            ? "setup_refused"
            : "failed",
          errorMessage(error),
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", forwardAbort);
    }
  }

  async cleanup(
    authority: RepositoryCleanupAuthority | undefined,
    config: WorkspaceLifecycleConfig,
  ): Promise<void> {
    if (config.preparation.driver !== "pnpm" || authority === undefined) {
      return;
    }
    const session = this.#stateStore.getSession(authority.workSessionId);
    if (session === null) {
      throw new SymphonyError(
        "preparation_refused",
        `Cannot clean preparation state for missing WorkSession ${authority.workSessionId}`,
      );
    }
    if (
      session.controller.generation !== authority.controllerGeneration ||
      session.attempts.some(
        (attempt) => attempt.runtimeLease.status === "active",
      )
    ) {
      throw new SymphonyError(
        "preparation_refused",
        `Cannot clean preparation state for stale or active WorkSession ${authority.workSessionId}`,
      );
    }
    const sessionPath = path.join(this.#preparationRoot(config), session.id);
    for (const attempt of session.attempts) {
      const recorded = attempt.preparation?.cachePath;
      if (recorded === undefined) continue;
      const expected = this.#cachePath(config, session.id, attempt.id);
      if (path.resolve(recorded) !== expected) {
        throw new SymphonyError(
          "preparation_refused",
          `Preparation cache ${recorded} does not match its fenced attempt`,
        );
      }
    }
    if (!strictChild(this.#preparationRoot(config), sessionPath)) {
      throw new SymphonyError(
        "preparation_refused",
        `Preparation cleanup path ${sessionPath} is outside its root`,
      );
    }
    let sessionEntry;
    try {
      sessionEntry = await lstat(sessionPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!sessionEntry.isDirectory() || sessionEntry.isSymbolicLink()) {
      throw new SymphonyError(
        "preparation_refused",
        `Preparation cleanup path ${sessionPath} is not a real directory`,
      );
    }
    const [realRoot, realSession] = await Promise.all([
      realpath(this.#preparationRoot(config)),
      realpath(sessionPath),
    ]);
    if (!strictChild(realRoot, realSession)) {
      throw new SymphonyError(
        "preparation_refused",
        `Resolved preparation cleanup path ${realSession} escaped ${realRoot}`,
      );
    }
    await rm(sessionPath, { recursive: true, force: true });
  }

  #finish(
    input: PreparationInput,
    status: "failed" | "interrupted" | "setup_refused" | "succeeded",
    error: string | null,
  ): void {
    const authority = input.authority!;
    this.#stateStore.finishPreparation({
      sessionId: authority.workSessionId,
      attemptId: authority.attemptId,
      runtimeLeaseToken: authority.runtimeLeaseToken,
      controllerGeneration: authority.controllerGeneration,
      status,
      error,
      now: this.#timestamp(),
    });
  }

  #preparationRoot(config: WorkspaceLifecycleConfig): string {
    return path.resolve(
      config.deployment?.stateRoot ??
        path.join(config.workspace.root, ".symphony"),
      "preparation",
    );
  }

  #cachePath(
    config: WorkspaceLifecycleConfig,
    workSessionId: string,
    attemptId: string,
  ): string {
    const root = this.#preparationRoot(config);
    const candidate = path.resolve(root, workSessionId, attemptId);
    if (!strictChild(root, candidate)) {
      throw new SymphonyError(
        "preparation_refused",
        "Preparation cache path escaped its state root",
      );
    }
    return candidate;
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }
}
