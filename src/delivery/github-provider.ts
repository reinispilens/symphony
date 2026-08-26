import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { crc32, inflateRawSync } from "node:zlib";

import { SymphonyError } from "../errors.js";
import { DELIVERY_OPERATIONS } from "../governance/model.js";
import { isRecord } from "../shared/json.js";
import type {
  ProofCorrelation,
  RequiredCheckObservation,
} from "../state/model.js";
import type {
  DeliveryObservation,
  DeliveryProvider,
  DeliveryProviderRequest,
  PullRequestObservation,
} from "./provider.js";

const GITHUB_API_VERSION = "2022-11-28";
const MAX_HTTP_BYTES = 8 * 1024 * 1024;
const MAX_ZIP_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;

export interface GitHubHttpResponse<T> {
  readonly status: number;
  readonly body: T;
}

export interface GitHubHttpPort {
  requestJson(
    method: string,
    pathOrUrl: string,
    body?: unknown,
  ): Promise<GitHubHttpResponse<unknown>>;
  requestBytes(pathOrUrl: string): Promise<GitHubHttpResponse<Buffer>>;
}

export interface GitHubRefPusher {
  push(
    request: Extract<DeliveryProviderRequest, { operation: "push" }>,
  ): Promise<void>;
  delete(
    request: Extract<
      DeliveryProviderRequest,
      { operation: "delete_remote_branch" }
    >,
  ): Promise<void>;
}

export interface GitHubDeliveryProviderOptions {
  readonly http: GitHubHttpPort;
  readonly refs: GitHubRefPusher;
}

export interface FetchGitHubHttpOptions {
  readonly hostname: string;
  readonly token: string;
  readonly fetchImplementation?: typeof fetch;
}

function refusal(message: string): SymphonyError {
  return new SymphonyError("delivery_provider_refused", message);
}

function failure(message: string, cause?: unknown): SymphonyError {
  return new SymphonyError("delivery_provider_failed", message, {
    ...(cause === undefined ? {} : { cause }),
  });
}

function sha256(bytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, stableJsonValue(value[key])]),
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(stableJsonValue(value));
}

function nonEmptyString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw failure(`${location} must be a non-empty string`);
  }
  return value;
}

function gitSha(value: unknown, location: string): string {
  const result = nonEmptyString(value, location);
  if (!/^[0-9a-f]{40}$/u.test(result)) {
    throw failure(`${location} must be a full lowercase Git SHA-1`);
  }
  return result;
}

function sha256Value(value: unknown, location: string): string {
  const result = nonEmptyString(value, location);
  if (!/^[0-9a-f]{64}$/u.test(result)) {
    throw failure(`${location} must be a lowercase SHA-256 value`);
  }
  return result;
}

function integer(value: unknown, location: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw failure(`${location} must be a positive safe integer`);
  }
  return value as number;
}

function boolean(value: unknown, location: string): boolean {
  if (typeof value !== "boolean") throw failure(`${location} must be boolean`);
  return value;
}

function nullableString(value: unknown, location: string): string | null {
  return value === null ? null : nonEmptyString(value, location);
}

