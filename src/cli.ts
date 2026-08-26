#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import { AgentRunner } from "./agent/runner.js";
import { DeliveryCoordinator } from "./delivery/coordinator.js";
import { TrustedDeliveryExecution } from "./delivery/execution.js";
import { TrustedSourceMaterializer } from "./delivery/materializer.js";
import { ExternalDeliveryProvider } from "./delivery/provider.js";
import { resolveDeploymentBinding } from "./deployment/resolver.js";
import { errorMessage, SymphonyError } from "./errors.js";
import {
  executeManualWorkCommand,
  type ManualWorkCommand,
  type ManualWorkCommandRunner,
} from "./interactive/command.js";
import { JsonLineLogger, type Logger } from "./observability/logger.js";
import { RoutingPreparationDriver } from "./preparation/driver.js";
import { PnpmPreparationDriver } from "./preparation/pnpm-driver.js";
import {
  GitWorktreeRepositoryDriver,
  preflightManagedGitHost,
} from "./repository/git-worktree-driver.js";
import { RoutingRepositoryDriver } from "./repository/routing-driver.js";
import {
  Orchestrator,
  type RuntimeSnapshot,
  type WorkflowSource,
} from "./orchestrator/orchestrator.js";
import {
  SqliteSymphonyStateStore,
  stateDatabasePath,
  stateDatabasePathFromStateRoot,
} from "./state/sqlite-store.js";
import { DefaultTrackerFactory } from "./tracker/factory.js";
import {
  GITHUB_PROJECTS_TRACKER_KIND,
  githubProjectsConfigProfile,
} from "./tracker/github-projects/profile.js";
import { selectWorkflowPath } from "./workflow/loader.js";
import { PinnedWorkflowStore, WorkflowStore } from "./workflow/store.js";
import { WorkspaceManager } from "./workspace/manager.js";
import { SYMPHONY_VERSION } from "./version.js";

const USAGE = `Usage: symphony [path-to-WORKFLOW.md]
       symphony --binding path-to-deployment-binding.json
       symphony work <command> [options]

Run one long-lived Symphony daemon for one repository binding or compatibility workflow.
Use 'symphony work --help' for durable human-controlled WorkSessions.

Managed deployments use an operator-owned binding. Positional WORKFLOW.md is
the compatibility path for existing directory/harness consumers.

Options:
  -h, --help       Show this help
  -v, --version    Show the version
`;

const WORK_USAGE = `Usage: symphony work start  --binding <absolute-path> --intent <text>
       symphony work attach --binding <absolute-path> --session <id> --expected-revision <n> --path <absolute-checkout>
       symphony work plan   --binding <absolute-path> --session <id> --expected-revision <n> --file <plan.md>
       symphony work steer  --binding <absolute-path> --session <id> --expected-revision <n> --message <text>
       symphony work status --binding <absolute-path> --session <id> [--json]

Create and steer one boardless WorkSession in the existing binding-owned state store.
Every invocation revalidates the same exact operator binding. These commands do not
start an agent, create a managed workspace, run product code, or mutate a tracker.
`;

type CliArguments =
  | { readonly action: "help" }
  | { readonly action: "work-help" }
  | { readonly action: "version" }
  | { readonly action: "work"; readonly command: ManualWorkCommand }
  | {
      readonly action: "run";
      readonly source:
        | { readonly kind: "binding"; readonly path: string }
        | { readonly kind: "workflow"; readonly path: string | undefined };
    };

export type DaemonSource =
  | { readonly kind: "binding"; readonly path: string }
  | { readonly kind: "workflow"; readonly path: string };

export interface DaemonHost {
  snapshot(): RuntimeSnapshot;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface DaemonHostFactoryOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly logger: Logger;
  readonly source: DaemonSource;
}

export type DaemonHostFactory = (
  options: DaemonHostFactoryOptions,
) => Promise<DaemonHost>;

export interface CliDependencies {
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly hostFactory?: DaemonHostFactory;
  readonly logger?: Logger;
  readonly stderr?: Pick<NodeJS.WritableStream, "write">;
  readonly stdout?: Pick<NodeJS.WritableStream, "write">;
  readonly waitForShutdown?: () => Promise<string>;
  readonly workCommandRunner?: ManualWorkCommandRunner;
}

