import type { Issue } from "../domain/issue.js";
import { errorMessage } from "../errors.js";
import { nullLogger, type Logger } from "../observability/logger.js";
import type { TrackerAdapter } from "../tracker/adapter.js";
import { issueRoutable, normalizedTrackerValue } from "../tracker/routing.js";
import { renderPrompt } from "../workflow/prompt.js";
import type { WorkflowSnapshot } from "../workflow/store.js";
import {
  WorkspaceManager,
  type Workspace,
  type WorkspaceLifecycleConfig,
} from "../workspace/manager.js";
import {
  CodexAppServerSession,
  type CodexAppServerSessionOptions,
  type CodexTurnResult,
} from "./app-server-client.js";
import { AgentError } from "./errors.js";
import type { AgentEventHandler } from "./events.js";

export interface LiveCodexSession {
  readonly pid: number | undefined;
  readonly threadId: string;
  runTurn(input: string): Promise<CodexTurnResult>;
  close(): Promise<void>;
}

export type CodexSessionFactory = (
  options: CodexAppServerSessionOptions,
) => Promise<LiveCodexSession>;

export interface AgentRunOptions {
  readonly attempt: number | null;
  readonly freshAttemptGeneration: string | null;
  readonly issue: Issue;
  readonly onEvent?: AgentEventHandler;
  readonly signal?: AbortSignal;
  readonly tracker: TrackerAdapter;
  readonly workflow: WorkflowSnapshot;
}

export interface AgentRunResult {
  readonly finalIssue: Issue | null;
  readonly lastTurn: CodexTurnResult;
  readonly turns: number;
  readonly workspace: Workspace;
}

export interface AgentRunnerOptions {
  readonly logger?: Logger;
  readonly processEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly sessionFactory?: CodexSessionFactory;
  readonly workspaceManager?: WorkspaceManager;
}

export function continuationPrompt(
  issue: Issue,
  turnNumber: number,
  maxTurns: number,
): string {
  return [
    `Continue working on ${issue.identifier}: ${issue.title}.`,
    `This is continuation turn ${turnNumber} of ${maxTurns} in the same thread.`,
    "Re-read the current workspace and durable tracker workpad, finish the remaining acceptance criteria, validate the result, and update the workpad or status with the available provider tools.",
    "Do not repeat work that is already complete, and do not wait for interactive user input.",
  ].join("\n");
}

function issueActive(issue: Issue, activeStates: readonly string[]): boolean {
  const active = new Set(activeStates.map(normalizedTrackerValue));
  return active.has(normalizedTrackerValue(issue.state));
}

function stateIncluded(state: string, configured: readonly string[]): boolean {
  const normalizedState = normalizedTrackerValue(state);
  return configured.some(
    (candidate) => normalizedTrackerValue(candidate) === normalizedState,
  );
}

