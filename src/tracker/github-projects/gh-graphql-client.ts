import { spawn } from "node:child_process";

import { errorMessage } from "../../errors.js";
import {
  GITHUB_TRACKER_SECRET_ENVIRONMENT_NAMES,
  redactEnvironmentSecrets,
} from "../../security/secrets.js";
import { isRecord } from "../../shared/json.js";
import { TrackerError, type TrackerErrorCategory } from "../errors.js";

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export interface GraphqlClient {
  request(
    document: string,
    variables: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
}

export interface GhGraphqlClientOptions {
  readonly command?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly hostname?: string;
  readonly timeoutMs?: number;
}

function errorCategory(message: string): TrackerErrorCategory {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("rate limit") ||
    normalized.includes("rate_limited")
  ) {
    return "tracker_rate_limited";
  }
  if (
    normalized.includes("authentication") ||
    normalized.includes("http 401") ||
    normalized.includes("not logged") ||
    normalized.includes("bad credentials")
  ) {
    return "missing_tracker_secret";
  }
  if (/http 4\d\d|http 5\d\d/u.test(normalized)) return "tracker_status";
  return "tracker_request";
}

function graphqlErrors(envelope: Record<string, unknown>): readonly unknown[] {
  const errors = envelope["errors"];
  return Array.isArray(errors) ? errors : [];
}

function graphqlErrorMessage(errors: readonly unknown[]): string {
  return errors
    .map((entry) =>
      isRecord(entry) && typeof entry["message"] === "string"
        ? entry["message"]
        : "unknown error",
    )
    .join("; ");
}

export class GhGraphqlClient implements GraphqlClient {
  readonly #command: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #hostname: string;
  readonly #timeoutMs: number;

  constructor(options: GhGraphqlClientOptions = {}) {
    this.#command = options.command ?? "gh";
    this.#environment = options.environment ?? process.env;
    this.#hostname = options.hostname ?? "github.com";
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  async request(
    document: string,
    variables: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    const args = ["api", "graphql", "--input", "-"];
    if (this.#hostname !== "github.com")
      args.push("--hostname", this.#hostname);
    const payload = JSON.stringify({ query: document, variables });

    const envelope = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        const child = spawn(this.#command, args, {
          env: this.#environment,
          stdio: ["pipe", "pipe", "pipe"],
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let settled = false;
        let timedOut = false;

        const timeout = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, this.#timeoutMs);

        const collect = (
          target: Buffer[],
          chunk: Buffer,
          currentBytes: number,
        ): number => {
          const nextBytes = currentBytes + chunk.length;
          if (nextBytes > MAX_RESPONSE_BYTES) {
            child.kill("SIGKILL");
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              reject(
                new TrackerError(
                  "tracker_response",
                  "GitHub GraphQL response exceeded 32 MiB",
                  {
                    retryable: false,
                  },
                ),
              );
            }
            return nextBytes;
          }
          target.push(chunk);
          return nextBytes;
        };

        child.stdout.on("data", (chunk: Buffer) => {
          stdoutBytes = collect(stdout, chunk, stdoutBytes);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderrBytes = collect(stderr, chunk, stderrBytes);
        });

        child.once("error", (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(
            new TrackerError(
              "tracker_request",
              `Could not launch gh: ${errorMessage(error)}`,
              {
                cause: error,
                retryable: true,
              },
            ),
          );
        });

        child.once("close", (exitCode) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          const rawErrorOutput = Buffer.concat(
            stderr,
            Math.min(stderrBytes, MAX_RESPONSE_BYTES),
          )
            .toString("utf8")
            .trim();
          const errorOutput = redactEnvironmentSecrets(
            rawErrorOutput,
            this.#environment,
            GITHUB_TRACKER_SECRET_ENVIRONMENT_NAMES,
          );
          if (timedOut) {
            reject(
              new TrackerError(
                "tracker_request",
                `GitHub GraphQL request timed out after ${this.#timeoutMs}ms`,
                {
                  retryable: true,
                },
              ),
            );
            return;
          }
          if (exitCode !== 0) {
            const message =
              errorOutput || `gh exited with status ${String(exitCode)}`;
            const category = errorCategory(message);
            reject(
              new TrackerError(
                category,
                `GitHub GraphQL request failed: ${message}`,
                {
                  retryable: category === "tracker_request",
                },
              ),
            );
            return;
          }

          const output = Buffer.concat(
            stdout,
            Math.min(stdoutBytes, MAX_RESPONSE_BYTES),
          ).toString("utf8");
          let parsed: unknown;
          try {
            parsed = JSON.parse(output);
          } catch (error) {
            reject(
              new TrackerError(
                "tracker_response",
                `gh returned invalid JSON: ${errorMessage(error)}`,
                {
                  cause: error,
                },
              ),
            );
            return;
          }
          if (!isRecord(parsed)) {
            reject(
              new TrackerError(
                "tracker_response",
                "GitHub GraphQL response must be an object",
              ),
            );
            return;
          }
          resolve(parsed);
        });

        child.stdin.on("error", () => undefined);
        child.stdin.end(payload);
      },
    );

    const errors = graphqlErrors(envelope);
    if (errors.length > 0) {
      const message = redactEnvironmentSecrets(
        graphqlErrorMessage(errors),
        this.#environment,
        GITHUB_TRACKER_SECRET_ENVIRONMENT_NAMES,
      );
      const mappedCategory = errorCategory(message);
      const category =
        mappedCategory === "tracker_rate_limited" ||
        mappedCategory === "missing_tracker_secret"
          ? mappedCategory
          : "tracker_response";
      throw new TrackerError(
        category,
        `GitHub GraphQL returned errors: ${message}`,
        {
          retryable: category === "tracker_rate_limited",
        },
      );
    }
    const data = envelope["data"];
    if (!isRecord(data)) {
      throw new TrackerError(
        "tracker_response",
        "GitHub GraphQL response has no data object",
      );
    }
    return data;
  }
}
