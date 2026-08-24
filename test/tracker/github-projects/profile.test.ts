import { describe, expect, it } from "vitest";

import {
  githubProjectsConfigProfile,
  parseGitHubProjectsConfig,
} from "../../../src/tracker/github-projects/profile.js";

describe("GitHub Projects config profile", () => {
  it("applies provider defaults while preserving unknown keys", () => {
    expect(
      githubProjectsConfigProfile.resolveProvider(
        {
          owner: "acme",
          repo: "widgets",
          project: 28,
          future_option: { enabled: true },
        },
        {},
      ),
    ).toEqual({
      agent_status_targets: [],
      owner: "acme",
      repo: "widgets",
      project: 28,
      hostname: "github.com",
      status_field: "Status",
      priority_field: "Priority",
      timeout_ms: 30_000,
      future_option: { enabled: true },
    });
  });

  it.each([
    [{ repo: "widgets", project: 28 }, "owner"],
    [{ owner: "acme", project: 28 }, "repo"],
    [{ owner: "acme", repo: "widgets", project: "28" }, "project"],
    [{ owner: "acme", repo: "widgets", project: 0 }, "project"],
    [
      { owner: "acme", repo: "widgets", project: 28, timeout_ms: -1 },
      "timeout_ms",
    ],
    [
      {
        owner: "acme",
        repo: "widgets",
        project: 28,
        agent_status_targets: [""],
      },
      "agent_status_targets",
    ],
  ])("rejects invalid provider config %o", (provider, key) => {
    expect(() => parseGitHubProjectsConfig(provider as never)).toThrowError(
      expect.objectContaining({
        category: "invalid_tracker_config",
        message: expect.stringContaining(key),
      }),
    );
  });

  it("normalizes and de-duplicates configured agent status targets", () => {
    expect(
      parseGitHubProjectsConfig({
        owner: "acme",
        repo: "widgets",
        project: 28,
        agent_status_targets: ["In Progress", "in progress", "Human Review"],
      }).agentStatusTargets,
    ).toEqual(["In Progress", "Human Review"]);
  });

  it("declares every GitHub CLI token alias for child-environment removal", () => {
    expect(githubProjectsConfigProfile.secretEnvironmentNames).toEqual([
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
    ]);
  });
});
