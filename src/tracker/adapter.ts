import type { Issue } from "../domain/issue.js";
import type { AgentToolRuntime } from "../agent/tools.js";

export interface FreshAttemptControl {
  /** Delete the managed workpad while leaving ordinary review comments intact. */
  resetWorkpad(): Promise<void>;
  /** Persist a blocker workpad, then move the card to the configured human lane. */
  refuse(reason: string, failureState: string): Promise<void>;
}

export interface TrackerStateControl {
  /** Compare current provider truth, then select one policy-authorized lane. */
  transition(
    targetState: string,
    expectedStateVersion: string | null,
  ): Promise<Issue>;
}

export interface TrackerAgentToolContext {
  readonly freshAttempt: boolean;
  /**
   * Exact non-terminal lanes the accepted WorkSession policy permits the
   * candidate agent to select. Absent only for compatibility deployments.
   */
  readonly statusTargets?: readonly string[];
}

export interface TrackerAdapter {
  fetchIssuesByStates(stateNames: readonly string[]): Promise<readonly Issue[]>;
  fetchIssuesByIds(issueIds: readonly string[]): Promise<readonly Issue[]>;
  agentToolRuntime?(
    issue: Issue,
    context?: TrackerAgentToolContext,
  ): AgentToolRuntime;
  freshAttemptControl?(issue: Issue): FreshAttemptControl;
  stateControl?(issue: Issue): TrackerStateControl;
}