function exactObject(
  value: unknown,
  location: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) throw failure(`${location} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw failure(`${location} has missing or unknown fields`);
  }
  return value;
}

function prefixedDigest(value: unknown, location: string): string {
  const digest = nonEmptyString(value, location);
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) {
    throw failure(`${location} must be a full lowercase SHA-256 digest`);
  }
  return digest;
}

function stringList(value: unknown, location: string): readonly string[] {
  if (!Array.isArray(value)) throw failure(`${location} must be an array`);
  const result = value.map((entry, index) =>
    nonEmptyString(entry, `${location}[${index}]`),
  );
  if (new Set(result).size !== result.length) {
    throw failure(`${location} must not contain duplicates`);
  }
  return result;
}

function githubWorkflowPath(value: unknown, location: string): string {
  const result = nonEmptyString(value, location);
  if (
    result.includes("\\") ||
    path.posix.normalize(result) !== result ||
    !result.startsWith(".github/workflows/") ||
    (!result.endsWith(".yml") && !result.endsWith(".yaml"))
  ) {
    throw failure(
      `${location} must identify a normalized GitHub workflow path`,
    );
  }
  return result;
}

/** Strict request decoder for the separate provider process boundary. */
export function parseGitHubDeliveryProviderRequest(
  value: unknown,
): DeliveryProviderRequest {
  if (!isRecord(value))
    throw failure("GitHub delivery request must be an object");
  const operation = value["operation"];
  if (
    operation !== "observe" &&
    operation !== "push" &&
    operation !== "open_pull_request" &&
    operation !== "merge_pull_request" &&
    operation !== "close_pull_request" &&
    operation !== "delete_remote_branch"
  ) {
    throw failure("GitHub delivery request operation is invalid");
  }
  const operationKeys: Readonly<Record<typeof operation, readonly string[]>> = {
    observe: [],
    push: ["sourceRoot", "expectedRemoteHeadSha"],
    open_pull_request: ["title", "body"],
    merge_pull_request: ["pullRequestId"],
    close_pull_request: ["pullRequestId"],
    delete_remote_branch: ["sourceRoot", "expectedRemoteHeadSha"],
  };
  const source = exactObject(value, "GitHub delivery request", [
    "protocolVersion",
    "operation",
    "idempotencyKey",
    "sessionId",
    "controllerGeneration",
    "repositoryIdentity",
    "grant",
    "proofAuthority",
    "tracker",
    "branch",
    "baseRef",
    "immutableHeadSha",
    ...operationKeys[operation],
  ]);
  if (source["protocolVersion"] !== 1) {
    throw failure("GitHub delivery request protocolVersion must equal 1");
  }
  const grant = exactObject(source["grant"], "GitHub delivery request.grant", [
    "authority",
    "governingPolicy",
    "requiredChecks",
  ]);
  const authorityValue = grant["authority"];
  if (authorityValue !== "owner-gated" && authorityValue !== "full-in-scope") {
    throw failure("GitHub delivery grant authority is invalid");
  }
  const authority: "owner-gated" | "full-in-scope" = authorityValue;
  const policy = exactObject(
    grant["governingPolicy"],
    "GitHub delivery request.grant.governingPolicy",
    ["repositoryIdentity", "path", "revision", "digest"],
  );
  const proofAuthority = exactObject(
    source["proofAuthority"],
    "GitHub delivery request.proofAuthority",
    [
      "kind",
      "requiredCheck",
      "eventName",
      "callerWorkflowPath",
      "controlWorkflow",
    ],
  );
  if (proofAuthority["kind"] !== "github-actions-reusable-workflow-v1") {
    throw failure("GitHub delivery proof-authority kind is invalid");
  }
  if (proofAuthority["eventName"] !== "pull_request_target") {
    throw failure("GitHub delivery proof-authority event is invalid");
  }
  const controlWorkflow = exactObject(
    proofAuthority["controlWorkflow"],
    "GitHub delivery request.proofAuthority.controlWorkflow",
    ["repositoryIdentity", "path", "revision"],
  );
  const tracker = exactObject(
    source["tracker"],
    "GitHub delivery request.tracker",
    [
      "origin",
      "issueId",
      "state",
      "stateVersion",
      "permittedOperations",
      "permitsDelivery",
      "permitsMerge",
      "permitsCleanup",
      "observedAt",
    ],
  );
  const originValue = tracker["origin"];
  if (originValue !== "tracker" && originValue !== "interactive") {
    throw failure("GitHub delivery tracker origin is invalid");
  }
  const origin: "tracker" | "interactive" = originValue;
  const permittedOperations = stringList(
    tracker["permittedOperations"],
    "GitHub delivery request.tracker.permittedOperations",
  );
  if (
    permittedOperations.some(
      (candidate) =>
        !DELIVERY_OPERATIONS.includes(
          candidate as (typeof DELIVERY_OPERATIONS)[number],
        ),
    )
  ) {
    throw failure("GitHub delivery tracker operation is invalid");
  }
  const sourceRoot =
    operation === "push" || operation === "delete_remote_branch"
      ? nonEmptyString(source["sourceRoot"], "GitHub delivery sourceRoot")
      : null;
  if (sourceRoot !== null && !path.isAbsolute(sourceRoot)) {
    throw failure("GitHub delivery sourceRoot must be absolute");
  }
  const common = {
    protocolVersion: 1 as const,
    idempotencyKey: nonEmptyString(
      source["idempotencyKey"],
      "GitHub delivery idempotencyKey",
    ),
    sessionId: nonEmptyString(source["sessionId"], "GitHub delivery sessionId"),
    controllerGeneration: integer(
      source["controllerGeneration"],
      "GitHub delivery controllerGeneration",
    ),
    repositoryIdentity: nonEmptyString(
      source["repositoryIdentity"],
      "GitHub delivery repositoryIdentity",
    ),
    grant: {
      authority,
      governingPolicy: {
        repositoryIdentity: nonEmptyString(
          policy["repositoryIdentity"],
          "GitHub delivery governing-policy repositoryIdentity",
        ),
        path: nonEmptyString(
          policy["path"],
          "GitHub delivery governing-policy path",
        ),
        revision: gitSha(
          policy["revision"],
          "GitHub delivery governing-policy revision",
        ),
        digest: prefixedDigest(
          policy["digest"],
          "GitHub delivery governing-policy digest",
        ),
      },
      requiredChecks: stringList(
        grant["requiredChecks"],
        "GitHub delivery requiredChecks",
      ),
    },
    proofAuthority: {
      kind: "github-actions-reusable-workflow-v1" as const,
      requiredCheck: nonEmptyString(
        proofAuthority["requiredCheck"],
        "GitHub delivery proof-authority requiredCheck",
      ),
      eventName: "pull_request_target" as const,
      callerWorkflowPath: githubWorkflowPath(
        proofAuthority["callerWorkflowPath"],
        "GitHub delivery proof-authority callerWorkflowPath",
      ),
      controlWorkflow: {
        repositoryIdentity: nonEmptyString(
          controlWorkflow["repositoryIdentity"],
          "GitHub delivery proof-authority control repository",
        ),
        path: githubWorkflowPath(
          controlWorkflow["path"],
          "GitHub delivery proof-authority control workflow path",
        ),
        revision: gitSha(
          controlWorkflow["revision"],
          "GitHub delivery proof-authority control revision",
        ),
      },
    },
    tracker: {
      origin,
      issueId: nullableString(
        tracker["issueId"],
        "GitHub delivery tracker issueId",
      ),
      state: nullableString(tracker["state"], "GitHub delivery tracker state"),
      stateVersion: nullableString(
        tracker["stateVersion"],
        "GitHub delivery tracker stateVersion",
      ),
      permittedOperations:
        permittedOperations as (typeof DELIVERY_OPERATIONS)[number][],
      permitsDelivery: boolean(
        tracker["permitsDelivery"],
        "GitHub delivery tracker permitsDelivery",
      ),
      permitsMerge: boolean(
        tracker["permitsMerge"],
        "GitHub delivery tracker permitsMerge",
      ),
      permitsCleanup: boolean(
        tracker["permitsCleanup"],
        "GitHub delivery tracker permitsCleanup",
      ),
      observedAt: nonEmptyString(
        tracker["observedAt"],
        "GitHub delivery tracker observedAt",
      ),
    },
    branch: nonEmptyString(source["branch"], "GitHub delivery branch"),
    baseRef: nonEmptyString(source["baseRef"], "GitHub delivery baseRef"),
    immutableHeadSha: gitSha(
      source["immutableHeadSha"],
      "GitHub delivery immutableHeadSha",
    ),
  };
  switch (operation) {
    case "observe":
      return { ...common, operation };
    case "push":
      return {
        ...common,
        operation,
        sourceRoot: sourceRoot!,
        expectedRemoteHeadSha:
          source["expectedRemoteHeadSha"] === null
            ? null
            : gitSha(
                source["expectedRemoteHeadSha"],
                "GitHub delivery expectedRemoteHeadSha",
              ),
      };
    case "open_pull_request":
      return {
        ...common,
        operation,
        title: nonEmptyString(source["title"], "GitHub delivery title"),
        body: nonEmptyString(source["body"], "GitHub delivery body"),
      };
    case "merge_pull_request":
      return {
        ...common,
        operation,
        pullRequestId: nonEmptyString(
          source["pullRequestId"],
          "GitHub delivery pullRequestId",
        ),
      };
    case "close_pull_request":
      return {
        ...common,
        operation,
        pullRequestId: nonEmptyString(
          source["pullRequestId"],
          "GitHub delivery pullRequestId",
        ),
      };
    case "delete_remote_branch":
      return {
        ...common,
        operation,
        sourceRoot: sourceRoot!,
        expectedRemoteHeadSha: gitSha(
          source["expectedRemoteHeadSha"],
          "GitHub delivery expectedRemoteHeadSha",
        ),
      };
  }
}

function repositoryParts(identity: string): {
  readonly owner: string;
  readonly repository: string;
} {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u.exec(identity);
  if (match === null) {
    throw refusal("GitHub delivery repository identity is invalid");
  }
  return { owner: match[1]!, repository: match[2]! };
}

function repositoryApiPath(identity: string): string {
  const { owner, repository } = repositoryParts(identity);
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
}

function baseBranch(baseRef: string): string {
  if (baseRef.startsWith("refs/heads/")) {
    return baseRef.slice("refs/heads/".length);
  }
  if (baseRef.startsWith("refs/remotes/origin/")) {
    return baseRef.slice("refs/remotes/origin/".length);
  }
  throw refusal(
    "GitHub delivery base ref must be refs/heads/* or refs/remotes/origin/*",
  );
}

function requiredOperation(
  request: DeliveryProviderRequest,
  operation:
    "push" | "openPullRequest" | "mergePullRequest" | "releaseRemoteBranch",
): void {
  if (!request.tracker.permittedOperations.includes(operation)) {
    throw refusal(`Current tracker authority does not permit ${operation}`);
  }
}

function authorize(request: DeliveryProviderRequest): void {
  repositoryParts(request.repositoryIdentity);
  repositoryParts(request.proofAuthority.controlWorkflow.repositoryIdentity);
  baseBranch(request.baseRef);
  if (
    !request.grant.requiredChecks.includes(request.proofAuthority.requiredCheck)
  ) {
    throw refusal(
      "Protected-proof authority does not identify a product-required check",
    );
  }
  if (
    request.tracker.origin === "tracker" &&
    (request.tracker.issueId === null || request.tracker.stateVersion === null)
  ) {
    throw refusal("Tracker delivery authority is incomplete");
  }
  switch (request.operation) {
    case "observe":
      if (request.tracker.permittedOperations.length === 0) {
        throw refusal("Current tracker authority does not permit observation");
      }
      break;
    case "push":
      requiredOperation(request, "push");
      break;
    case "open_pull_request":
      requiredOperation(request, "openPullRequest");
      break;
    case "merge_pull_request":
      requiredOperation(request, "mergePullRequest");
      if (
        request.grant.authority !== "full-in-scope" ||
        !request.tracker.permitsMerge
      ) {
        throw refusal(
          "GitHub merge requires both full-in-scope product authority and current tracker authority",
        );
      }
      break;
    case "close_pull_request":
      requiredOperation(request, "releaseRemoteBranch");
      if (request.tracker.state?.trim().toLowerCase() !== "rework") {
        throw refusal("Pull-request closure is authorized only for Rework");
      }
      break;
    case "delete_remote_branch":
      requiredOperation(request, "releaseRemoteBranch");
      break;
  }
}

function apiBase(hostname: string): string {
  const normalized = hostname.trim().toLowerCase();
  if (!/^[a-z0-9.-]+$/u.test(normalized) || normalized.includes("..")) {
    throw failure("GitHub hostname is invalid");
  }
  return normalized === "github.com"
    ? "https://api.github.com"
    : `https://${normalized}/api/v3`;
}

