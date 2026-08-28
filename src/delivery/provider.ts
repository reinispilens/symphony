import { spawn } from "node:child_process";
import path from "node:path";

import { SymphonyError } from "../errors.js";
import type { DeliveryOperation } from "../governance/model.js";
import { isRecord } from "../shared/json.js";
import type {
  DeliveryGrantSnapshot,
  RequiredCheckObservation,
} from "../state/model.js";

const PROTOCOL_VERSION = 1;
const MAX_PROVIDER_OUTPUT_BYTES = 1024 * 1024;
const SAFE_ENVIRONMENT_NAMES = [
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PATH",
  "SSH_AUTH_SOCK",
] as const;

export interface TrackerDeliveryAuthority {
  readonly origin: "interactive" | "tracker";
  readonly issueId: string | null;
  readonly state: string | null;
  readonly stateVersion: string | null;
  /** Exact lane-policy and product-grant intersection for this observation. */
  readonly permittedOperations: readonly DeliveryOperation[];
  readonly permitsDelivery: boolean;
  readonly permitsMerge: boolean;
  readonly permitsCleanup: boolean;
  readonly observedAt: string;
}

export interface PullRequestObservation {
  readonly id: string;
  readonly url: string;
  readonly state: "open" | "closed" | "merged";
  readonly baseRef: string;
  readonly headRef: string;
  readonly headSha: string;
  readonly mergeSha: string | null;
}

export interface DeliveryObservation {
  readonly remoteHeadSha: string | null;
  readonly pullRequest: PullRequestObservation | null;
  readonly requiredChecks: readonly RequiredCheckObservation[];
}

interface DeliveryRequestAuthority {
  readonly sessionId: string;
  readonly controllerGeneration: number;
  readonly repositoryIdentity: string;
  readonly grant: DeliveryGrantSnapshot;
  readonly tracker: TrackerDeliveryAuthority;
}

interface DeliveryRequestBase extends DeliveryRequestAuthority {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly idempotencyKey: string;
  readonly branch: string;
  readonly baseRef: string;
  readonly immutableHeadSha: string;
}

export type DeliveryProviderRequest =
  | (DeliveryRequestBase & { readonly operation: "observe" })
  | (DeliveryRequestBase & {
      readonly operation: "push";
      readonly sourceRoot: string;
      readonly expectedRemoteHeadSha: string | null;
    })
  | (DeliveryRequestBase & {
      readonly operation: "open_pull_request";
      readonly title: string;
      readonly body: string;
    })
  | (DeliveryRequestBase & {
      readonly operation: "merge_pull_request";
      readonly pullRequestId: string;
    })
  | (DeliveryRequestBase & {
      readonly operation: "close_pull_request";
      readonly pullRequestId: string;
    })
  | (DeliveryRequestBase & {
      readonly operation: "delete_remote_branch";
      readonly sourceRoot: string;
      readonly expectedRemoteHeadSha: string;
    });

export interface DeliveryProvider {
  execute(request: DeliveryProviderRequest): Promise<DeliveryObservation>;
}

export interface ExternalDeliveryProviderOptions {
  readonly executable: string;
  readonly timeoutMs: number;
  readonly secretEnvironmentNames: readonly string[];
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly gitExecutable?: string;
  readonly githubHostname?: string;
}

function nonEmptyString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SymphonyError(
      "delivery_provider_failed",
      `${location} must be a non-empty string`,
    );
  }
  return value;
}

function nullableString(value: unknown, location: string): string | null {
  if (value === null) return null;
  return nonEmptyString(value, location);
}

function gitSha(value: unknown, location: string): string {
  const sha = nonEmptyString(value, location);
  if (!/^[0-9a-f]{40}$/u.test(sha)) {
    throw new SymphonyError(
      "delivery_provider_failed",
      `${location} must be a full lowercase Git SHA-1`,
    );
  }
  return sha;
}

function stringOrNumberId(value: unknown, location: string): string | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return nonEmptyString(value, location);
}

function parseCheck(value: unknown, index: number): RequiredCheckObservation {
  const location = `delivery provider observation.requiredChecks[${index}]`;
  if (!isRecord(value)) {
    throw new SymphonyError(
      "delivery_provider_failed",
      `${location} must be an object`,
    );
  }
  const status = value["status"];
  if (
    status !== "pending" &&
    status !== "passed" &&
    status !== "failed" &&
    status !== "setup_refused" &&
    status !== "non_verdict"
  ) {
    throw new SymphonyError(
      "delivery_provider_failed",
      `${location}.status is invalid`,
    );
  }
  return {
    name: nonEmptyString(value["name"], `${location}.name`),
    headSha: gitSha(value["headSha"], `${location}.headSha`),
    checkRunId: stringOrNumberId(value["checkRunId"], `${location}.checkRunId`),
    workflowRunId: stringOrNumberId(
      value["workflowRunId"],
      `${location}.workflowRunId`,
    ),
    status,
    observedAt: nullableString(value["observedAt"], `${location}.observedAt`),
  };
}

