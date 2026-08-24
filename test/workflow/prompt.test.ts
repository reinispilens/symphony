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