function workOptionMap(
  argv: readonly string[],
  allowedValues: readonly string[],
  allowedFlags: readonly string[] = [],
): {
  readonly flags: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, string>;
} {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]!;
    if (allowedFlags.includes(option)) {
      if (flags.has(option))
        throw new Error(`${option} may be specified only once`);
      flags.add(option);
      continue;
    }
    if (!allowedValues.includes(option)) {
      throw new Error(`unknown work option '${option}'`);
    }
    if (values.has(option))
      throw new Error(`${option} may be specified only once`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${option} requires a value`);
    }
    if (value.trim() === "") throw new Error(`${option} must not be blank`);
    values.set(option, value);
    index += 1;
  }
  return { flags, values };
}

function requiredWorkOption(
  options: ReadonlyMap<string, string>,
  name: string,
): string {
  const value = options.get(name);
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

function absoluteWorkPath(value: string, option: string): string {
  if (!path.isAbsolute(value) || /[\0\r\n]/u.test(value)) {
    throw new Error(`${option} must be an absolute path`);
  }
  return path.resolve(value);
}

function expectedRevision(options: ReadonlyMap<string, string>): number {
  const source = requiredWorkOption(options, "--expected-revision");
  if (!/^[1-9]\d*$/u.test(source)) {
    throw new Error("--expected-revision must be an integer >= 1");
  }
  const revision = Number(source);
  if (!Number.isSafeInteger(revision)) {
    throw new Error("--expected-revision must be a safe integer");
  }
  return revision;
}

function parseWorkArguments(argv: readonly string[]): CliArguments {
  if (
    argv.length === 0 ||
    (argv.length === 1 && (argv[0] === "-h" || argv[0] === "--help"))
  ) {
    return { action: "work-help" };
  }
  const command = argv[0]!;
  const remaining = argv.slice(1);
  const binding = (options: ReadonlyMap<string, string>) =>
    absoluteWorkPath(requiredWorkOption(options, "--binding"), "--binding");
  const session = (options: ReadonlyMap<string, string>) =>
    requiredWorkOption(options, "--session");

  switch (command) {
    case "start": {
      const parsed = workOptionMap(remaining, ["--binding", "--intent"]);
      return {
        action: "work",
        command: {
          action: "start",
          bindingPath: binding(parsed.values),
          intent: requiredWorkOption(parsed.values, "--intent"),
        },
      };
    }
    case "attach": {
      const parsed = workOptionMap(remaining, [
        "--binding",
        "--session",
        "--expected-revision",
        "--path",
      ]);
      return {
        action: "work",
        command: {
          action: "attach",
          bindingPath: binding(parsed.values),
          sessionId: session(parsed.values),
          expectedRevision: expectedRevision(parsed.values),
          path: absoluteWorkPath(
            requiredWorkOption(parsed.values, "--path"),
            "--path",
          ),
        },
      };
    }
    case "plan": {
      const parsed = workOptionMap(remaining, [
        "--binding",
        "--session",
        "--expected-revision",
        "--file",
      ]);
      return {
        action: "work",
        command: {
          action: "plan",
          bindingPath: binding(parsed.values),
          sessionId: session(parsed.values),
          expectedRevision: expectedRevision(parsed.values),
          filePath: requiredWorkOption(parsed.values, "--file"),
        },
      };
    }
    case "steer": {
      const parsed = workOptionMap(remaining, [
        "--binding",
        "--session",
        "--expected-revision",
        "--message",
      ]);
      return {
        action: "work",
        command: {
          action: "steer",
          bindingPath: binding(parsed.values),
          sessionId: session(parsed.values),
          expectedRevision: expectedRevision(parsed.values),
          message: requiredWorkOption(parsed.values, "--message"),
        },
      };
    }
    case "status": {
      const parsed = workOptionMap(
        remaining,
        ["--binding", "--session"],
        ["--json"],
      );
      return {
        action: "work",
        command: {
          action: "status",
          bindingPath: binding(parsed.values),
          sessionId: session(parsed.values),
          json: parsed.flags.has("--json"),
        },
      };
    }
    default:
      throw new Error(`unknown work command '${command}'`);
  }
}

export function parseCliArguments(argv: readonly string[]): CliArguments {
  if (argv[0] === "work") return parseWorkArguments(argv.slice(1));
  let workflowPath: string | undefined;
  let bindingPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "-h" || argument === "--help") {
      if (argv.length !== 1)
        throw new Error("--help cannot be combined with other arguments");
      return { action: "help" };
    }
    if (argument === "-v" || argument === "--version") {
      if (argv.length !== 1) {
        throw new Error("--version cannot be combined with other arguments");
      }
      return { action: "version" };
    }
    if (argument === "--binding") {
      if (bindingPath !== undefined) {
        throw new Error("--binding may be specified only once");
      }
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("--binding requires a path");
      }
      bindingPath = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`unknown option '${argument}'`);
    }
    if (workflowPath !== undefined) {
      throw new Error("expected at most one workflow path");
    }
    workflowPath = argument;
  }
  if (bindingPath !== undefined && workflowPath !== undefined) {
    throw new Error("--binding cannot be combined with a workflow path");
  }
  return {
    action: "run",
    source:
      bindingPath === undefined
        ? { kind: "workflow", path: workflowPath }
        : { kind: "binding", path: bindingPath },
  };
}

export async function buildDaemonHost(
  options: DaemonHostFactoryOptions,
): Promise<DaemonHost> {
  let orchestrator: Orchestrator | null = null;
  const trackerProfiles = new Map([
    [GITHUB_PROJECTS_TRACKER_KIND, githubProjectsConfigProfile],
  ]);
  let workflowStore: WorkflowSource;
  if (options.source.kind === "binding") {
    const deployment = await resolveDeploymentBinding({
      bindingPath: options.source.path,
      trackerProfiles,
      environment: options.environment,
    });
    workflowStore = new PinnedWorkflowStore(deployment.workflow);
  } else {
    const reloadable = new WorkflowStore({
      workflowPath: options.source.path,
      trackerProfiles,
      environment: options.environment,
      logger: options.logger,
      onReload: () => {
        void orchestrator?.tick().catch((error: unknown) => {
          options.logger.error("workflow_reapply outcome=failed", {
            error: errorMessage(error),
            workflow_path: options.source.path,
          });
        });
      },
    });
    await reloadable.loadInitial();
    workflowStore = reloadable;
    if (workflowStore.current.config.workspace.provider === "git-worktree") {
      workflowStore.close();
      throw new SymphonyError(
        "deployment_binding_refused",
        "Managed Git worktrees require an operator-owned deployment binding; positional WORKFLOW.md is compatibility-only",
      );
    }
  }

  const trackerFactory = new DefaultTrackerFactory({
    environment: options.environment,
    logger: options.logger,
  });
  trackerFactory.create(workflowStore.current);
  await preflightManagedGitHost({
    deployment: workflowStore.current.config.deployment,
    repository: workflowStore.current.config.repository,
    workflowPath: workflowStore.current.path,
    workspace: workflowStore.current.config.workspace,
  });
  const stateStore = SqliteSymphonyStateStore.open(
    workflowStore.current.config.deployment === null
      ? stateDatabasePath(workflowStore.current.config.workspace.root)
      : stateDatabasePathFromStateRoot(
          workflowStore.current.config.deployment.stateRoot,
        ),
  );
  const repositoryDriver = new RoutingRepositoryDriver({
    compatibility: new WorkspaceManager({
      logger: options.logger,
      processEnvironment: options.environment,
    }),
    managedGit: new GitWorktreeRepositoryDriver({
      logger: options.logger,
      stateStore,
    }),
  });
  const preparationDriver = new RoutingPreparationDriver({
    pnpm: new PnpmPreparationDriver({
      logger: options.logger,
      processEnvironment: options.environment,
      stateStore,
    }),
  });
  const agentRunner = new AgentRunner({
    logger: options.logger,
    preparationDriver,
    processEnvironment: options.environment,
    repositoryDriver,
  });
  const deployment = workflowStore.current.config.deployment;
  const deliveryExecution =
    deployment?.deliveryProvider === null ||
    deployment?.deliveryProvider === undefined
      ? undefined
      : new TrustedDeliveryExecution({
          stateStore,
          workspace: agentRunner,
          materializer: new TrustedSourceMaterializer({
            gitExecutable: deployment.gitExecutable,
            stateRoot: deployment.stateRoot,
            stateStore,
          }),
          coordinator: new DeliveryCoordinator({
            stateStore,
            provider: new ExternalDeliveryProvider({
              executable: deployment.deliveryProvider.executable,
              timeoutMs: deployment.deliveryProvider.timeoutMs,
              secretEnvironmentNames:
                deployment.deliveryProvider.secretEnvironmentNames,
              environment: options.environment,
              gitExecutable: deployment.gitExecutable,
              githubHostname:
                typeof workflowStore.current.config.tracker.provider[
                  "hostname"
                ] === "string"
                  ? workflowStore.current.config.tracker.provider["hostname"]
                  : "github.com",
            }),
          }),
        });
  const hostOrchestrator = new Orchestrator({
    agentRunner,
    ...(deliveryExecution === undefined ? {} : { deliveryExecution }),
    logger: options.logger,
    stateStore,
    trackerFactory: (workflow) => trackerFactory.create(workflow),
    workflowStore,
  });
  orchestrator = hostOrchestrator;
  return {
    snapshot: () => hostOrchestrator.snapshot(),
    start: () => hostOrchestrator.start(),
    stop: async () => {
      try {
        await hostOrchestrator.stop();
      } finally {
        stateStore.close();
      }
    },
  };
}

function waitForProcessSignal(): Promise<string> {
  return new Promise((resolve) => {
    const finish = (signal: NodeJS.Signals) => {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
      resolve(signal);
    };
    const onInterrupt = () => finish("SIGINT");
    const onTerminate = () => finish("SIGTERM");
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
  });
}

export async function runCli(
  argv: readonly string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  let parsed: CliArguments;
  try {
    parsed = parseCliArguments(argv);
  } catch (error) {
    stderr.write(`symphony: ${errorMessage(error)}\n\n${USAGE}`);
    return 2;
  }

  if (parsed.action === "help") {
    stdout.write(USAGE);
    return 0;
  }
  if (parsed.action === "work-help") {
    stdout.write(WORK_USAGE);
    return 0;
  }
  if (parsed.action === "version") {
    stdout.write(`symphony ${SYMPHONY_VERSION}\n`);
    return 0;
  }

  const cwd = dependencies.cwd ?? process.cwd();
  const environment = dependencies.environment ?? process.env;
  if (parsed.action === "work") {
    const command: ManualWorkCommand =
      parsed.command.action === "plan"
        ? {
            ...parsed.command,
            filePath: path.resolve(cwd, parsed.command.filePath),
          }
        : parsed.command;
    try {
      const result = await (
        dependencies.workCommandRunner ?? executeManualWorkCommand
      )(command, { environment });
      stdout.write(`${result}\n`);
      return 0;
    } catch (error) {
      stderr.write(`symphony work: ${errorMessage(error)}\n`);
      return 1;
    }
  }
  const logger = dependencies.logger ?? new JsonLineLogger();
  const source: DaemonSource =
    parsed.source.kind === "binding"
      ? { kind: "binding", path: path.resolve(cwd, parsed.source.path) }
      : {
          kind: "workflow",
          path: selectWorkflowPath(parsed.source.path, cwd),
        };
  const hostFactory = dependencies.hostFactory ?? buildDaemonHost;
  let host: DaemonHost | null = null;
  try {
    host = await hostFactory({ environment, logger, source });
    await host.start();
    logger.info("service outcome=started", {
      pid: process.pid,
      configuration_kind: source.kind,
      configuration_path: source.path,
    });
    const signal = await (
      dependencies.waitForShutdown ?? waitForProcessSignal
    )();
    logger.info("service action=shutdown_requested", { signal });
    await host.stop();
    logger.info("service outcome=stopped", { signal });
    return 0;
  } catch (error) {
    logger.error("service outcome=failed", {
      error: errorMessage(error),
      configuration_kind: source.kind,
      configuration_path: source.path,
    });
    if (host !== null) {
      try {
        await host.stop();
      } catch (stopError) {
        logger.error("service_stop outcome=failed", {
          error: errorMessage(stopError),
        });
      }
    }
    return 1;
  }
}

const executedPath = process.argv[1];
if (
  executedPath !== undefined &&
  import.meta.url === pathToFileURL(executedPath).href
) {
  process.exitCode = await runCli(process.argv.slice(2));
}