function parseObservation(value: unknown): DeliveryObservation {
  if (!isRecord(value)) {
    throw new SymphonyError(
      "delivery_provider_failed",
      "Delivery provider response must be an object",
    );
  }
  if (value["protocolVersion"] !== PROTOCOL_VERSION) {
    throw new SymphonyError(
      "delivery_provider_failed",
      `Delivery provider response protocolVersion must equal ${PROTOCOL_VERSION}`,
    );
  }
  if (value["outcome"] === "refused") {
    throw new SymphonyError(
      "delivery_provider_refused",
      nonEmptyString(value["reason"], "delivery provider refusal reason"),
    );
  }
  if (value["outcome"] !== "ok" || !isRecord(value["observation"])) {
    throw new SymphonyError(
      "delivery_provider_failed",
      "Delivery provider response must contain one ok observation or refusal",
    );
  }
  const source = value["observation"];
  const pullRequestValue = source["pullRequest"];
  let pullRequest: PullRequestObservation | null = null;
  if (pullRequestValue !== null) {
    if (!isRecord(pullRequestValue)) {
      throw new SymphonyError(
        "delivery_provider_failed",
        "delivery provider observation.pullRequest must be an object or null",
      );
    }
    const state = pullRequestValue["state"];
    if (state !== "open" && state !== "closed" && state !== "merged") {
      throw new SymphonyError(
        "delivery_provider_failed",
        "delivery provider observation.pullRequest.state is invalid",
      );
    }
    pullRequest = {
      id: nonEmptyString(
        pullRequestValue["id"],
        "delivery provider observation.pullRequest.id",
      ),
      url: nonEmptyString(
        pullRequestValue["url"],
        "delivery provider observation.pullRequest.url",
      ),
      state,
      baseRef: nonEmptyString(
        pullRequestValue["baseRef"],
        "delivery provider observation.pullRequest.baseRef",
      ),
      headRef: nonEmptyString(
        pullRequestValue["headRef"],
        "delivery provider observation.pullRequest.headRef",
      ),
      headSha: gitSha(
        pullRequestValue["headSha"],
        "delivery provider observation.pullRequest.headSha",
      ),
      mergeSha:
        pullRequestValue["mergeSha"] === null
          ? null
          : gitSha(
              pullRequestValue["mergeSha"],
              "delivery provider observation.pullRequest.mergeSha",
            ),
    };
  }
  if (!Array.isArray(source["requiredChecks"])) {
    throw new SymphonyError(
      "delivery_provider_failed",
      "delivery provider observation.requiredChecks must be an array",
    );
  }
  return {
    remoteHeadSha:
      source["remoteHeadSha"] === null
        ? null
        : gitSha(
            source["remoteHeadSha"],
            "delivery provider observation.remoteHeadSha",
          ),
    pullRequest,
    requiredChecks: source["requiredChecks"].map(parseCheck),
  };
}

function providerEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  secretNames: readonly string[],
  trusted: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const allowed = new Set([...SAFE_ENVIRONMENT_NAMES, ...secretNames]);
  return {
    ...Object.fromEntries(
      Object.entries(source).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && allowed.has(entry[0]),
      ),
    ),
    ...trusted,
  };
}

/** One request per trusted process; candidate code never receives this environment. */
export class ExternalDeliveryProvider implements DeliveryProvider {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #executable: string;
  readonly #sensitiveValues: readonly string[];
  readonly #timeoutMs: number;

