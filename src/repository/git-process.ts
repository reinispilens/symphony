const inheritedEnvironmentNames = [
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TEMP",
  "TMP",
] as const;

/**
 * Git remains repository-aware, but ambient process configuration must not
 * redirect its object database, worktree, config, hooks, prompts, or helpers.
 */
export function trustedGitEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    PAGER: "cat",
    TERM: "dumb",
  };
  for (const name of inheritedEnvironmentNames) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

/** Fixed policy prefix for every trusted repository-lifecycle Git command. */
export function trustedGitArguments(
  sourceRoot: string,
  args: readonly string[],
): readonly string[] {
  return [
    "--no-pager",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.attributesFile=/dev/null",
    "-c",
    "submodule.recurse=false",
    "-C",
    sourceRoot,
    ...args,
  ];
}
