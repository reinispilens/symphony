import type { Issue } from "../domain/issue.js";
import type { AgentToolRuntime } from "../agent/tools.js";

export interface FreshAttemptControl {
  /** Delete the managed workpad while leaving ordinary review comments intact. */
  resetWorkpad(): Promise<void>;
  /** Persist a blocker workpad, then move the card to the configured human lane. */
  refuse(reason: string, failureState: string): Promise<void>;
}

export interface TrackerAdapter {
  fetchIssuesByStates(stateNames: readonly string[]): Promise<readonly Issue[]>;
  fetchIssuesByIds(issueIds: readonly string[]): Promise<readonly Issue[]>;
  agentToolRuntime?(issue: Issue): AgentToolRuntime;
  freshAttemptControl?(issue: Issue): FreshAttemptControl;
}
