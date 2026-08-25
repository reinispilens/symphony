import { describe, expect, it } from "vitest";

import {
  trustedGitArguments,
  trustedGitEnvironment,
} from "../../src/repository/git-process.js";

describe("trusted Git process policy", () => {
  it("drops ambient Git authority and fixes hooks, fsmonitor, attributes, and submodules", () => {
    const environment = trustedGitEnvironment({
      GIT_DIR: "/hostile/git-dir",
      GIT_WORK_TREE: "/hostile/worktree",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/hostile/hooks",
      LANG: "en_US.UTF-8",
      PATH: "/hostile/bin",
    });

    expect(environment).not.toHaveProperty("GIT_DIR");
    expect(environment).not.toHaveProperty("GIT_WORK_TREE");
    expect(environment).not.toHaveProperty("GIT_CONFIG_COUNT");
    expect(environment).not.toHaveProperty("PATH");
    expect(environment).toMatchObject({
      GIT_ATTR_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    });
    expect(trustedGitArguments("/source", ["status"])).toEqual([
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
      "/source",
      "status",
    ]);
  });
});
