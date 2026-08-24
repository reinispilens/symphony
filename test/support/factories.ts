import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Issue } from "../../src/domain/issue.js";
import type {
  TrackerConfigProfile,
  TrackerConfigProfiles,
} from "../../src/tracker/config-profile.js";

export const testTrackerProfile: TrackerConfigProfile = {
  kind: "test",
  defaultActiveStates: ["Todo"],
  defaultTerminalStates: ["Done"],
  secretEnvironmentNames: ["TEST_TRACKER_TOKEN"],
  resolveProvider: (provider) => provider,
};

export const testTrackerProfiles: TrackerConfigProfiles = new Map([
  [testTrackerProfile.kind, testTrackerProfile],
]);

export function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "opaque-1",
    native_ref: null,
    identifier: "SYM-123",
    title: "Build the safe foundation",
    description: "Implement the workflow and workspace boundaries.",
    priority: 1,
    state: "Todo",
    state_version: "state-version-1",
    branch_name: "feature/sym-123",
    url: "https://example.test/issues/123",
    assignee_id: null,
    labels: ["ready"],
    blocked_by: [],
    dispatchable: true,
    created_at: new Date("2026-08-23T08:00:00.000Z"),
    updated_at: new Date("2026-08-23T09:00:00.000Z"),
    ...overrides,
  };
}

export async function withTempDirectory<T>(
  run: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "symphony-test-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