async function boundedBody(response: Response): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_HTTP_BYTES) {
    throw failure(`GitHub response exceeds ${MAX_HTTP_BYTES} bytes`);
  }
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.byteLength;
      if (total > MAX_HTTP_BYTES) {
        await reader.cancel();
        throw failure(`GitHub response exceeds ${MAX_HTTP_BYTES} bytes`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

/** Bounded authenticated GitHub API client used only by the provider process. */
export class FetchGitHubHttp implements GitHubHttpPort {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #token: string;

  constructor(options: FetchGitHubHttpOptions) {
    if (options.token.trim() === "") throw failure("GitHub token is missing");
    this.#baseUrl = apiBase(options.hostname);
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#token = options.token;
  }

  async requestJson(
    method: string,
    pathOrUrl: string,
    body?: unknown,
  ): Promise<GitHubHttpResponse<unknown>> {
    const response = await this.#request(method, pathOrUrl, body);
    const bytes = await boundedBody(response);
    if (bytes.byteLength === 0) return { status: response.status, body: null };
    try {
      return {
        status: response.status,
        body: JSON.parse(bytes.toString("utf8")) as unknown,
      };
    } catch (error) {
      throw failure("GitHub returned invalid JSON", error);
    }
  }

  async requestBytes(pathOrUrl: string): Promise<GitHubHttpResponse<Buffer>> {
    const response = await this.#request("GET", pathOrUrl);
    return { status: response.status, body: await boundedBody(response) };
  }

  async #request(
    method: string,
    pathOrUrl: string,
    body?: unknown,
  ): Promise<Response> {
    const url = pathOrUrl.startsWith("https://")
      ? pathOrUrl
      : `${this.#baseUrl}${pathOrUrl}`;
    if (!url.startsWith(`${this.#baseUrl}/`)) {
      throw failure("GitHub request URL is outside the configured API");
    }
    try {
      const response = await this.#fetch(url, {
        method,
        redirect: "follow",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.#token}`,
          "User-Agent": "symphony-github-delivery/1",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const finalUrl = new URL(response.url);
      const apiUrl = new URL(this.#baseUrl);
      if (
        finalUrl.protocol !== "https:" ||
        (finalUrl.origin !== apiUrl.origin &&
          !finalUrl.hostname.endsWith(".actions.githubusercontent.com") &&
          !finalUrl.hostname.endsWith(".blob.core.windows.net"))
      ) {
        throw failure(
          "GitHub redirected an artifact request to an untrusted host",
        );
      }
      return response;
    } catch (error) {
      if (error instanceof SymphonyError) throw error;
      throw failure("GitHub API request failed", error);
    }
  }
}

export interface GitCommandPort {
  execute(
    executable: string,
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
  ): Promise<{ readonly exitCode: number; readonly stderr: string }>;
}

const systemGitCommand: GitCommandPort = {
  execute(executable, args, environment) {
    return new Promise((resolve) => {
      execFile(
        executable,
        [...args],
        {
          cwd: "/",
          encoding: "utf8",
          env: environment,
          maxBuffer: MAX_GIT_OUTPUT_BYTES,
          windowsHide: true,
        },
        (error, _stdout, stderr) => {
          const code = (error as NodeJS.ErrnoException | null)?.code;
          resolve({
            exitCode: error === null ? 0 : typeof code === "number" ? code : 1,
            stderr: String(stderr),
          });
        },
      );
    });
  },
};

export interface GitHubGitRefPusherOptions {
  readonly command?: GitCommandPort;
  readonly gitExecutable: string;
  readonly hostname: string;
  readonly token: string;
}

/** Exact-head push/delete implementation; credentials stay in child environment, never argv. */
export class GitHubGitRefPusher implements GitHubRefPusher {
  readonly #command: GitCommandPort;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #gitExecutable: string;
  readonly #remoteRoot: string;
  readonly #sensitiveValues: readonly string[];

  constructor(options: GitHubGitRefPusherOptions) {
    if (!options.gitExecutable.startsWith("/")) {
      throw failure("Provider Git executable must be absolute");
    }
    if (options.token.trim() === "") throw failure("GitHub token is missing");
    const hostname = options.hostname.trim().toLowerCase();
    apiBase(hostname);
    this.#command = options.command ?? systemGitCommand;
    this.#gitExecutable = options.gitExecutable;
    this.#remoteRoot = `https://${hostname}`;
    const basicCredential = Buffer.from(
      `x-access-token:${options.token}`,
    ).toString("base64");
    this.#sensitiveValues = [options.token, basicCredential];
    this.#environment = {
      GIT_ATTR_NOSYSTEM: "1",
      LANG: "C",
      LC_ALL: "C",
      PATH: process.env["PATH"],
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_NO_LAZY_FETCH: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${basicCredential}`,
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "",
      GIT_CONFIG_KEY_2: "core.hooksPath",
      GIT_CONFIG_VALUE_2: "/dev/null",
    };
  }

  async push(
    request: Extract<DeliveryProviderRequest, { operation: "push" }>,
  ): Promise<void> {
    const expected = request.expectedRemoteHeadSha ?? "";
    await this.#execute(request, [
      `--force-with-lease=refs/heads/${request.branch}:${expected}`,
      `${request.immutableHeadSha}:refs/heads/${request.branch}`,
    ]);
  }

  async delete(
    request: Extract<
      DeliveryProviderRequest,
      { operation: "delete_remote_branch" }
    >,
  ): Promise<void> {
    await this.#execute(request, [
      `--force-with-lease=refs/heads/${request.branch}:${request.expectedRemoteHeadSha}`,
      `:refs/heads/${request.branch}`,
    ]);
  }

  async #execute(
    request: Extract<
      DeliveryProviderRequest,
      { operation: "push" | "delete_remote_branch" }
    >,
    refspecs: readonly string[],
  ): Promise<void> {
    const { owner, repository } = repositoryParts(request.repositoryIdentity);
    const remote = `${this.#remoteRoot}/${owner}/${repository}.git`;
    const result = await this.#command.execute(
      this.#gitExecutable,
      [
        "--no-pager",
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.attributesFile=/dev/null",
        "-c",
        "submodule.recurse=false",
        "-C",
        request.sourceRoot,
        "push",
        "--porcelain",
        remote,
        ...refspecs,
      ],
      this.#environment,
    );
    if (result.exitCode !== 0) {
      const redacted = this.#sensitiveValues.reduce(
        (message, value) => message.replaceAll(value, "[REDACTED]"),
        result.stderr,
      );
      throw failure(
        `Exact GitHub ref mutation failed: ${redacted.trim() || `exit ${result.exitCode}`}`,
      );
    }
  }
}

function zipEntry(archive: Buffer, expectedName: string): Buffer {
  const minimumEocd = 22;
  const searchStart = Math.max(0, archive.byteLength - 65_557);
  let eocd = -1;
  for (
    let offset = archive.byteLength - minimumEocd;
    offset >= searchStart;
    offset -= 1
  ) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0)
    throw failure("GitHub proof artifact is not a valid ZIP archive");
  const disk = archive.readUInt16LE(eocd + 4);
  const centralDisk = archive.readUInt16LE(eocd + 6);
  const entriesOnDisk = archive.readUInt16LE(eocd + 8);
  const entries = archive.readUInt16LE(eocd + 10);
  const centralSize = archive.readUInt32LE(eocd + 12);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  const commentLength = archive.readUInt16LE(eocd + 20);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entries ||
    entries > 100 ||
    centralOffset + centralSize !== eocd ||
    eocd + minimumEocd + commentLength !== archive.byteLength ||
    centralOffset < 0
  ) {
    throw failure("GitHub proof artifact ZIP directory is invalid");
  }

  let offset = centralOffset;
  const matches: Array<{
    readonly compressedSize: number;
    readonly crc: number;
    readonly flags: number;
    readonly localOffset: number;
    readonly method: number;
    readonly name: string;
    readonly uncompressedSize: number;
  }> = [];
  for (let index = 0; index < entries; index += 1) {
    if (
      offset + 46 > archive.byteLength ||
      archive.readUInt32LE(offset) !== 0x02014b50
    ) {
      throw failure("GitHub proof artifact ZIP directory is malformed");
    }
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const crc = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > archive.byteLength) {
      throw failure("GitHub proof artifact ZIP entry exceeds its archive");
    }
    const name = archive
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8");
    if (name === expectedName || name.endsWith(`/${expectedName}`)) {
      matches.push({
        compressedSize,
        crc,
        flags,
        localOffset,
        method,
        name,
        uncompressedSize,
      });
    }
    offset = end;
  }
  if (offset !== centralOffset + centralSize) {
    throw failure("GitHub proof artifact ZIP directory size is inconsistent");
  }
  if (matches.length !== 1) {
    throw failure(
      `GitHub proof artifact must contain exactly one ${expectedName}`,
    );
  }
  const match = matches[0]!;
  if (
    (match.flags & ~0x0808) !== 0 ||
    match.uncompressedSize > MAX_ZIP_ENTRY_BYTES ||
    match.compressedSize > MAX_ZIP_ENTRY_BYTES
  ) {
    throw failure(
      "GitHub proof artifact ZIP entry has unsafe flags or is oversized",
    );
  }
  const local = match.localOffset;
  if (
    local + 30 > archive.byteLength ||
    archive.readUInt32LE(local) !== 0x04034b50
  ) {
    throw failure("GitHub proof artifact ZIP local entry is malformed");
  }
  const nameLength = archive.readUInt16LE(local + 26);
  const extraLength = archive.readUInt16LE(local + 28);
  const localFlags = archive.readUInt16LE(local + 6);
  const localMethod = archive.readUInt16LE(local + 8);
  const localCrc = archive.readUInt32LE(local + 14);
  const localCompressedSize = archive.readUInt32LE(local + 18);
  const localUncompressedSize = archive.readUInt32LE(local + 22);
  const localName = archive
    .subarray(local + 30, local + 30 + nameLength)
    .toString("utf8");
  const dataStart = local + 30 + nameLength + extraLength;
  const dataEnd = dataStart + match.compressedSize;
  if (
    dataEnd > centralOffset ||
    localName !== match.name ||
    localFlags !== match.flags ||
    localMethod !== match.method ||
    ((match.flags & 0x08) === 0 &&
      (localCrc !== match.crc ||
        localCompressedSize !== match.compressedSize ||
        localUncompressedSize !== match.uncompressedSize))
  ) {
    throw failure(
      "GitHub proof artifact ZIP local entry does not match its directory",
    );
  }
  if (dataEnd > archive.byteLength) {
    throw failure("GitHub proof artifact ZIP data exceeds its archive");
  }
  const compressed = archive.subarray(dataStart, dataEnd);
  let result: Buffer;
  if (match.method === 0) result = Buffer.from(compressed);
  else if (match.method === 8) {
    try {
      result = inflateRawSync(compressed, {
        maxOutputLength: MAX_ZIP_ENTRY_BYTES,
      });
    } catch (error) {
      throw failure("GitHub proof artifact could not be decompressed", error);
    }
  } else {
    throw failure(
      `GitHub proof artifact uses unsupported ZIP method ${match.method}`,
    );
  }
  if (result.byteLength !== match.uncompressedSize) {
    throw failure(
      "GitHub proof artifact ZIP size does not match its directory",
    );
  }
  if (crc32(result) !== match.crc) {
    throw failure("GitHub proof artifact ZIP checksum is invalid");
  }
  return result;
}

