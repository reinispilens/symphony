import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import { parseDocument } from "yaml";

import { SymphonyError } from "../errors.js";
import { isRecord } from "../shared/json.js";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_LOCKFILE_BYTES = 16 * 1024 * 1024;
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_IMPORTERS = 500;
const utf8 = new TextDecoder("utf-8", { fatal: true });

interface InputFile {
  readonly bytes: Buffer;
  readonly path: string;
}

export interface PnpmInputInspection {
  readonly inputDigest: string;
  readonly lockfileDigest: string;
  readonly manifestDigest: string;
}

function refuse(message: string, cause?: unknown): never {
  throw new SymphonyError("preparation_refused", message, {
    ...(cause === undefined ? {} : { cause }),
  });
}

function digest(bytes: string | Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function strictChild(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function record(value: unknown, location: string): Record<string, unknown> {
  if (!isRecord(value)) refuse(`${location} must be an object`);
  return value;
}

function strictKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  location: string,
): void {
  const unknown = Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .sort();
  if (unknown.length !== 0) {
    refuse(`${location} contains unsupported key '${unknown[0]}'`);
  }
}

function decode(bytes: Buffer, location: string): string {
  try {
    return utf8.decode(bytes);
  } catch (error) {
    refuse(`${location} must be valid UTF-8`, error);
  }
}

function parseJson(bytes: Buffer, location: string): Record<string, unknown> {
  try {
    return record(JSON.parse(decode(bytes, location)) as unknown, location);
  } catch (error) {
    if (error instanceof SymphonyError) throw error;
    refuse(`${location} must be valid JSON`, error);
  }
}

function parseYaml(bytes: Buffer, location: string): Record<string, unknown> {
  const document = parseDocument(decode(bytes, location), {
    uniqueKeys: true,
  });
  if (document.errors.length !== 0) {
    refuse(`${location} must be valid YAML without aliases or duplicate keys`);
  }
  try {
    return record(document.toJS({ maxAliasCount: 0 }), location);
  } catch (error) {
    refuse(`${location} must be bounded YAML without aliases`, error);
  }
}

function repositoryPath(value: string, location: string): string {
  if (
    value.includes("\\") ||
    /[\0\r\n]/u.test(value) ||
    value === "" ||
    value === "." ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value.startsWith("../")
  ) {
    refuse(`${location} must be a normalized repository-relative path`);
  }
  return value;
}

async function readInputFile(
  workspaceRoot: string,
  repositoryRelativePath: string,
  maximumBytes: number,
  required: boolean,
): Promise<InputFile | null> {
  const absolutePath = path.join(workspaceRoot, repositoryRelativePath);
  let handle;
  try {
    handle = await open(
      absolutePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      refuse(`${repositoryRelativePath} must not be a symbolic link`, error);
    }
    refuse(
      `Could not read required preparation input ${repositoryRelativePath}`,
      error,
    );
  }
  try {
    const entry = await handle.stat();
    if (!entry.isFile()) {
      refuse(`${repositoryRelativePath} must be a regular file`);
    }
    if (entry.size > maximumBytes) {
      refuse(`${repositoryRelativePath} must not exceed ${maximumBytes} bytes`);
    }
    const [realWorkspace, realFile] = await Promise.all([
      realpath(workspaceRoot),
      realpath(absolutePath),
    ]);
    if (
      !strictChild(realWorkspace, realFile) ||
      realFile !== path.resolve(absolutePath)
    ) {
      refuse(
        `${repositoryRelativePath} must have no symbolic-link path components and remain inside the managed workspace`,
      );
    }
    return { bytes: await handle.readFile(), path: repositoryRelativePath };
  } finally {
    await handle.close();
  }
}

async function refusePnpmHooks(
  workspaceRoot: string,
  directory = "",
): Promise<void> {
  for (const filename of [".pnpmfile.cjs", ".pnpmfile.js"]) {
    const repositoryRelativePath = path.posix.join(directory, filename);
    try {
      await lstat(path.join(workspaceRoot, repositoryRelativePath));
      refuse(
        `${repositoryRelativePath} is unsupported because preparation never executes product-owned pnpm hooks`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function dependencySpec(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    refuse(`${location} must be a non-empty dependency specifier`);
  }
  const specifier = value.trim();
  if (
    specifier !== value ||
    /[\0\r\n]/u.test(specifier) ||
    /^(?:https?|git(?:\+[^:]*)?|ssh|file|link|portal|patch|workspace|catalog|jsr|github|gitlab|bitbucket|ftp):/iu.test(
      specifier,
    ) ||
    specifier.includes("://") ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    path.win32.isAbsolute(specifier) ||
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#.*)?$/u.test(specifier)
  ) {
    refuse(
      `${location} must resolve through the admitted registry, not a URL, Git repository, or local path`,
    );
  }
  return specifier;
}

function validateManifest(
  manifest: Record<string, unknown>,
  location: string,
  expectedPnpmVersion: string,
  root: boolean,
): void {
  if (root) {
    const expected = `pnpm@${expectedPnpmVersion}`;
    if (manifest["packageManager"] !== expected) {
      refuse(`${location}.packageManager must equal '${expected}'`);
    }
  }
  const devEngines = manifest["devEngines"];
  if (isRecord(devEngines) && devEngines["runtime"] !== undefined) {
    refuse(
      `${location}.devEngines.runtime is unsupported by the offline preparation class`,
    );
  }
  const pnpm = manifest["pnpm"];
  if (pnpm !== undefined) {
    refuse(
      `${location}.pnpm configuration is unsupported by the first offline preparation class`,
    );
  }
  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const value = manifest[section];
    if (value === undefined) continue;
    const dependencies = record(value, `${location}.${section}`);
    for (const [name, specifier] of Object.entries(dependencies)) {
      dependencySpec(specifier, `${location}.${section}.${name}`);
    }
  }
}

function rejectExternalReference(value: unknown, location: string): void {
  if (typeof value === "string") {
    if (
      /^(?:https?|git(?:\+[^:]*)?|ssh|file|link|portal|patch|workspace|catalog|jsr|github|gitlab|bitbucket|ftp):/iu.test(
        value,
      ) ||
      value.includes("://")
    ) {
      refuse(`${location} contains a non-registry package source`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      rejectExternalReference(entry, `${location}[${index}]`),
    );
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      rejectExternalReference(entry, `${location}.${key}`);
    }
  }
}

function validateLockfile(
  lockfile: Record<string, unknown>,
): readonly string[] {
  strictKeys(
    lockfile,
    ["lockfileVersion", "settings", "importers", "packages", "snapshots"],
    "pnpm-lock.yaml",
  );
  if (lockfile["lockfileVersion"] !== "9.0") {
    refuse("pnpm-lock.yaml.lockfileVersion must equal '9.0'");
  }
  const settings = record(lockfile["settings"], "pnpm-lock.yaml.settings");
  strictKeys(
    settings,
    ["autoInstallPeers", "excludeLinksFromLockfile"],
    "pnpm-lock.yaml.settings",
  );
  for (const key of ["autoInstallPeers", "excludeLinksFromLockfile"]) {
    if (settings[key] !== true && settings[key] !== false) {
      refuse(`pnpm-lock.yaml.settings.${key} must be a boolean`);
    }
  }

  const importers = record(lockfile["importers"], "pnpm-lock.yaml.importers");
  const importerPaths = Object.keys(importers).sort();
  if (importerPaths.length === 0 || importerPaths.length > MAX_IMPORTERS) {
    refuse(
      `pnpm-lock.yaml.importers must contain between 1 and ${MAX_IMPORTERS} entries`,
    );
  }
  for (const importerPath of importerPaths) {
    if (importerPath !== ".") {
      repositoryPath(importerPath, `pnpm-lock.yaml.importers.${importerPath}`);
    }
    const importer = record(
      importers[importerPath],
      `pnpm-lock.yaml.importers.${importerPath}`,
    );
    for (const section of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      const value = importer[section];
      if (value === undefined) continue;
      const dependencies = record(
        value,
        `pnpm-lock.yaml.importers.${importerPath}.${section}`,
      );
      for (const [name, dependencyValue] of Object.entries(dependencies)) {
        const dependency = record(
          dependencyValue,
          `pnpm-lock.yaml.importers.${importerPath}.${section}.${name}`,
        );
        dependencySpec(
          dependency["specifier"],
          `pnpm-lock.yaml.importers.${importerPath}.${section}.${name}.specifier`,
        );
        dependencySpec(
          dependency["version"],
          `pnpm-lock.yaml.importers.${importerPath}.${section}.${name}.version`,
        );
      }
    }
  }

  const packages =
    lockfile["packages"] === undefined
      ? {}
      : record(lockfile["packages"], "pnpm-lock.yaml.packages");
  const snapshots =
    lockfile["snapshots"] === undefined
      ? {}
      : record(lockfile["snapshots"], "pnpm-lock.yaml.snapshots");
  const packageKeys = Object.keys(packages).sort();
  const snapshotKeys = Object.keys(snapshots).sort();
  const snapshotBaseKeys = new Set(
    snapshotKeys.map((key) => {
      const peerSuffix = key.indexOf("(");
      return peerSuffix === -1 ? key : key.slice(0, peerSuffix);
    }),
  );
  if (
    packageKeys.some((key) => !snapshotBaseKeys.has(key)) ||
    snapshotKeys.some((key) => {
      const peerSuffix = key.indexOf("(");
      const base = peerSuffix === -1 ? key : key.slice(0, peerSuffix);
      return packages[base] === undefined;
    })
  ) {
    refuse(
      "pnpm-lock.yaml snapshots must correspond to integrity-pinned packages",
    );
  }
  for (const packageKey of packageKeys) {
    rejectExternalReference(
      packageKey,
      `pnpm-lock.yaml.packages.${packageKey}`,
    );
    const packageValue = record(
      packages[packageKey],
      `pnpm-lock.yaml.packages.${packageKey}`,
    );
    const resolution = record(
      packageValue["resolution"],
      `pnpm-lock.yaml.packages.${packageKey}.resolution`,
    );
    strictKeys(
      resolution,
      ["integrity"],
      `pnpm-lock.yaml.packages.${packageKey}.resolution`,
    );
    const integrity = resolution["integrity"];
    if (
      typeof integrity !== "string" ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(integrity)
    ) {
      refuse(
        `pnpm-lock.yaml.packages.${packageKey}.resolution.integrity must be SHA-512`,
      );
    }
    rejectExternalReference(
      packageValue,
      `pnpm-lock.yaml.packages.${packageKey}`,
    );
  }
  for (const snapshotKey of snapshotKeys) {
    rejectExternalReference(
      snapshots[snapshotKey],
      `pnpm-lock.yaml.snapshots.${snapshotKey}`,
    );
  }
  return importerPaths;
}

function validateNpmrc(bytes: Buffer): void {
  const allowed = new Map([
    ["save-exact", "true"],
    ["engine-strict", "true"],
    ["shared-workspace-lockfile", "true"],
  ]);
  const observed = new Set<string>();
  for (const [index, rawLine] of decode(bytes, ".npmrc")
    .split(/\r?\n/u)
    .entries()) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) refuse(`.npmrc line ${index + 1} must be key=value`);
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line
      .slice(separator + 1)
      .trim()
      .toLowerCase();
    if (allowed.get(key) !== value) {
      refuse(`.npmrc key '${key}' is outside the offline preparation profile`);
    }
    if (observed.has(key)) refuse(`.npmrc repeats key '${key}'`);
    observed.add(key);
  }
}

function validateWorkspaceManifest(bytes: Buffer): void {
  const workspace = parseYaml(bytes, "pnpm-workspace.yaml");
  strictKeys(workspace, ["packages", "allowBuilds"], "pnpm-workspace.yaml");
  const packages = workspace["packages"];
  if (packages !== undefined) {
    if (!Array.isArray(packages)) {
      refuse("pnpm-workspace.yaml.packages must be an array");
    }
    for (const [index, pattern] of packages.entries()) {
      if (
        typeof pattern !== "string" ||
        pattern === "" ||
        pattern.includes("\\") ||
        pattern.includes("..") ||
        pattern.startsWith("/") ||
        pattern.startsWith("!") ||
        !/^[A-Za-z0-9_@./*{}?,-]+$/u.test(pattern)
      ) {
        refuse(
          `pnpm-workspace.yaml.packages[${index}] must be a bounded in-repository glob`,
        );
      }
    }
  }
  const allowBuilds = workspace["allowBuilds"];
  if (allowBuilds !== undefined) {
    const entries = record(allowBuilds, "pnpm-workspace.yaml.allowBuilds");
    for (const [name, allowed] of Object.entries(entries)) {
      if (allowed !== true && allowed !== false) {
        refuse(`pnpm-workspace.yaml.allowBuilds.${name} must be a boolean`);
      }
    }
  }
}

/**
 * Admits every product-controlled input pnpm will use in the first managed
 * preparation class and returns one stable digest for the complete set.
 */
export async function inspectPnpmInputs(
  workspaceRoot: string,
  expectedPnpmVersion: string,
): Promise<PnpmInputInspection> {
  const workspaceEntry = await lstat(workspaceRoot);
  if (!workspaceEntry.isDirectory() || workspaceEntry.isSymbolicLink()) {
    refuse("Managed preparation workspace must be a real directory");
  }
  const manifestFile = await readInputFile(
    workspaceRoot,
    "package.json",
    MAX_MANIFEST_BYTES,
    true,
  );
  const lockfileFile = await readInputFile(
    workspaceRoot,
    "pnpm-lock.yaml",
    MAX_LOCKFILE_BYTES,
    true,
  );
  if (manifestFile === null || lockfileFile === null) {
    refuse("package.json and pnpm-lock.yaml are required");
  }
  const manifest = parseJson(manifestFile.bytes, "package.json");
  validateManifest(manifest, "package.json", expectedPnpmVersion, true);
  const lockfile = parseYaml(lockfileFile.bytes, "pnpm-lock.yaml");
  const importerPaths = validateLockfile(lockfile);

  const files: InputFile[] = [manifestFile, lockfileFile];
  const workspaceManifest = await readInputFile(
    workspaceRoot,
    "pnpm-workspace.yaml",
    MAX_MANIFEST_BYTES,
    false,
  );
  if (workspaceManifest !== null) {
    validateWorkspaceManifest(workspaceManifest.bytes);
    files.push(workspaceManifest);
  } else if (importerPaths.some((entry) => entry !== ".")) {
    refuse(
      "pnpm-workspace.yaml is required when the lockfile has workspace importers",
    );
  }
  const npmrc = await readInputFile(
    workspaceRoot,
    ".npmrc",
    MAX_MANIFEST_BYTES,
    false,
  );
  if (npmrc !== null) {
    validateNpmrc(npmrc.bytes);
    files.push(npmrc);
  }

  await refusePnpmHooks(workspaceRoot);
  for (const importerPath of importerPaths) {
    if (importerPath === ".") continue;
    await refusePnpmHooks(workspaceRoot, importerPath);
    const packagePath = path.posix.join(importerPath, "package.json");
    const importerManifest = await readInputFile(
      workspaceRoot,
      packagePath,
      MAX_MANIFEST_BYTES,
      true,
    );
    if (importerManifest === null) {
      refuse(`${packagePath} is required by the admitted lockfile`);
    }
    validateManifest(
      parseJson(importerManifest.bytes, packagePath),
      packagePath,
      expectedPnpmVersion,
      false,
    );
    files.push(importerManifest);
  }

  const totalBytes = files.reduce(
    (total, file) => total + file.bytes.length,
    0,
  );
  if (totalBytes > MAX_INPUT_BYTES) {
    refuse(`Complete pnpm input set must not exceed ${MAX_INPUT_BYTES} bytes`);
  }
  const entries = files
    .map((file) => ({ path: file.path, digest: digest(file.bytes) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    manifestDigest: digest(manifestFile.bytes),
    lockfileDigest: digest(lockfileFile.bytes),
    inputDigest: digest(
      JSON.stringify({ schemaVersion: 1, expectedPnpmVersion, entries }),
    ),
  };
}
