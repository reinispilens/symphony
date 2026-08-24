import type { Issue } from "../domain/issue.js";
import { issueRoutable, normalizedTrackerValue } from "../tracker/routing.js";
import type { ServiceConfig } from "../workflow/config.js";

export { issueRoutable, normalizedTrackerValue } from "../tracker/routing.js";

export function stateIncluded(
  state: string,
  configuredStates: readonly string[],
): boolean {
  const normalized = normalizedTrackerValue(state);
  return configuredStates.some(
    (candidate) => normalizedTrackerValue(candidate) === normalized,
  );
}

export function issueStructurallyValid(issue: Issue): boolean {
  return [issue.id, issue.identifier, issue.title, issue.state].every(
    (value) => value.trim() !== "",
  );
}

export function issueEligibleByConfig(
  issue: Issue,
  config: ServiceConfig,
): boolean {
  return (
    issueStructurallyValid(issue) &&
    stateIncluded(issue.state, config.tracker.activeStates) &&
    !stateIncluded(issue.state, config.tracker.terminalStates) &&
    issueRoutable(
      issue,
      config.tracker.requiredLabels,
      config.tracker.excludedLabels,
    )
  );
}

function sortablePriority(priority: number | null): number {
  return priority !== null &&
    Number.isInteger(priority) &&
    priority >= 1 &&
    priority <= 4
    ? priority
    : Number.POSITIVE_INFINITY;
}

function sortableCreatedAt(createdAt: Date | null): number {
  if (createdAt === null) return Number.POSITIVE_INFINITY;
  const value = createdAt.valueOf();
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

export function compareIssuesForDispatch(left: Issue, right: Issue): number {
  const leftPriority = sortablePriority(left.priority);
  const rightPriority = sortablePriority(right.priority);
  if (leftPriority !== rightPriority)
    return leftPriority < rightPriority ? -1 : 1;

  const leftCreated = sortableCreatedAt(left.created_at);
  const rightCreated = sortableCreatedAt(right.created_at);
  if (leftCreated !== rightCreated) return leftCreated < rightCreated ? -1 : 1;
  return left.identifier.localeCompare(right.identifier);
}

export function failureRetryDelayMs(
  attempt: number,
  maxRetryBackoffMs: number,
): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new TypeError("retry attempt must be a positive integer");
  }
  if (!Number.isSafeInteger(maxRetryBackoffMs) || maxRetryBackoffMs < 0) {
    throw new TypeError("max retry backoff must be a non-negative integer");
  }
  let delay = Math.min(10_000, maxRetryBackoffMs);
  for (
    let current = 1;
    current < attempt && delay < maxRetryBackoffMs;
    current += 1
  ) {
    delay = Math.min(delay * 2, maxRetryBackoffMs);
  }
  return delay;
}
