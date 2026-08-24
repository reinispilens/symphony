import { describe, expect, it } from "vitest";

import {
  childEnvironmentWithoutSecrets,
  universalTrackerSecretNames,
} from "../../src/agent/environment.js";

describe("coding-agent child environment", () => {
  it("removes universal, adapter-declared, and case-variant tracker secrets", () => {
    expect(
      childEnvironmentWithoutSecrets(
        {
          GH_TOKEN: "one",
          github_token: "two",
          GH_ENTERPRISE_TOKEN: "three",
          GITHUB_ENTERPRISE_TOKEN: "four",
          CUSTOM_TRACKER_SECRET: "five",
          KEEP_ME: "safe",
          EMPTY: undefined,
        },
        ["CUSTOM_TRACKER_SECRET"],
      ),
    ).toEqual({ KEEP_ME: "safe" });
  });

  it("publishes the universal aliases for audits", () => {
    expect(universalTrackerSecretNames()).toEqual([
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
    ]);
  });
});
