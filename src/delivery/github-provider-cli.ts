#!/usr/bin/env node

import { errorMessage, SymphonyError } from "../errors.js";
import {
  FetchGitHubHttp,
  GitHubDeliveryProvider,
  GitHubGitRefPusher,
  parseGitHubDeliveryProviderRequest,
} from "./github-provider.js";

const MAX_INPUT_BYTES = 1024 * 1024;

function token(
  environment: Readonly<Record<string, string | undefined>>,
  hostname: string,
): string {
  const names =
    hostname === "github.com"
      ? ["GH_TOKEN", "GITHUB_TOKEN"]
      : ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_TOKEN"];
  for (const name of names) {
    const value = environment[name];
    if (value !== undefined && value.trim() !== "") return value;
  }
  throw new SymphonyError(
    "delivery_provider_failed",
    `No GitHub delivery token is present in ${names.join(", ")}`,
  );
}

async function readInput(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of process.stdin) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as string);
    total += chunk.byteLength;
    if (total > MAX_INPUT_BYTES) {
      throw new SymphonyError(
        "delivery_provider_failed",
        `GitHub delivery request exceeds ${MAX_INPUT_BYTES} bytes`,
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function main(): Promise<void> {
  const hostname = (process.env["SYMPHONY_GITHUB_HOSTNAME"] ?? "github.com")
    .trim()
    .toLowerCase();
  const gitExecutable =
    process.env["SYMPHONY_GIT_EXECUTABLE"] ?? "/usr/bin/git";
  const githubToken = token(process.env, hostname);
  const bytes = await readInput();
  let decoded: unknown;
  try {
    decoded = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new SymphonyError(
      "delivery_provider_failed",
      "GitHub delivery request is invalid JSON",
      { cause: error },
    );
  }
  const request = parseGitHubDeliveryProviderRequest(decoded);
  const provider = new GitHubDeliveryProvider({
    http: new FetchGitHubHttp({ hostname, token: githubToken }),
    refs: new GitHubGitRefPusher({
      gitExecutable,
      hostname,
      token: githubToken,
    }),
  });
  const observation = await provider.execute(request);
  process.stdout.write(
    `${JSON.stringify({ protocolVersion: 1, outcome: "ok", observation })}\n`,
  );
}

void main().catch((error: unknown) => {
  if (
    error instanceof SymphonyError &&
    error.code === "delivery_provider_refused"
  ) {
    process.stdout.write(
      `${JSON.stringify({
        protocolVersion: 1,
        outcome: "refused",
        reason: error.message,
      })}\n`,
    );
    return;
  }
  process.stderr.write(`github delivery failed: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
