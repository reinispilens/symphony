import { describe, expect, it } from "vitest";

import { renderPrompt } from "../../src/workflow/prompt.js";
import { issue } from "../support/factories.js";

describe("renderPrompt", () => {
  it("renders the normalized issue and nullable attempt", async () => {
    const rendered = await renderPrompt(
      "{{ issue.identifier }} — {{ issue.title }}{% if attempt %} (attempt {{ attempt }}){% endif %}",
      issue(),
      2,
    );
    expect(rendered).toBe("SYM-123 — Build the safe foundation (attempt 2)");
  });

  it("uses the documented fallback for an empty prompt", async () => {
    await expect(renderPrompt(" \n", issue(), null)).resolves.toBe(
      "You are working on an issue from the configured tracker.",
    );
  });

  it("exposes immutable governance references without copying doctrine prose", async () => {
    const reference = {
      repositoryIdentity: "reinispilens/.github",
      path: "agent-system/tracker-policy.json",
      revision: "a".repeat(40),
      digest: `sha256:${"b".repeat(64)}`,
    };
    const rendered = await renderPrompt(
      "{{ work_session.id }} {{ governance.tracker_policy.path }}@{{ governance.tracker_policy.revision }}",
      issue(),
      null,
      {
        workSessionId: "session-1",
        doctrine: { ...reference, path: "agent-system/golden-principles.md" },
        governanceManifest: {
          ...reference,
          path: "agent-system/accepted-governance.json",
        },
        trackerPolicy: reference,
      },
    );
    expect(rendered).toBe(
      `session-1 agent-system/tracker-policy.json@${"a".repeat(40)}`,
    );
    expect(rendered).not.toContain("principle");
  });

  it("fails on unknown variables", async () => {
    await expect(
      renderPrompt("{{ missing.value }}", issue(), null),
    ).rejects.toMatchObject({
      code: "template_render_error",
    });
  });

  it("fails on unknown filters", async () => {
    await expect(
      renderPrompt("{{ issue.title | imaginary_filter }}", issue(), null),
    ).rejects.toMatchObject({
      code: "template_parse_error",
    });
  });
});
