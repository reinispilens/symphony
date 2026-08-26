import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import { SymphonyError } from "../errors.js";

const MAX_PLAN_BYTES = 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });

export interface ParsedWorkPlan {
  readonly acceptanceCriteria: readonly string[];
  readonly summary: string;
}

function invalid(message: string, cause?: unknown): never {
  throw new SymphonyError("interactive_input_invalid", message, {
    ...(cause === undefined ? {} : { cause }),
  });
}

interface MarkdownSection {
  readonly heading: string;
  readonly lines: readonly string[];
}

/**
 * Extract level-two sections without treating headings inside fenced code as
 * structure. The manual-plan contract intentionally needs no general Markdown
 * renderer or candidate-provided plugin.
 */
function sections(source: string): readonly MarkdownSection[] {
  const found: Array<{ heading: string; lines: string[] }> = [];
  let current: { heading: string; lines: string[] } | null = null;
  let fence: "```" | "~~~" | null = null;

  for (const line of source.split(/\r?\n/u)) {
    const trimmed = line.trimStart();
    if (
      fence === null &&
      (trimmed.startsWith("```") || trimmed.startsWith("~~~"))
    ) {
      fence = trimmed.startsWith("```") ? "```" : "~~~";
      current?.lines.push(line);
      continue;
    }
    if (fence !== null) {
      current?.lines.push(line);
      if (trimmed.startsWith(fence)) fence = null;
      continue;
    }

    const heading = line.match(/^##[ \t]+(.+?)[ \t]*$/u);
    if (heading !== null) {
      current = { heading: heading[1]!, lines: [] };
      found.push(current);
      continue;
    }
    if (/^#[ \t]+/u.test(line)) {
      current = null;
      continue;
    }
    current?.lines.push(line);
  }
  return found;
}

function uniqueSection(
  sourceSections: readonly MarkdownSection[],
  name: string,
): MarkdownSection {
  const matches = sourceSections.filter((entry) => entry.heading === name);
  if (matches.length !== 1) {
    invalid(
      matches.length === 0
        ? `Plan document must contain exactly one '## ${name}' section`
        : `Plan document contains more than one '## ${name}' section`,
    );
  }
  return matches[0]!;
}

function criteria(lines: readonly string[]): readonly string[] {
  const entries: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    const item = line.match(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(.+?)\s*$/u);
    if (item !== null) {
      entries.push(item[1]!.trim());
      continue;
    }
    if (/^[ \t]{2,}\S/u.test(line) && entries.length !== 0) {
      entries[entries.length - 1] = `${entries.at(-1)!} ${line.trim()}`;
      continue;
    }
    invalid(
      "Every non-blank line under '## Acceptance criteria' must be a list item or an indented continuation",
    );
  }
  if (entries.length === 0) {
    invalid("Plan document must contain at least one acceptance criterion");
  }
  return entries;
}

export function parseWorkPlanMarkdown(source: string): ParsedWorkPlan {
  const sourceSections = sections(source);
  const planSection = uniqueSection(sourceSections, "Plan");
  const acceptanceSection = uniqueSection(
    sourceSections,
    "Acceptance criteria",
  );
  const summary = planSection.lines.join("\n").trim();
  if (summary === "") invalid("The '## Plan' section must not be blank");
  return {
    summary,
    acceptanceCriteria: criteria(acceptanceSection.lines),
  };
}

export async function readWorkPlanFile(
  filePath: string,
): Promise<ParsedWorkPlan> {
  if (/[\0\r\n]/u.test(filePath)) {
    invalid("Plan file path contains unsupported control characters");
  }
  const resolved = path.resolve(filePath);
  let entry;
  try {
    entry = await lstat(resolved);
  } catch (error) {
    invalid(`Could not inspect plan file ${resolved}`, error);
  }
  if (!entry.isFile() || entry.isSymbolicLink()) {
    invalid(`Plan file ${resolved} must be a regular non-symlink file`);
  }
  if (entry.size > MAX_PLAN_BYTES) {
    invalid(`Plan file ${resolved} exceeds ${MAX_PLAN_BYTES} bytes`);
  }
  const canonical = await realpath(resolved);
  if (canonical !== resolved) {
    invalid(`Plan file ${resolved} must contain no symbolic-link components`);
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(canonical);
  } catch (error) {
    invalid(`Could not read plan file ${canonical}`, error);
  }
  if (bytes.byteLength > MAX_PLAN_BYTES) {
    invalid(`Plan file ${canonical} exceeds ${MAX_PLAN_BYTES} bytes`);
  }
  let source: string;
  try {
    source = utf8.decode(bytes);
  } catch (error) {
    invalid(`Plan file ${canonical} must be valid UTF-8`, error);
  }
  return parseWorkPlanMarkdown(source);
}
