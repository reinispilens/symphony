import { GITHUB_TRACKER_SECRET_ENVIRONMENT_NAMES } from "../security/secrets.js";

/**
 * Construct the coding-agent environment without tracker credentials.
 *
 * Names are compared case-insensitively so the same boundary holds on Windows,
 * whose environment-variable lookup is case-insensitive.
 */
export function childEnvironmentWithoutSecrets(
  source: Readonly<Record<string, string | undefined>>,
  adapterSecretNames: readonly string[] = [],
): Record<string, string> {
  const denied = new Set(
    [...GITHUB_TRACKER_SECRET_ENVIRONMENT_NAMES, ...adapterSecretNames].map(
      (name) => name.toUpperCase(),
    ),
  );

  return Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !denied.has(entry[0].toUpperCase()),
    ),
  );
}

export function universalTrackerSecretNames(): readonly string[] {
  return [...GITHUB_TRACKER_SECRET_ENVIRONMENT_NAMES];
}
