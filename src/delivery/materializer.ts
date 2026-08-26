import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { errorMessage, SymphonyError } from "../errors.js";
import {
  trustedGitArguments,
  trustedGitEnvironment,
} from "../repository/git-process.js";
import type {
  ManagedWorkspaceLease,
  SourceMaterializationInputEntry,
  SourceMaterializationRecord,
} from "../state/model.js";
import type { SymphonyStateStore } from "../state/store.js";

const GIT_TIMEOUT_MS = 30_000;
const GIT_OUTPUT_LIMIT = 32 * 1024 * 1024;

export const SOURCE_MATERIALIZATION_POLICY_V1 = Object.freeze({
  schemaVersion: 1,
  tracked: "current-worktree-bytes-including-deletions",
  untracked: "non-ignored-current-worktree-bytes",
  excludedSegments: [".pnpm-store", ".symphony-runtime", "node_modules"],
  executableFilters: false,
  hooks: false,
  nestedRepositories: false,
  submodules: false,
  maxFiles: 20_000,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxPathBytes: 4_096,
});

function sha256(bytes: string | Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export const SOURCE_MATERIALIZATION_POLICY_DIGEST = sha256(
  JSON.stringify(SOURCE_MATERIALIZATION_POLICY_V1),
);

interface CommandResult {
  readonly exitCode: number;
  readonly stderr: Buffer;
  readonly stdout: Buffer;
}

interface GitCommandOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly input?: Buffer;
}

interface ParentEntry {
  readonly mode: string;
  readonly path: string;
  readonly type: string;
}

interface Snapshot {
  readonly digest: string;
  readonly entries: readonly SourceMaterializationInputEntry[];
}

export interface MaterializationAuthority {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly workspaceLeaseToken: string;
  readonly controllerGeneration: number;
}

export interface TrustedSourceMaterializerOptions {
  readonly gitExecutable: string;
  readonly stateRoot: string;
  readonly stateStore: SymphonyStateStore;
  readonly now?: () => Date;
}

function refuse(message: string, cause?: unknown): never {
  throw new SymphonyError("materialization_refused", message, {
    ...(cause === undefined ? {} : { cause }),
  });
}

