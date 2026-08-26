import { symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseWorkPlanMarkdown,
  readWorkPlanFile,
} from "../../src/interactive/plan-document.js";
import { withTempDirectory } from "../support/factories.js";

describe("manual WorkSession plan documents", () => {
  it("projects exactly one plan and acceptance section", () => {
    expect(
      parseWorkPlanMarkdown(`# Context

## Plan

Keep orchestration in Symphony.

Do not copy lifecycle machinery into products.

## Acceptance criteria

- One shared WorkSession store
- Human checkout remains human-owned
  and is never removed by Symphony
3. No tracker mutation
`),
    ).toEqual({
      summary:
        "Keep orchestration in Symphony.\n\nDo not copy lifecycle machinery into products.",
      acceptanceCriteria: [
        "One shared WorkSession store",
        "Human checkout remains human-owned and is never removed by Symphony",
        "No tracker mutation",
      ],
    });
  });

  it("does not interpret headings inside fenced code as plan structure", () => {
    expect(
      parseWorkPlanMarkdown(`## Notes

\`\`\`
## Plan
fake
\`\`\`

## Plan
Real plan.

## Acceptance criteria
- Real criterion
`),
    ).toEqual({
      summary: "Real plan.",
      acceptanceCriteria: ["Real criterion"],
    });
  });

  it("refuses missing, duplicate, blank, and prose-only criteria", () => {
    expect(() => parseWorkPlanMarkdown("## Plan\nwork\n")).toThrow(
      "exactly one '## Acceptance criteria'",
    );
    expect(() =>
      parseWorkPlanMarkdown(
        "## Plan\none\n## Plan\ntwo\n## Acceptance criteria\n- done\n",
      ),
    ).toThrow("more than one '## Plan'");
    expect(() =>
      parseWorkPlanMarkdown("## Plan\n\n## Acceptance criteria\n- done\n"),
    ).toThrow("must not be blank");
    expect(() =>
      parseWorkPlanMarkdown(
        "## Plan\nwork\n## Acceptance criteria\nThis is not a list.\n",
      ),
    ).toThrow("must be a list item");
  });

  it("reads only bounded regular canonical UTF-8 files", async () => {
    await withTempDirectory(async (directory) => {
      const valid = path.join(directory, "plan.md");
      const alias = path.join(directory, "plan-link.md");
      const invalidUtf8 = path.join(directory, "invalid.md");
      await writeFile(
        valid,
        "## Plan\nDo the work.\n## Acceptance criteria\n- It is done.\n",
      );
      await symlink(valid, alias);
      await writeFile(invalidUtf8, Buffer.from([0xff, 0xfe]));

      await expect(readWorkPlanFile(valid)).resolves.toMatchObject({
        summary: "Do the work.",
      });
      await expect(readWorkPlanFile(alias)).rejects.toMatchObject({
        code: "interactive_input_invalid",
      });
      await expect(readWorkPlanFile(invalidUtf8)).rejects.toThrow(
        "must be valid UTF-8",
      );
    });
  });
});