  constructor(options: ExternalDeliveryProviderOptions) {
    if (!path.isAbsolute(options.executable)) {
      throw new SymphonyError(
        "delivery_provider_failed",
        "Trusted delivery provider executable must be absolute",
      );
    }
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
      throw new SymphonyError(
        "delivery_provider_failed",
        "Trusted delivery provider timeout must be a positive integer",
      );
    }
    if (
      options.secretEnvironmentNames.some(
        (name) => !/^[A-Z_][A-Z0-9_]*$/u.test(name),
      ) ||
      new Set(options.secretEnvironmentNames).size !==
        options.secretEnvironmentNames.length ||
      JSON.stringify(options.secretEnvironmentNames) !==
        JSON.stringify([...options.secretEnvironmentNames].sort())
    ) {
      throw new SymphonyError(
        "delivery_provider_failed",
        "Trusted delivery provider secret names must be unique, sorted uppercase environment-variable names",
      );
    }
    if (
      options.gitExecutable !== undefined &&
      !path.isAbsolute(options.gitExecutable)
    ) {
      throw new SymphonyError(
        "delivery_provider_failed",
        "Trusted provider Git executable must be absolute",
      );
    }
    if (
      options.githubHostname !== undefined &&
      !/^[A-Za-z0-9.-]+$/u.test(options.githubHostname)
    ) {
      throw new SymphonyError(
        "delivery_provider_failed",
        "Trusted provider GitHub hostname is invalid",
      );
    }
    const sourceEnvironment = options.environment ?? process.env;
    this.#executable = options.executable;
    this.#timeoutMs = options.timeoutMs;
    this.#sensitiveValues = [
      ...new Set(
        options.secretEnvironmentNames
          .map((name) => sourceEnvironment[name])
          .filter(
            (value): value is string => value !== undefined && value.length > 0,
          ),
      ),
    ].sort((left, right) => right.length - left.length);
    this.#environment = providerEnvironment(
      sourceEnvironment,
      options.secretEnvironmentNames,
      {
        ...(options.gitExecutable === undefined
          ? {}
          : { SYMPHONY_GIT_EXECUTABLE: options.gitExecutable }),
        ...(options.githubHostname === undefined
          ? {}
          : { SYMPHONY_GITHUB_HOSTNAME: options.githubHostname }),
      },
    );
  }

  execute(request: DeliveryProviderRequest): Promise<DeliveryObservation> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#executable, [], {
        cwd: "/",
        detached: process.platform !== "win32",
        env: this.#environment,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let timedOut = false;
      let settled = false;
      const terminate = () => {
        let groupTerminated = false;
        if (process.platform !== "win32" && child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
            groupTerminated = true;
          } catch (error) {
            // ESRCH means the provider group already exited. Any other group
            // failure still gets a direct-child fallback below; never throw
            // from a timer or stream callback and crash the Symphony host.
            groupTerminated = (error as NodeJS.ErrnoException).code === "ESRCH";
          }
        }
        if (!groupTerminated) {
          try {
            child.kill("SIGKILL");
          } catch {
            // The close/error event remains the single promise settlement
            // path. A concurrently exited child can make this best-effort
            // fallback race without changing the classified outcome.
          }
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, this.#timeoutMs);
      const collect = (target: Buffer[], chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > MAX_PROVIDER_OUTPUT_BYTES) terminate();
        else target.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          new SymphonyError(
            "delivery_provider_failed",
            "Could not start the trusted delivery provider",
            { cause: error },
          ),
        );
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const providerStderr = this.#redact(
          Buffer.concat(stderr)
            .subarray(-64 * 1024)
            .toString("utf8")
            .trim(),
        );
        if (timedOut) {
          reject(
            new SymphonyError(
              "delivery_provider_failed",
              `Trusted delivery provider timed out after ${this.#timeoutMs} ms`,
            ),
          );
          return;
        }
        if (outputBytes > MAX_PROVIDER_OUTPUT_BYTES) {
          reject(
            new SymphonyError(
              "delivery_provider_failed",
              `Trusted delivery provider output exceeded ${MAX_PROVIDER_OUTPUT_BYTES} bytes`,
            ),
          );
          return;
        }
        if (code !== 0) {
          reject(
            new SymphonyError(
              "delivery_provider_failed",
              `Trusted delivery provider outcome is ambiguous after exit ${code ?? "unknown"}${providerStderr === "" ? "" : `: ${providerStderr}`}`,
            ),
          );
          return;
        }
        let decoded: unknown;
        try {
          decoded = JSON.parse(Buffer.concat(stdout).toString("utf8"));
        } catch (error) {
          reject(
            new SymphonyError(
              "delivery_provider_failed",
              "Trusted delivery provider returned invalid JSON",
              { cause: error },
            ),
          );
          return;
        }
        try {
          resolve(parseObservation(decoded));
        } catch (error) {
          if (error instanceof SymphonyError) {
            reject(
              // Provider output is untrusted and may repeat a declared
              // credential. Do not retain the original error as `cause`,
              // because that would preserve the unredacted refusal reason.
              new SymphonyError(error.code, this.#redact(error.message), {
                context: error.context,
              }),
            );
          } else {
            reject(error);
          }
        }
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(
        `${JSON.stringify({ ...request, protocolVersion: PROTOCOL_VERSION })}\n`,
      );
    });
  }

  #redact(message: string): string {
    return this.#sensitiveValues.reduce(
      (result, value) => result.replaceAll(value, "[REDACTED]"),
      message,
    );
  }
}
