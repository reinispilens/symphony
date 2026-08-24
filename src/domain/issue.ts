import type { JsonObject } from "../shared/json.js";

export interface BlockerRef {
  readonly id: string | null;
  readonly identifier: string | null;
  readonly state: string | null;
}

/** The provider-neutral issue record from SPEC section 4.1.1. */
export interface Issue {
  readonly id: string;
  readonly native_ref: JsonObject | null;
  readonly identifier: string;
  readonly title: string;
  readonly description: string | null;
  readonly priority: number | null;
  readonly state: string;
  /**
   * Opaque tracker-owned version of the current workflow-state assignment.
   * A new value means the issue entered (or re-entered) its current state.
   */
  readonly state_version: string | null;
  readonly branch_name: string | null;
  readonly url: string | null;
  readonly assignee_id: string | null;
  readonly labels: readonly string[];
  readonly blocked_by: readonly BlockerRef[];
  readonly dispatchable: boolean;
  readonly created_at: Date | null;
  readonly updated_at: Date | null;
}

export function issueForTemplate(issue: Issue): Record<string, unknown> {
  return {
    ...issue,
    created_at: issue.created_at?.toISOString() ?? null,
    updated_at: issue.updated_at?.toISOString() ?? null,
  };
}
