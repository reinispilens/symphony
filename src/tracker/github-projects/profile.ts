import { TrackerError } from "../errors.js";
import type { TrackerConfigProfile } from "../config-profile.js";
import type { JsonObject } from "../../shared/json.js";
import { GITHUB_TRACKER_SECRET_ENVIRONMENT_NAMES } from "../../security/secrets.js";

export const GITHUB_PROJECTS_TRACKER_KIND = "github-projects";

export const GITHUB_SECRET_ENVIRONMENT_NAMES =
  GITHUB_TRACKER_SECRET_ENVIRONMENT_NAMES;

export interface GitHubProjectsConfig {
  readonly agentStatusTargets: readonly string[];
  readonly hostname: string;
  readonly owner: string;
  readonly priorityField: string;
  readonly projectNumber: number;
  readonly repo: string;
  readonly statusField: string;
  readonly timeoutMs: number;
}

function optionalStringList(
  provider: JsonObject,
  key: string,
): readonly string[] {
  const value = provider[key] ?? [];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.trim() === "")
  ) {
    throw new TrackerError(
      "invalid_tracker_config",
      `tracker.provider.${key} must be a list of non-empty strings`,
    );
  }
  const result = new Map<string, string>();
  for (const entry of value as string[]) {
    const trimmed = entry.trim();
    const normalized = trimmed.toLowerCase();
    if (!result.has(normalized)) result.set(normalized, trimmed);
  }
  return [...result.values()];
}

function nonEmptyString(
  provider: JsonObject,
  key: string,
  fallback?: string,
): string {
  const value = provider[key] ?? fallback;
  if (typeof value !== "string" || value.trim() === "") {
    throw new TrackerError(
      "invalid_tracker_config",
      `tracker.provider.${key} must be a non-empty string`,
    );
  }
  return value;
}

function projectNumber(provider: JsonObject): number {
  const value = provider["project"];
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TrackerError(
      "invalid_tracker_config",
      "tracker.provider.project must be a positive integer project number",
    );
  }
  return value as number;
}

function timeoutMs(provider: JsonObject): number {
  const value = provider["timeout_ms"] ?? 30_000;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TrackerError(
      "invalid_tracker_config",
      "tracker.provider.timeout_ms must be a positive integer",
    );
  }
  return value as number;
}

export function parseGitHubProjectsConfig(
  provider: JsonObject,
): GitHubProjectsConfig {
  return {
    agentStatusTargets: optionalStringList(provider, "agent_status_targets"),
    hostname: nonEmptyString(provider, "hostname", "github.com"),
    owner: nonEmptyString(provider, "owner"),
    priorityField: nonEmptyString(provider, "priority_field", "Priority"),
    projectNumber: projectNumber(provider),
    repo: nonEmptyString(provider, "repo"),
    statusField: nonEmptyString(provider, "status_field", "Status"),
    timeoutMs: timeoutMs(provider),
  };
}

export const githubProjectsConfigProfile: TrackerConfigProfile = {
  kind: GITHUB_PROJECTS_TRACKER_KIND,
  secretEnvironmentNames: GITHUB_SECRET_ENVIRONMENT_NAMES,
  resolveProvider(provider) {
    const resolved = parseGitHubProjectsConfig(provider);
    return {
      ...provider,
      agent_status_targets: [...resolved.agentStatusTargets],
      hostname: resolved.hostname,
      owner: resolved.owner,
      priority_field: resolved.priorityField,
      project: resolved.projectNumber,
      repo: resolved.repo,
      status_field: resolved.statusField,
      timeout_ms: resolved.timeoutMs,
    };
  },
};