function runCommand(
  file: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  input?: Buffer,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, GIT_TIMEOUT_MS);
    const collect = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > GIT_OUTPUT_LIMIT) {
        child.kill("SIGKILL");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (outputBytes > GIT_OUTPUT_LIMIT) {
        reject(new Error(`command output exceeded ${GIT_OUTPUT_LIMIT} bytes`));
        return;
      }
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

async function gitResult(
  executable: string,
  repositoryRoot: string,
  args: readonly string[],
  options: GitCommandOptions = {},
): Promise<CommandResult> {
  return runCommand(
    executable,
    trustedGitArguments(repositoryRoot, [
      "-c",
      "commit.gpgSign=false",
      "-c",
      "core.excludesFile=/dev/null",
      ...args,
    ]),
    { ...trustedGitEnvironment(), ...options.environment },
    options.input,
  );
}

async function git(
  executable: string,
  repositoryRoot: string,
  args: readonly string[],
  options: GitCommandOptions = {},
): Promise<Buffer> {
  const result = await gitResult(executable, repositoryRoot, args, options);
  if (result.exitCode !== 0) {
    throw new SymphonyError(
      "materialization_failed",
      `Git ${args[0] ?? "operation"} failed: ${result.stderr.toString("utf8").trim() || `exit ${result.exitCode}`}`,
    );
  }
  return result.stdout;
}

function text(buffer: Buffer): string {
  return buffer.toString("utf8").trim();
}

function nulStrings(buffer: Buffer): readonly string[] {
  const source = buffer.toString("utf8");
  const values = source.split("\0");
  if (values.at(-1) === "") values.pop();
  return values;
}

function safeRelativePath(value: string): string {
  if (
    value === "" ||
    value.includes("\\") ||
    /[\0\r\n]/u.test(value) ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value.startsWith("../") ||
    Buffer.byteLength(value) > SOURCE_MATERIALIZATION_POLICY_V1.maxPathBytes
  ) {
    refuse(
      `Materialization encountered unsupported path ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function excludedRuntimePath(relativePath: string): boolean {
  const excluded = new Set(SOURCE_MATERIALIZATION_POLICY_V1.excludedSegments);
  return relativePath.split("/").some((segment) => excluded.has(segment));
}

async function walkFiles(
  root: string,
  current = root,
): Promise<readonly string[]> {
  const results: string[] = [];
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = safeRelativePath(
      path.relative(root, absolute).split(path.sep).join("/"),
    );
    if (relative === ".git") continue;
    if (entry.name === ".git") {
      refuse(`Nested repository metadata is not materializable: ${relative}`);
    }
    const observed = await lstat(absolute);
    if (observed.isDirectory() && !observed.isSymbolicLink()) {
      results.push(...(await walkFiles(root, absolute)));
      continue;
    }
    if (!observed.isFile() && !observed.isSymbolicLink()) {
      refuse(`Unsupported filesystem entry in materialization: ${relative}`);
    }
    results.push(relative);
    if (results.length > SOURCE_MATERIALIZATION_POLICY_V1.maxFiles) {
      refuse(
        `Materialization exceeds ${SOURCE_MATERIALIZATION_POLICY_V1.maxFiles} files`,
      );
    }
  }
  return results;
}

async function parentEntries(
  executable: string,
  workspacePath: string,
  parentSha: string,
): Promise<ReadonlyMap<string, ParentEntry>> {
  const output = await git(executable, workspacePath, [
    "ls-tree",
    "-r",
    "-z",
    parentSha,
  ]);
  const entries = new Map<string, ParentEntry>();
  for (const row of nulStrings(output)) {
    const match = /^(\d{6}) ([^ ]+) [0-9a-f]{40}\t(.+)$/u.exec(row);
    if (match === null) refuse("Parent tree contains an unsupported entry");
    const mode = match[1]!;
    const type = match[2]!;
    const entryPath = safeRelativePath(match[3]!);
    if (mode === "160000" || type !== "blob") {
      refuse(`Submodule or non-blob parent entry is unsupported: ${entryPath}`);
    }
    entries.set(entryPath, { mode, path: entryPath, type });
  }
  return entries;
}

async function ignoredPaths(
  executable: string,
  workspacePath: string,
  paths: readonly string[],
): Promise<ReadonlySet<string>> {
  if (paths.length === 0) return new Set();
  const input = Buffer.from(`${paths.join("\0")}\0`);
  const result = await gitResult(
    executable,
    workspacePath,
    ["check-ignore", "--no-index", "-z", "--stdin"],
    { input },
  );
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    refuse(
      `Could not apply the fixed ignored-file policy: ${result.stderr.toString("utf8").trim() || `exit ${result.exitCode}`}`,
    );
  }
  return new Set(nulStrings(result.stdout));
}

async function readEntry(
  executable: string,
  workspacePath: string,
  relativePath: string,
  origin: SourceMaterializationInputEntry["origin"],
): Promise<SourceMaterializationInputEntry> {
  const absolute = path.join(workspacePath, ...relativePath.split("/"));
  const before = await lstat(absolute);
  let bytes: Buffer;
  let kind: SourceMaterializationInputEntry["kind"];
  let mode: SourceMaterializationInputEntry["mode"];
  if (before.isSymbolicLink()) {
    kind = "symlink";
    mode = "120000";
    bytes = Buffer.from(await readlink(absolute));
  } else if (before.isFile()) {
    kind = "regular";
    mode = (before.mode & 0o111) === 0 ? "100644" : "100755";
    if (before.size > SOURCE_MATERIALIZATION_POLICY_V1.maxFileBytes) {
      refuse(
        `Materialization file ${relativePath} exceeds ${SOURCE_MATERIALIZATION_POLICY_V1.maxFileBytes} bytes`,
      );
    }
    const handle = await open(
      absolute,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino
      ) {
        refuse(`Materialization entry changed while opening: ${relativePath}`);
      }
      bytes = await handle.readFile();
      const read = await handle.stat();
      if (
        read.dev !== opened.dev ||
        read.ino !== opened.ino ||
        read.mode !== opened.mode ||
        read.size !== opened.size ||
        read.mtimeMs !== opened.mtimeMs
      ) {
        refuse(`Materialization entry changed while reading: ${relativePath}`);
      }
    } finally {
      await handle.close();
    }
  } else {
    refuse(`Materialization entry changed type while reading: ${relativePath}`);
  }
  const after = await lstat(absolute);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mode !== after.mode ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    refuse(`Materialization entry changed while reading: ${relativePath}`);
  }
  const blobSha = text(
    await git(
      executable,
      workspacePath,
      ["hash-object", "-w", "--stdin", "--no-filters"],
      { input: bytes },
    ),
  );
  if (!/^[0-9a-f]{40}$/u.test(blobSha)) {
    refuse(`Git returned an invalid blob identity for ${relativePath}`);
  }
  return {
    path: relativePath,
    kind,
    mode,
    size: bytes.byteLength,
    contentDigest: sha256(bytes),
    blobSha,
    origin,
  };
}

async function snapshotWorkspace(
  executable: string,
  workspacePath: string,
  parent: ReadonlyMap<string, ParentEntry>,
): Promise<Snapshot> {
  const discovered = await walkFiles(workspacePath);
  if (discovered.includes(".gitmodules") || parent.has(".gitmodules")) {
    refuse("Repositories with submodule declarations are not materializable");
  }
  const ignored = await ignoredPaths(executable, workspacePath, discovered);
  const selected: Array<{
    path: string;
    origin: SourceMaterializationInputEntry["origin"];
  }> = [];
  for (const candidate of discovered) {
    const tracked = parent.has(candidate);
    if (excludedRuntimePath(candidate)) {
      if (tracked) {
        refuse(`Tracked runtime/cache path is unsupported: ${candidate}`);
      }
      continue;
    }
    if (!tracked && ignored.has(candidate)) continue;
    selected.push({
      path: candidate,
      origin: tracked ? "tracked" : "untracked",
    });
  }
  selected.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const entries: SourceMaterializationInputEntry[] = [];
  let totalBytes = 0;
  for (const selectedEntry of selected) {
    const entry = await readEntry(
      executable,
      workspacePath,
      selectedEntry.path,
      selectedEntry.origin,
    );
    totalBytes += entry.size;
    if (totalBytes > SOURCE_MATERIALIZATION_POLICY_V1.maxTotalBytes) {
      refuse(
        `Materialization exceeds ${SOURCE_MATERIALIZATION_POLICY_V1.maxTotalBytes} total bytes`,
      );
    }
    entries.push(entry);
  }
  for (const entry of entries) {
    if (!entry.path.endsWith(".gitattributes")) continue;
    if (entry.kind !== "regular") {
      refuse(`Git attributes must not be a symlink: ${entry.path}`);
    }
    const contents = await readFile(
      path.join(workspacePath, entry.path),
      "utf8",
    );
    if (
      contents
        .split(/\r?\n/u)
        .some(
          (line) =>
            !line.trimStart().startsWith("#") &&
            /(?:^|\s)-?filter(?:=|\s|$)/u.test(line),
        )
    ) {
      refuse(`Git filter attributes are unsupported: ${entry.path}`);
    }
  }
  return {
    entries,
    digest: sha256(JSON.stringify({ schemaVersion: 1, entries })),
  };
}

async function verifyRepositoryFacts(
  executable: string,
  lease: ManagedWorkspaceLease,
): Promise<void> {
  const workspacePath = await realpath(lease.path);
  if (workspacePath !== path.resolve(lease.path)) {
    refuse(`Managed workspace realpath changed: ${lease.path}`);
  }
  const gitPointer = await lstat(path.join(workspacePath, ".git"));
  if (!gitPointer.isFile() || gitPointer.isSymbolicLink()) {
    refuse("Managed linked-worktree .git pointer must be a regular file");
  }
  const topLevel = text(
    await git(executable, workspacePath, ["rev-parse", "--show-toplevel"]),
  );
  if (path.resolve(topLevel) !== workspacePath) {
    refuse("Managed workspace no longer resolves to its recorded Git root");
  }
  const observedCommon = text(
    await git(executable, workspacePath, ["rev-parse", "--git-common-dir"]),
  );
  const expectedCommon = text(
    await git(executable, lease.sourceRoot, ["rev-parse", "--git-common-dir"]),
  );
  if (
    (await realpath(path.resolve(workspacePath, observedCommon))) !==
    (await realpath(path.resolve(lease.sourceRoot, expectedCommon)))
  ) {
    refuse(
      "Managed workspace Git common directory no longer matches its source",
    );
  }
  const symbolicHead = text(
    await git(executable, workspacePath, ["symbolic-ref", "-q", "HEAD"]),
  );
  if (symbolicHead !== `refs/heads/${lease.branch}`) {
    refuse(`Managed workspace is not on its recorded branch ${lease.branch}`);
  }
  const sparse = await gitResult(executable, workspacePath, [
    "config",
    "--bool",
    "core.sparseCheckout",
  ]);
  if (sparse.exitCode !== 0 && sparse.exitCode !== 1) {
    refuse("Could not inspect sparse-checkout state");
  }
  if (text(sparse.stdout) === "true") {
    refuse("Sparse checkouts are unsupported for source materialization");
  }
  const filters = await gitResult(executable, workspacePath, [
    "config",
    "--get-regexp",
    "^filter\\..*\\.(clean|smudge|process)$",
  ]);
  if (filters.exitCode !== 0 && filters.exitCode !== 1) {
    refuse("Could not inspect Git filter configuration");
  }
  if (text(filters.stdout) !== "") {
    refuse("Executable Git clean/smudge/process filters are unsupported");
  }
  const infoExclude = path.join(
    await realpath(path.resolve(lease.sourceRoot, expectedCommon)),
    "info",
    "exclude",
  );
  try {
    const activeExclude = (await readFile(infoExclude, "utf8"))
      .split(/\r?\n/u)
      .some((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
    if (activeExclude) {
      refuse("Repository-local info/exclude rules are unsupported");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function buildTree(
  executable: string,
  workspacePath: string,
  indexPath: string,
  entries: readonly SourceMaterializationInputEntry[],
): Promise<string> {
  const environment = { GIT_INDEX_FILE: indexPath };
  await git(executable, workspacePath, ["read-tree", "--empty"], {
    environment,
  });
  const indexInfo = Buffer.from(
    entries
      .map((entry) => `${entry.mode} blob ${entry.blobSha}\t${entry.path}\0`)
      .join(""),
  );
  if (indexInfo.byteLength > 0) {
    await git(
      executable,
      workspacePath,
      ["update-index", "-z", "--index-info"],
      {
        environment,
        input: indexInfo,
      },
    );
  }
  const treeSha = text(
    await git(executable, workspacePath, ["write-tree"], { environment }),
  );
  if (!/^[0-9a-f]{40}$/u.test(treeSha)) {
    refuse("Git returned an invalid materialized tree identity");
  }
  return treeSha;
}

async function writeCommit(
  executable: string,
  workspacePath: string,
  record: SourceMaterializationRecord,
  treeSha: string,
): Promise<string> {
  const message = [
    "Symphony: materialize authored work",
    "",
    `WorkSession-Materialization: ${record.id}`,
    `Input-Manifest: ${record.inputManifestDigest}`,
    "",
  ].join("\n");
  const identityEnvironment = {
    GIT_AUTHOR_NAME: "Symphony",
    GIT_AUTHOR_EMAIL: "symphony@localhost",
    GIT_AUTHOR_DATE: record.startedAt,
    GIT_COMMITTER_NAME: "Symphony",
    GIT_COMMITTER_EMAIL: "symphony@localhost",
    GIT_COMMITTER_DATE: record.startedAt,
  };
  const commitSha = text(
    await git(
      executable,
      workspacePath,
      ["commit-tree", treeSha, "-p", record.parentSha],
      { environment: identityEnvironment, input: Buffer.from(message) },
    ),
  );
  if (!/^[0-9a-f]{40}$/u.test(commitSha)) {
    refuse("Git returned an invalid materialized commit identity");
  }
  return commitSha;
}

function currentMaterialization(
  stateStore: SymphonyStateStore,
  sessionId: string,
  materializationId: string,
): SourceMaterializationRecord {
  const session = stateStore.getSession(sessionId);
  const record = session?.materializations.find(
    (candidate) => candidate.id === materializationId,
  );
  if (record === undefined) {
    refuse(
      `Materialization ${materializationId} disappeared from durable state`,
    );
  }
  return record;
}

async function processIdentity(): Promise<{
  readonly bootId: string;
  readonly pid: number;
  readonly startTicks: string;
}> {
  const [bootId, stat] = await Promise.all([
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    readFile("/proc/self/stat", "utf8"),
  ]);
  return {
    bootId: bootId.trim(),
    pid: process.pid,
    startTicks: processStartTicks(stat),
  };
}

function processStartTicks(stat: string): string {
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) refuse("Could not parse Linux process identity");
  // Fields after the command begin with field 3; starttime is field 22.
  const fields = stat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/u);
  const startTicks = fields[19];
  if (startTicks === undefined || !/^\d+$/u.test(startTicks)) {
    refuse("Could not parse Linux process start time");
  }
  return startTicks;
}

async function acquireFence(
  stateRoot: string,
  workspacePath: string,
  materializationId: string,
): Promise<() => Promise<void>> {
  const root = path.resolve(stateRoot);
  try {
    const existingRoot = await lstat(root);
    if (!existingRoot.isDirectory() || existingRoot.isSymbolicLink()) {
      refuse("Materialization state root must be a real directory");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const resolvedRoot = await realpath(root);
  if (resolvedRoot !== root) {
    refuse(
      "Materialization state root must contain no symbolic-link components",
    );
  }
  const lockRoot = path.join(resolvedRoot, "materialization-locks");
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  const lockRootEntry = await lstat(lockRoot);
  if (!lockRootEntry.isDirectory() || lockRootEntry.isSymbolicLink()) {
    refuse("Materialization lock root must be a real directory");
  }
  const lockName = createHash("sha256").update(workspacePath).digest("hex");
  const lockPath = path.join(lockRoot, lockName);
  const ownerPath = path.join(lockPath, "owner.json");
  const identity = await processIdentity();
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let owner: { bootId?: unknown; pid?: unknown; startTicks?: unknown } = {};
    try {
      owner = JSON.parse(await readFile(ownerPath, "utf8")) as typeof owner;
    } catch {
      refuse(`Materialization fence ${lockPath} has ambiguous ownership`);
    }
    let live = false;
    if (
      owner.bootId === identity.bootId &&
      typeof owner.pid === "number" &&
      typeof owner.startTicks === "string"
    ) {
      try {
        const otherStat = await readFile(`/proc/${owner.pid}/stat`, "utf8");
        live = processStartTicks(otherStat) === owner.startTicks;
      } catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw probeError;
        }
      }
    }
    if (live) refuse(`Workspace already holds a live materialization fence`);
    await rm(lockPath, { recursive: true });
    await mkdir(lockPath, { mode: 0o700 });
  }
  await writeFile(
    ownerPath,
    `${JSON.stringify({ ...identity, materializationId })}\n`,
    { mode: 0o600 },
  );
  return async () => {
    const resolvedLock = await realpath(lockPath);
    if (path.dirname(resolvedLock) !== lockRoot) {
      refuse("Materialization fence escaped its trusted lock root");
    }
    await rm(lockPath, { recursive: true });
  };
}

/**
 * Turns one quiescent managed worktree into a recorded immutable commit.
 * It never stages through the candidate index and never invokes product hooks or filters.
 */
export class TrustedSourceMaterializer {
  readonly #gitExecutable: string;
  readonly #now: () => Date;
  readonly #stateRoot: string;
  readonly #stateStore: SymphonyStateStore;

  constructor(options: TrustedSourceMaterializerOptions) {
    this.#gitExecutable = options.gitExecutable;
    this.#stateRoot = path.resolve(options.stateRoot);
    this.#stateStore = options.stateStore;
    this.#now = options.now ?? (() => new Date());
  }

  async materialize(
    authority: MaterializationAuthority,
  ): Promise<SourceMaterializationRecord> {
    const session = this.#stateStore.getSession(authority.sessionId);
    const attempt = session?.attempts.find(
      (candidate) => candidate.id === authority.attemptId,
    );
    const lease = attempt?.workspaceLease;
    if (
      session === null ||
      session === undefined ||
      lease?.mode !== "managed" ||
      lease.leaseToken !== authority.workspaceLeaseToken
    ) {
      refuse(
        "Materialization authority does not identify a managed workspace lease",
      );
    }
    await verifyRepositoryFacts(this.#gitExecutable, lease);
    await git(this.#gitExecutable, lease.path, [
      "rev-parse",
      `refs/heads/${lease.branch}^{commit}`,
    ]);
    const begun = this.#stateStore.beginMaterialization({
      ...authority,
      parentSha: lease.baseSha,
      branch: lease.branch,
      expectedOldSha: lease.baseSha,
      inclusionPolicyDigest: SOURCE_MATERIALIZATION_POLICY_DIGEST,
      now: this.#now().toISOString(),
    });
    const materializationId = begun.materializationId;
    const releaseFence = await acquireFence(
      this.#stateRoot,
      lease.path,
      materializationId,
    );
    const temporaryRoot = path.join(
      this.#stateRoot,
      "materialization",
      session.id,
      materializationId,
    );
    let branchMovedByThisInvocation = false;
    try {
      await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
      const temporaryEntry = await lstat(temporaryRoot);
      if (!temporaryEntry.isDirectory() || temporaryEntry.isSymbolicLink()) {
        refuse("Materialization temporary root must be a real directory");
      }
      const parent = await parentEntries(
        this.#gitExecutable,
        lease.path,
        lease.baseSha,
      );
      const first = await snapshotWorkspace(
        this.#gitExecutable,
        lease.path,
        parent,
      );
      let record = currentMaterialization(
        this.#stateStore,
        session.id,
        materializationId,
      );
      if (record.phase === "intent_recorded") {
        this.#stateStore.transitionMaterialization({
          sessionId: session.id,
          materializationId,
          controllerGeneration: authority.controllerGeneration,
          expectedPhases: ["intent_recorded"],
          phase: "snapshot_recorded",
          inputManifestDigest: first.digest,
          inputManifest: first.entries,
          now: this.#now().toISOString(),
        });
        record = currentMaterialization(
          this.#stateStore,
          session.id,
          materializationId,
        );
      }
      if (
        record.inputManifestDigest !== first.digest ||
        JSON.stringify(record.inputManifest) !== JSON.stringify(first.entries)
      ) {
        refuse("Workspace bytes no longer match the recorded input manifest");
      }
      const treeSha = await buildTree(
        this.#gitExecutable,
        lease.path,
        path.join(temporaryRoot, "index"),
        first.entries,
      );
      if (record.phase === "snapshot_recorded") {
        this.#stateStore.transitionMaterialization({
          sessionId: session.id,
          materializationId,
          controllerGeneration: authority.controllerGeneration,
          expectedPhases: ["snapshot_recorded"],
          phase: "tree_written",
          treeSha,
          now: this.#now().toISOString(),
        });
        record = currentMaterialization(
          this.#stateStore,
          session.id,
          materializationId,
        );
      }
      if (record.treeSha !== treeSha) {
        refuse("Rebuilt source tree does not match the durable tree identity");
      }
      const commitSha = await writeCommit(
        this.#gitExecutable,
        lease.path,
        record,
        treeSha,
      );
      if (record.phase === "tree_written") {
        this.#stateStore.transitionMaterialization({
          sessionId: session.id,
          materializationId,
          controllerGeneration: authority.controllerGeneration,
          expectedPhases: ["tree_written"],
          phase: "commit_written",
          commitSha,
          now: this.#now().toISOString(),
        });
        record = currentMaterialization(
          this.#stateStore,
          session.id,
          materializationId,
        );
      }
      if (record.commitSha !== commitSha) {
        refuse(
          "Rebuilt source commit does not match the durable commit identity",
        );
      }
      const second = await snapshotWorkspace(
        this.#gitExecutable,
        lease.path,
        parent,
      );
      if (
        second.digest !== first.digest ||
        JSON.stringify(second.entries) !== JSON.stringify(first.entries)
      ) {
        refuse("Workspace changed during source materialization");
      }
      const ref = `refs/heads/${lease.branch}`;
      const observedHead = text(
        await git(this.#gitExecutable, lease.path, [
          "rev-parse",
          `${ref}^{commit}`,
        ]),
      );
      if (observedHead === lease.baseSha) {
        await git(this.#gitExecutable, lease.path, [
          "update-ref",
          ref,
          commitSha,
          lease.baseSha,
        ]);
        branchMovedByThisInvocation = true;
      } else if (observedHead !== commitSha) {
        refuse(
          `Managed branch moved concurrently from ${lease.baseSha} to ${observedHead}`,
        );
      }
      const final = await snapshotWorkspace(
        this.#gitExecutable,
        lease.path,
        parent,
      );
      if (
        final.digest !== first.digest ||
        JSON.stringify(final.entries) !== JSON.stringify(first.entries)
      ) {
        await git(this.#gitExecutable, lease.path, [
          "update-ref",
          ref,
          lease.baseSha,
          commitSha,
        ]);
        branchMovedByThisInvocation = false;
        refuse("Workspace changed while the managed branch was advancing");
      }
      await git(this.#gitExecutable, lease.path, [
        "read-tree",
        "--reset",
        commitSha,
      ]);
      this.#stateStore.transitionMaterialization({
        sessionId: session.id,
        materializationId,
        controllerGeneration: authority.controllerGeneration,
        expectedPhases: ["commit_written"],
        phase: "branch_updated",
        now: this.#now().toISOString(),
      });
      return currentMaterialization(
        this.#stateStore,
        session.id,
        materializationId,
      );
    } catch (error) {
      const current = currentMaterialization(
        this.#stateStore,
        session.id,
        materializationId,
      );
      if (branchMovedByThisInvocation && current.commitSha !== null) {
        const ref = `refs/heads/${lease.branch}`;
        const observed = await gitResult(this.#gitExecutable, lease.path, [
          "rev-parse",
          `${ref}^{commit}`,
        ]);
        if (
          observed.exitCode === 0 &&
          text(observed.stdout) === current.commitSha
        ) {
          await gitResult(this.#gitExecutable, lease.path, [
            "update-ref",
            ref,
            lease.baseSha,
            current.commitSha,
          ]);
        }
      }
      if (current.phase !== "branch_updated" && current.phase !== "refused") {
        this.#stateStore.transitionMaterialization({
          sessionId: session.id,
          materializationId,
          controllerGeneration: authority.controllerGeneration,
          expectedPhases: [current.phase],
          phase: "refused",
          error: errorMessage(error),
          now: this.#now().toISOString(),
        });
      }
      throw error;
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
      await releaseFence();
    }
  }
}
