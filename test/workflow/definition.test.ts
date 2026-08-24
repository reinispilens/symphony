import { describe, expect, it } from "vitest";

import { parseWorkflow } from "../../src/workflow/definition.js";

describe("parseWorkflow", () => {
  it("splits YAML front matter from the trimmed Markdown prompt", () => {
    const workflow = parseWorkflow(`---
tracker:
  kind: test
polling:
  interval_ms: 1234
---

 Work on {{ issue.identifier }}.\x20
`);

    expect(workflow.config).toEqual({
      tracker: { kind: "test" },
      polling: { interval_ms: 1234 },
    });
    expect(workflow.promptTemplate).toBe("Work on {{ issue.identifier }}.");
  });

  it("treats a file without front matter as the prompt", () => {
    expect(parseWorkflow("\n  Complete this issue. \n")).toEqual({
      config: {},
      promptTemplate: "Complete this issue.",
    });
  });

  it("supports CRLF workflow files", () => {
    expect(
      parseWorkflow("---\r\ntracker:\r\n  kind: test\r\n---\r\nPrompt\r\n"),
    ).toEqual({
      config: { tracker: { kind: "test" } },
      promptTemplate: "Prompt",
    });
  });

  it("returns a typed parse error for invalid YAML", () => {
    expect(() => parseWorkflow("---\ntracker: [\n---\nprompt")).toThrowError(
      expect.objectContaining({ code: "workflow_parse_error" }),
    );
  });

  it("rejects non-object front matter", () => {
    expect(() =>
      parseWorkflow("---\n- tracker\n- polling\n---\nprompt"),
    ).toThrowError(
      expect.objectContaining({ code: "workflow_front_matter_not_a_map" }),
    );
  });

  it("rejects an opening marker without a closing marker", () => {
    expect(() => parseWorkflow("---\ntracker:\n  kind: test")).toThrowError(
      expect.objectContaining({ code: "workflow_parse_error" }),
    );
  });
});