function jsonDocument(
  bytes: Buffer,
  location: string,
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw failure(`${location} is invalid JSON`, error);
  }
  if (!isRecord(value)) throw failure(`${location} must be an object`);
  return value;
}

function checkStatus(
  status: unknown,
  conclusion: unknown,
): RequiredCheckObservation["status"] {
  if (status !== "completed") return "pending";
  switch (conclusion) {
    case "success":
      return "passed";
    case "failure":
    case "timed_out":
    case "action_required":
    case "startup_failure":
      return "failed";
    case "neutral":
    case "cancelled":
    case "skipped":
    case "stale":
      return "non_verdict";
    default:
      return "non_verdict";
  }
}

function workflowRunId(detailsUrl: unknown): string | null {
  if (typeof detailsUrl !== "string") return null;
  return /\/actions\/runs\/(\d+)(?:\/|$)/u.exec(detailsUrl)?.[1] ?? null;
}

function pullRequest(value: unknown): PullRequestObservation {
  if (!isRecord(value)) throw failure("GitHub pull request is malformed");
  const head = value["head"];
  const base = value["base"];
  if (!isRecord(head) || !isRecord(base)) {
    throw failure("GitHub pull request refs are malformed");
  }
  const mergedAt = value["merged_at"];
  const state = value["state"];
  return {
    id: String(integer(value["number"], "GitHub pull request number")),
    url: nonEmptyString(value["html_url"], "GitHub pull request URL"),
    state:
      mergedAt !== null && mergedAt !== undefined
        ? "merged"
        : state === "open"
          ? "open"
          : "closed",
    baseRef: nonEmptyString(base["ref"], "GitHub pull request base ref"),
    headRef: nonEmptyString(head["ref"], "GitHub pull request head ref"),
    headSha: gitSha(head["sha"], "GitHub pull request head SHA"),
    mergeSha:
      mergedAt === null || mergedAt === undefined
        ? null
        : gitSha(value["merge_commit_sha"], "GitHub pull request merge SHA"),
  };
}

