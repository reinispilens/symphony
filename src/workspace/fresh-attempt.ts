import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { Issue } from "../domain/issue.js";
import { SymphonyError } from "../errors.js";
import { isRecord } from "../shared/json.js";

const METADATA_DIRECTORY = ".symphony";
const RECEIPT_DIRECTORY = "fresh-attempts";

export type FreshAttemptPhase = "provisioned" | "ready";

export interface FreshAttemptReceipt {
  readonly schema_version: 1;
  readonly issue_id: string;
  readonly issue_identifier: string;
  readonly workspace_key: string;
  readonly generation: string;
  readonly phase: FreshAttemptPhase;
}

export function freshAttemptGeneration(issue: Issue): string | null {
  if (issue.state_version === null || issue.state_version.trim() === "") {
    return null;
  }
  return createHash("sha256")
    .update(`${issue.id}\0${issue.state_version}`, "utf8")
    .digest("hex");
}

function receiptName(issueId: string): string {
  return `${createHash("sha256").update(issueId, "utf8").digest("hex")}.json`;
}

async function assertDirectory(
  directory: string,
  label: string,
): Promise<void> {
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new SymphonyError(
      "workspace_path_unsafe",
      `${label} ${directory} must be a real directory`,
    );
  }
}

async function ensureReceiptDirectory(workspaceRoot: string): Promise<string> {
  const root = path.resolve(workspaceRoot);
  await mkdir(root, { recursive: true });
  await assertDirectory(root, "Workspace root");

  const metadata = path.join(root, METADATA_DIRECTORY);
  try {
    await mkdir(metadata);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await assertDirectory(metadata, "Symphony metadata directory");

  const receipts = path.join(metadata, RECEIPT_DIRECTORY);
  try {
    await mkdir(receipts);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await assertDirectory(receipts, "Fresh-attempt receipt directory");
  return receipts;
}

async function existingReceiptDirectory(
  workspaceRoot: string,
): Promise<string | null> {
  const root = path.resolve(workspaceRoot);
  const metadata = path.join(root, METADATA_DIRECTORY);
  const receipts = path.join(metadata, RECEIPT_DIRECTORY);
  for (const [directory, label] of [
    [root, "Workspace root"],
    [metadata, "Symphony metadata directory"],
    [receipts, "Fresh-attempt receipt directory"],
  ] as const) {
    try {
      await assertDirectory(directory, label);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  return receipts;
}

async function assertReceiptFile(filePath: string): Promise<boolean> {
  try {
    const entry = await lstat(filePath);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new SymphonyError(
        "workspace_path_unsafe",
        `Fresh-attempt receipt ${filePath} must be a regular file`,
      );
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function parseReceipt(value: unknown, filePath: string): FreshAttemptReceipt {
  if (!isRecord(value)) {
    throw new SymphonyError(
      "fresh_attempt_invalid",
      `Fresh-attempt receipt ${filePath} must contain a JSON object`,
    );
  }
  const expectedKeys = [
    "generation",
    "issue_id",
    "issue_identifier",
    "phase",
    "schema_version",
    "workspace_key",
  ];
  const actualKeys = Object.keys(value).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    value["schema_version"] !== 1 ||
    (value["phase"] !== "provisioned" && value["phase"] !== "ready") ||
    ["generation", "issue_id", "issue_identifier", "workspace_key"].some(
      (key) => typeof value[key] !== "string" || value[key] === "",
    )
  ) {
    throw new SymphonyError(
      "fresh_attempt_invalid",
      `Fresh-attempt receipt ${filePath} has an invalid schema`,
    );
  }
  return value as unknown as FreshAttemptReceipt;
}

export async function readFreshAttemptReceipt(
  workspaceRoot: string,
  issueId: string,
): Promise<FreshAttemptReceipt | null> {
  const directory = await existingReceiptDirectory(workspaceRoot);
  if (directory === null) return null;
  const filePath = path.join(directory, receiptName(issueId));
  if (!(await assertReceiptFile(filePath))) return null;
  const raw = await readFile(filePath, "utf8");
  try {
    return parseReceipt(JSON.parse(raw) as unknown, filePath);
  } catch (error) {
    if (error instanceof SymphonyError) throw error;
    throw new SymphonyError(
      "fresh_attempt_invalid",
      `Fresh-attempt receipt ${filePath} is not valid JSON`,
      { cause: error },
    );
  }
}

export async function writeFreshAttemptReceipt(
  workspaceRoot: string,
  receipt: FreshAttemptReceipt,
): Promise<void> {
  const directory = await ensureReceiptDirectory(workspaceRoot);
  const destination = path.join(directory, receiptName(receipt.issue_id));
  const temporary = path.join(directory, `.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function removeFreshAttemptReceipt(
  workspaceRoot: string,
  issueId: string,
): Promise<void> {
  const directory = await existingReceiptDirectory(workspaceRoot);
  if (directory === null) return;
  const filePath = path.join(directory, receiptName(issueId));
  if (!(await assertReceiptFile(filePath))) return;
  await rm(filePath, { force: false });
}
