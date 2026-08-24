#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { AgentRunner } from "./agent/runner.js";
import { errorMessage } from "./errors.js";
import { JsonLineLogger, type Logger } from "./observability/logger.js";
import {
  Orchestrator,
  type RuntimeSnapshot,
} from "./orchestrator/orchestrator.js";
import { DefaultTrackerFactory } from "./tracker/factory.js";
import {
  GITHUB_PROJECTS_TRACKER_KIND,
  githubProjectsConfigProfile,
} from "./tracker/github-projects/profile.js";
import { selectWorkflowPath } from "./workflow/loader.js";
import { WorkflowStore } from "./workflow/store.js";
import { SYMPHONY_VERSION } from "./version.js";

const USAGE = `Usage: symphony [path-to-WORKFLOW.md]

Run one long-lived Symphony daemon for one repository workflow.

Options:
  -h, --help       Show this help
  -v, --version    Show the version
`;

type CliArguments =
  | { readonly action: "help" }
  | { readonly action: "version" }
  | { readonly action: "run"; readonly workflowPath: string | undefined };

export interface DaemonHost {
  snapshot(): RuntimeSnapshot;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface DaemonHostFactoryOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly logger: Logger;
  readonly workflowPath: string;
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
}

export function parseCliArguments(argv: readonly string[]): CliArguments {
  let workflowPath: string | undefined;
  for (const argument of argv) {
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
    if (argument.startsWith("-")) {
      throw new Error(`unknown option '${argument}'`);
    }
    if (workflowPath !== undefined) {
      throw new Error("expected at most one workflow path");
    }
    workflowPath = argument;
  }
  return { action: "run", workflowPath };
}

export async function buildDaemonHost(
  options: DaemonHostFactoryOptions,
): Promise<DaemonHost> {
  let orchestrator: Orchestrator | null = null;
  const trackerProfiles = new Map([
    [GITHUB_PROJECTS_TRACKER_KIND, githubProjectsConfigProfile],
  ]);
  const workflowStore = new WorkflowStore({
    workflowPath: options.workflowPath,
    trackerProfiles,
    environment: options.environment,
    logger: options.logger,
    onReload: () => {
      void orchestrator?.tick().catch((error: unknown) => {
        options.logger.error("workflow_reapply outcome=failed", {
          error: errorMessage(error),
          workflow_path: options.workflowPath,
        });
      });
    },
  });
  await workflowStore.loadInitial();

  const trackerFactory = new DefaultTrackerFactory({
    environment: options.environment,
    logger: options.logger,
  });
  trackerFactory.create(workflowStore.current);
  orchestrator = new Orchestrator({
    agentRunner: new AgentRunner({
      logger: options.logger,
      processEnvironment: options.environment,
    }),
    logger: options.logger,
    trackerFactory: (workflow) => trackerFactory.create(workflow),
    workflowStore,
  });
  return orchestrator;
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
  if (parsed.action === "version") {
    stdout.write(`symphony ${SYMPHONY_VERSION}\n`);
    return 0;
  }

  const cwd = dependencies.cwd ?? process.cwd();
  const environment = dependencies.environment ?? process.env;
  const logger = dependencies.logger ?? new JsonLineLogger();
  const workflowPath = selectWorkflowPath(parsed.workflowPath, cwd);
  const hostFactory = dependencies.hostFactory ?? buildDaemonHost;
  let host: DaemonHost | null = null;
  try {
    host = await hostFactory({ environment, logger, workflowPath });
    await host.start();
    logger.info("service outcome=started", {
      pid: process.pid,
      workflow_path: workflowPath,
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
      workflow_path: workflowPath,
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
