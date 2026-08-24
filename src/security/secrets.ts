export const GITHUB_TRACKER_SECRET_ENVIRONMENT_NAMES = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
] as const;

/** Redact configured secret values if a trusted parent-side tool echoes them. */
export function redactEnvironmentSecrets(
  text: string,
  environment: Readonly<Record<string, string | undefined>>,
  secretNames: readonly string[],
): string {
  const deniedNames = new Set(secretNames.map((name) => name.toUpperCase()));
  const values = [
    ...new Set(
      Object.entries(environment).flatMap(([name, value]) =>
        value !== undefined &&
        value !== "" &&
        deniedNames.has(name.toUpperCase())
          ? [value]
          : [],
      ),
    ),
  ].sort((left, right) => right.length - left.length);

  if (values.length === 0) return text;
  const alternatives = values.map((value) =>
    value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
  );
  return text.replace(new RegExp(alternatives.join("|"), "gu"), "[REDACTED]");
}
