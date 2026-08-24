import { describe, expect, it } from "vitest";

import { redactEnvironmentSecrets } from "../../src/security/secrets.js";

describe("redactEnvironmentSecrets", () => {
  it("redacts non-empty configured values with case-insensitive environment names", () => {
    expect(
      redactEnvironmentSecrets(
        "token=secret-long and again secret-long; RED; keep visible",
        {
          gh_token: "secret-long",
          GITHUB_TOKEN: "RED",
          EMPTY_SECRET: "",
          KEEP: "visible",
        },
        ["GH_TOKEN", "GITHUB_TOKEN", "EMPTY_SECRET"],
      ),
    ).toBe("token=[REDACTED] and again [REDACTED]; [REDACTED]; keep visible");
  });
});