/** GitHub-specific implementation behind Symphony's credential-isolated provider port. */
export class GitHubDeliveryProvider implements DeliveryProvider {
  readonly #http: GitHubHttpPort;
  readonly #refs: GitHubRefPusher;

  constructor(options: GitHubDeliveryProviderOptions) {
    this.#http = options.http;
    this.#refs = options.refs;
  }

  async execute(
    request: DeliveryProviderRequest,
  ): Promise<DeliveryObservation> {
    authorize(request);
    switch (request.operation) {
      case "observe":
        break;
      case "push":
        await this.#refs.push(request);
        break;
      case "open_pull_request":
        await this.#mutateJson(
          "POST",
          `${repositoryApiPath(request.repositoryIdentity)}/pulls`,
          {
            title: request.title,
            body: request.body,
            head: request.branch,
            base: baseBranch(request.baseRef),
          },
          [201],
        );
        break;
      case "merge_pull_request":
        await this.#mutateJson(
          "PUT",
          `${repositoryApiPath(request.repositoryIdentity)}/pulls/${encodeURIComponent(request.pullRequestId)}/merge`,
          { sha: request.immutableHeadSha, merge_method: "squash" },
          [200],
        );
        break;
      case "close_pull_request":
        await this.#mutateJson(
          "PATCH",
          `${repositoryApiPath(request.repositoryIdentity)}/pulls/${encodeURIComponent(request.pullRequestId)}`,
          { state: "closed" },
          [200],
        );
        break;
      case "delete_remote_branch":
        await this.#refs.delete(request);
        break;
    }
    return this.#observe(request);
  }

  async #observe(
    request: DeliveryProviderRequest,
  ): Promise<DeliveryObservation> {
    const repository = repositoryApiPath(request.repositoryIdentity);
    const branch = encodeURIComponent(request.branch);
    const ref = await this.#http.requestJson(
      "GET",
      `${repository}/git/ref/heads/${branch}`,
    );
    let remoteHeadSha: string | null;
    if (ref.status === 404) remoteHeadSha = null;
    else {
      this.#expectStatus(ref.status, [200], "read the remote branch");
      const object = isRecord(ref.body) ? ref.body["object"] : null;
      if (!isRecord(object)) throw failure("GitHub ref response is malformed");
      remoteHeadSha = gitSha(object["sha"], "GitHub remote ref SHA");
    }

    const { owner } = repositoryParts(request.repositoryIdentity);
    const query = new URLSearchParams({
      state: "all",
      head: `${owner}:${request.branch}`,
      base: baseBranch(request.baseRef),
      per_page: "100",
    });
    const pulls = await this.#http.requestJson(
      "GET",
      `${repository}/pulls?${query.toString()}`,
    );
    this.#expectStatus(pulls.status, [200], "list exact pull requests");
    if (!Array.isArray(pulls.body)) {
      throw failure("GitHub pull-request list is malformed");
    }
    const matchingPulls = pulls.body
      .map(pullRequest)
      .filter(
        (candidate) =>
          candidate.headRef === request.branch &&
          candidate.baseRef === baseBranch(request.baseRef) &&
          candidate.headSha === request.immutableHeadSha,
      )
      .map((candidate) => ({ ...candidate, baseRef: request.baseRef }));
    if (matchingPulls.length > 1) {
      throw refusal(
        "More than one GitHub pull request matches the exact delivery branch",
      );
    }

    const requiredChecks: RequiredCheckObservation[] = [];
    const proof: ProofCorrelation[] = [];
    for (const name of request.grant.requiredChecks) {
      const observed = await this.#requiredCheck(request, name);
      requiredChecks.push(observed.check);
      if (observed.proof !== null) proof.push(observed.proof);
    }
    return {
      remoteHeadSha,
      pullRequest: matchingPulls[0] ?? null,
      requiredChecks,
      proof,
    };
  }

  async #requiredCheck(
    request: DeliveryProviderRequest,
    name: string,
  ): Promise<{
    readonly check: RequiredCheckObservation;
    readonly proof: ProofCorrelation | null;
  }> {
    const repository = repositoryApiPath(request.repositoryIdentity);
    const query = new URLSearchParams({
      check_name: name,
      filter: "latest",
      per_page: "100",
    });
    const response = await this.#http.requestJson(
      "GET",
      `${repository}/commits/${request.immutableHeadSha}/check-runs?${query.toString()}`,
    );
    this.#expectStatus(response.status, [200], `read required check ${name}`);
    const runs = isRecord(response.body) ? response.body["check_runs"] : null;
    if (!Array.isArray(runs))
      throw failure("GitHub check-run list is malformed");
    const matches = runs.filter(
      (candidate) => isRecord(candidate) && candidate["name"] === name,
    );
    if (matches.length === 0) {
      return {
        check: {
          name,
          headSha: request.immutableHeadSha,
          checkRunId: null,
          workflowRunId: null,
          status: "pending",
          observedAt: null,
        },
        proof: null,
      };
    }
    if (matches.length !== 1 || !isRecord(matches[0])) {
      throw refusal(
        `Expected exactly one latest GitHub check run named ${name}`,
      );
    }
    const run = matches[0];
    const headSha = gitSha(run["head_sha"], `GitHub check ${name} head SHA`);
    const checkRunId = String(integer(run["id"], `GitHub check ${name} id`));
    const workflowId = workflowRunId(run["details_url"]);
    let status = checkStatus(run["status"], run["conclusion"]);
    let admittedProof: ProofCorrelation | null = null;
    const protectedProof = name === request.proofAuthority.requiredCheck;
    if (protectedProof) {
      const app = run["app"];
      if (!isRecord(app) || app["slug"] !== "github-actions") {
        throw refusal(
          "Protected-proof check was not published by GitHub Actions",
        );
      }
    }
    if (status === "passed" && protectedProof && workflowId === null) {
      status = "non_verdict";
    } else if (status === "passed" && protectedProof && workflowId !== null) {
      admittedProof = await this.#protectedProof(
        request,
        name,
        checkRunId,
        workflowId,
        run,
      );
      status = admittedProof.status;
    }
    return {
      check: {
        name,
        headSha,
        checkRunId,
        workflowRunId: workflowId,
        status,
        observedAt:
          status === "pending"
            ? null
            : nonEmptyString(
                run["completed_at"],
                `GitHub check ${name} completion time`,
              ),
      },
      proof: admittedProof,
    };
  }

  async #protectedProof(
    request: DeliveryProviderRequest,
    checkName: string,
    checkRunId: string,
    runId: string,
    checkRun: Record<string, unknown>,
  ): Promise<ProofCorrelation> {
    const repository = repositoryApiPath(request.repositoryIdentity);
    const run = await this.#http.requestJson(
      "GET",
      `${repository}/actions/runs/${runId}`,
    );
    this.#expectStatus(run.status, [200], "read protected-proof workflow run");
    if (!isRecord(run.body)) throw failure("GitHub workflow run is malformed");
    const runRepository = run.body["repository"];
    const expectedWorkflow = request.proofAuthority.controlWorkflow;
    const referencedWorkflows = run.body["referenced_workflows"];
    const expectedReference = `${expectedWorkflow.repositoryIdentity}/${expectedWorkflow.path}@${expectedWorkflow.revision}`;
    const matchingReferences = Array.isArray(referencedWorkflows)
      ? referencedWorkflows.filter(
          (candidate) =>
            isRecord(candidate) &&
            candidate["path"] === expectedReference &&
            candidate["sha"] === expectedWorkflow.revision,
        )
      : [];
    if (
      String(integer(run.body["id"], "GitHub workflow run id")) !== runId ||
      !isRecord(runRepository) ||
      runRepository["full_name"] !== request.repositoryIdentity ||
      run.body["event"] !== request.proofAuthority.eventName ||
      run.body["head_sha"] !== request.immutableHeadSha ||
      run.body["path"] !== request.proofAuthority.callerWorkflowPath ||
      matchingReferences.length !== 1
    ) {
      throw refusal(
        "Protected-proof workflow run does not match its pinned repository, event, head, caller, and control workflow",
      );
    }
    const attempt = integer(
      run.body["run_attempt"],
      "GitHub workflow run attempt",
    );
    const artifacts = await this.#http.requestJson(
      "GET",
      `${repository}/actions/runs/${runId}/artifacts?per_page=100`,
    );
    this.#expectStatus(
      artifacts.status,
      [200],
      "list protected-proof artifacts",
    );
    const values = isRecord(artifacts.body)
      ? artifacts.body["artifacts"]
      : null;
    if (!Array.isArray(values)) {
      throw failure("GitHub protected-proof artifact list is malformed");
    }
    const artifact = async (kind: "plan" | "result"): Promise<Buffer> => {
      const expected = `protected-proof-v2-${kind}-${runId}-${attempt}`;
      const matches = values.filter(
        (candidate) =>
          isRecord(candidate) &&
          candidate["name"] === expected &&
          candidate["expired"] === false,
      );
      if (matches.length !== 1 || !isRecord(matches[0])) {
        throw refusal(`Expected one unexpired ${expected} artifact`);
      }
      const id = integer(matches[0]["id"], `GitHub ${kind} artifact id`);
      const downloaded = await this.#http.requestBytes(
        `${repository}/actions/artifacts/${id}/zip`,
      );
      this.#expectStatus(downloaded.status, [200], `download ${kind} artifact`);
      return zipEntry(downloaded.body, `${kind}.json`);
    };
    const [planBytes, resultBytes] = await Promise.all([
      artifact("plan"),
      artifact("result"),
    ]);
    const plan = jsonDocument(planBytes, "protected proof plan");
    const result = jsonDocument(resultBytes, "protected proof result");
    const correlation = plan["correlation"];
    const source = plan["source"];
    const head = isRecord(source) ? source["head"] : null;
    const authority = plan["authority"];
    if (
      plan["schemaVersion"] !== 2 ||
      !isRecord(correlation) ||
      correlation["repository"] !== request.repositoryIdentity ||
      correlation["eventName"] !== request.proofAuthority.eventName ||
      correlation["controlWorkflowRepository"] !==
        expectedWorkflow.repositoryIdentity ||
      correlation["controlWorkflowSha"] !== expectedWorkflow.revision ||
      typeof correlation["callerWorkflowRef"] !== "string" ||
      !correlation["callerWorkflowRef"].startsWith(
        `${request.repositoryIdentity}/${request.proofAuthority.callerWorkflowPath}@`,
      ) ||
      !isRecord(head) ||
      head["commit"] !== request.immutableHeadSha ||
      !isRecord(authority) ||
      authority["controlSourceRepository"] !==
        expectedWorkflow.repositoryIdentity ||
      authority["controlSourceRevision"] !== expectedWorkflow.revision
    ) {
      throw refusal("Protected proof plan does not match this delivery head");
    }
    if (
      String(
        integer(correlation["runId"], "protected proof correlation run id"),
      ) !== runId ||
      integer(
        correlation["runAttempt"],
        "protected proof correlation run attempt",
      ) !== attempt
    ) {
      throw refusal(
        "Protected proof plan does not match this workflow run attempt",
      );
    }
    const planDigest = sha256Value(
      plan["digest"],
      "protected proof plan digest",
    );
    const { digest: _digest, ...planIdentity } = plan;
    if (sha256(canonicalJson(planIdentity)) !== `sha256:${planDigest}`) {
      throw refusal("Protected proof plan digest is stale");
    }
    if (
      result["schemaVersion"] !== 2 ||
      result["repository"] !== request.repositoryIdentity ||
      result["sourceCommit"] !== request.immutableHeadSha ||
      result["planDigest"] !== planDigest
    ) {
      throw refusal(
        "Protected proof result does not match its plan and delivery head",
      );
    }
    const status = result["status"];
    if (
      status !== "passed" &&
      status !== "failed" &&
      status !== "setup_refused" &&
      status !== "non_verdict"
    ) {
      throw failure("Protected proof result status is invalid");
    }
    if (status === "passed" && result["cleanup"] !== "complete") {
      throw refusal("Protected proof cannot pass with incomplete cleanup");
    }
    const laneResults = result["laneResults"];
    if (!Array.isArray(laneResults)) {
      throw failure("Protected proof result laneResults is malformed");
    }
    const evidence = laneResults.map((lane, index) => {
      if (!isRecord(lane)) {
        throw failure(`Protected proof lane ${index} is malformed`);
      }
      return {
        laneId: nonEmptyString(
          lane["laneId"],
          `Protected proof lane ${index} id`,
        ),
        receiptSha256: sha256Value(
          lane["receiptSha256"],
          `Protected proof lane ${index} receipt digest`,
        ),
      };
    });
    const completedAt = nonEmptyString(
      checkRun["completed_at"],
      "protected proof completion time",
    );
    return {
      id: `github-actions:${runId}:${checkRunId}`,
      checkName,
      checkRunId,
      workflowRunId: runId,
      sourceSha: request.immutableHeadSha,
      planDigest: `sha256:${planDigest}`,
      adapterDigest: `sha256:${sha256Value(
        authority["controlSourceSha256"],
        "protected proof control-source digest",
      )}`,
      policyDigest: `sha256:${sha256Value(
        authority["headPolicySha256"],
        "protected proof policy digest",
      )}`,
      resultDigest: sha256(resultBytes),
      evidenceDigest: sha256(JSON.stringify(evidence)),
      status,
      recordedAt: nonEmptyString(
        run.body["created_at"],
        "protected proof workflow creation time",
      ),
      observedAt: completedAt,
    };
  }

  async #mutateJson(
    method: string,
    path: string,
    body: unknown,
    accepted: readonly number[],
  ): Promise<void> {
    const response = await this.#http.requestJson(method, path, body);
    this.#expectStatus(response.status, accepted, `apply ${method} ${path}`);
  }

  #expectStatus(
    status: number,
    accepted: readonly number[],
    action: string,
  ): void {
    if (!accepted.includes(status)) {
      throw failure(`GitHub could not ${action} (HTTP ${status})`);
    }
  }
}