function cancellationError(): AgentError {
  return new AgentError(
    "turn_cancelled",
    "Agent run was cancelled by orchestration reconciliation",
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw cancellationError();
}

/** Workspace + prompt + one live Codex session with bounded continuations. */
export class AgentRunner {
  readonly #logger: Logger;
  readonly #processEnvironment: Readonly<Record<string, string | undefined>>;
  readonly #sessionFactory: CodexSessionFactory;
  readonly #workspaceManager: WorkspaceManager;

  constructor(options: AgentRunnerOptions = {}) {
    this.#logger = options.logger ?? nullLogger;
    this.#processEnvironment = options.processEnvironment ?? process.env;
    this.#sessionFactory =
      options.sessionFactory ??
      ((sessionOptions) => CodexAppServerSession.start(sessionOptions));
    this.#workspaceManager =
      options.workspaceManager ??
      new WorkspaceManager({
        logger: this.#logger,
        processEnvironment: this.#processEnvironment,
      });
  }

  async cleanupWorkspace(
    issue: Issue,
    workflow: WorkflowSnapshot,
  ): Promise<void> {
    await this.#workspaceManager.remove(issue, {
      hooks: workflow.config.hooks,
      secretEnvironmentNames: workflow.config.tracker.secretEnvironmentNames,
      workflowPath: workflow.path,
      workspace: workflow.config.workspace,
    });
  }

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const { config } = options.workflow;
    const lifecycle: WorkspaceLifecycleConfig = {
      hooks: config.hooks,
      secretEnvironmentNames: config.tracker.secretEnvironmentNames,
      workflowPath: options.workflow.path,
      workspace: config.workspace,
    };
    let workspace: Workspace | null = null;
    let session: LiveCodexSession | null = null;
    let lastSessionId: string | null = null;
    let runStatus = "failed";
    const onAbort = () => {
      if (session !== null) void session.close().catch(() => undefined);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      throwIfAborted(options.signal);
      const requiresFreshAttempt = stateIncluded(
        options.issue.state,
        config.tracker.freshAttemptStates,
      );
      if (requiresFreshAttempt) {
        if (options.freshAttemptGeneration === null) {
          throw new AgentError(
            "fresh_attempt_refused",
            `Issue ${options.issue.identifier} has no stable tracker state version for fresh-attempt provisioning`,
          );
        }
        const control = options.tracker.freshAttemptControl?.(options.issue);
        if (control === undefined) {
          throw new AgentError(
            "fresh_attempt_refused",
            "Tracker adapter does not implement fresh-attempt workpad reset",
          );
        }
        try {
          const preparation = await this.#workspaceManager.prepareFreshAttempt(
            options.issue,
            lifecycle,
            options.freshAttemptGeneration,
          );
          workspace = preparation.workspace;
          if (preparation.resetWorkpad) {
            await control.resetWorkpad();
            await this.#workspaceManager.markFreshAttemptReady(
              options.issue,
              lifecycle,
              options.freshAttemptGeneration,
            );
          }
        } catch (error) {
          if (
            error instanceof AgentError &&
            error.code === "fresh_attempt_refused"
          ) {
            throw error;
          }
          throw new AgentError(
            "fresh_attempt_refused",
            `Fresh-attempt provisioning failed: ${errorMessage(error)}`,
            { cause: error },
          );
        }
      } else {
        workspace = await this.#workspaceManager.prepare(
          options.issue,
          lifecycle,
        );
      }
      await this.#workspaceManager.beforeRun(
        options.issue,
        workspace,
        lifecycle,
        {
          attempt: options.attempt,
          ...(options.freshAttemptGeneration === null
            ? {}
            : { generation: options.freshAttemptGeneration }),
        },
      );
      await this.#workspaceManager.assertAgentLaunchCwd(
        workspace,
        lifecycle,
        workspace.path,
      );
      throwIfAborted(options.signal);

      const firstPrompt = await renderPrompt(
        options.workflow.definition.promptTemplate,
        options.issue,
        options.attempt,
      );
      const toolRuntime =
        options.tracker.agentToolRuntime?.(options.issue) ?? null;
      session = await this.#sessionFactory({
        command: config.codex.command,
        cwd: workspace.path,
        readTimeoutMs: config.codex.readTimeoutMs,
        turnTimeoutMs: config.codex.turnTimeoutMs,
        adapterSecretEnvironmentNames: config.tracker.secretEnvironmentNames,
        approvalPolicy: config.codex.approvalPolicy,
        environment: this.#processEnvironment,
        logger: this.#logger,
        ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
        threadSandbox: config.codex.threadSandbox,
        title: `${options.issue.identifier}: ${options.issue.title}`,
        toolRuntime,
        turnSandboxPolicy: config.codex.turnSandboxPolicy,
      });
      throwIfAborted(options.signal);

      let currentIssue: Issue | null = options.issue;
      let lastTurn: CodexTurnResult | null = null;
      let turnNumber = 1;
      while (currentIssue !== null) {
        throwIfAborted(options.signal);
        const prompt =
          turnNumber === 1
            ? firstPrompt
            : continuationPrompt(
                currentIssue,
                turnNumber,
                config.agent.maxTurns,
              );
        lastTurn = await session.runTurn(prompt);
        lastSessionId = lastTurn.sessionId;

        const refreshed = await options.tracker.fetchIssuesByIds([
          currentIssue.id,
        ]);
        currentIssue =
          refreshed.find((candidate) => candidate.id === currentIssue?.id) ??
          null;
        if (
          currentIssue === null ||
          !issueActive(currentIssue, config.tracker.activeStates) ||
          !issueRoutable(
            currentIssue,
            config.tracker.requiredLabels,
            config.tracker.excludedLabels,
          ) ||
          turnNumber >= config.agent.maxTurns
        ) {
          break;
        }
        turnNumber += 1;
      }

      if (lastTurn === null) {
        throw new AgentError(
          "turn_failed",
          "Agent run ended before starting a Codex turn",
        );
      }
      runStatus = "succeeded";
      return {
        finalIssue: currentIssue,
        lastTurn,
        turns: turnNumber,
        workspace,
      };
    } catch (error) {
      if (options.signal?.aborted === true) {
        runStatus = "cancelled";
        throw cancellationError();
      }
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      if (session !== null) {
        try {
          await session.close();
        } catch (error) {
          this.#logger.warn("Failed to close Codex app-server session", {
            issue_id: options.issue.id,
            issue_identifier: options.issue.identifier,
            session_id: lastSessionId,
            error: errorMessage(error),
          });
        }
      }
      if (workspace !== null) {
        try {
          await this.#workspaceManager.afterRun(
            options.issue,
            workspace,
            lifecycle,
            {
              attempt: options.attempt,
              ...(options.freshAttemptGeneration === null
                ? {}
                : { generation: options.freshAttemptGeneration }),
              status: runStatus,
            },
          );
        } catch (error) {
          this.#logger.warn(
            "Ignoring after_run workspace finalization failure",
            {
              issue_id: options.issue.id,
              issue_identifier: options.issue.identifier,
              session_id: lastSessionId,
              error: errorMessage(error),
            },
          );
        }
      }
    }
  }
}
