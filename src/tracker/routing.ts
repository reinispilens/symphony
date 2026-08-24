import type { Issue } from "../domain/issue.js";

export function normalizedTrackerValue(value: string): string {
  return value.trim().toLowerCase();
}

/** Provider eligibility plus generic include/exclude label selectors. */
export function issueRoutable(
  issue: Issue,
  requiredLabels: readonly string[],
  excludedLabels: readonly string[] = [],
): boolean {
  if (!issue.dispatchable) return false;
  const labels = new Set(issue.labels.map(normalizedTrackerValue));
  const containsEveryRequired = requiredLabels.every((label) => {
    const required = normalizedTrackerValue(label);
    return required !== "" && labels.has(required);
  });
  if (!containsEveryRequired) return false;
  return excludedLabels.every((label) => {
    const excluded = normalizedTrackerValue(label);
    return excluded !== "" && !labels.has(excluded);
  });
}
