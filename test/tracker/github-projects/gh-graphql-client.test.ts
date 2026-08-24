import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { GhGraphqlClient } from "../../../src/tracker/github-projects/gh-graphql-client.js";
import { withTempDirectory } from "../../support/factories.js";

const FAKE_GH = `#!/usr/bin/env node
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const mode = process.env.FAKE_GH_MODE;
  if (mode === "auth") {
    console.error("HTTP 401: Bad credentials");
    process.exit(1);
  }
  if (mode === "status") {
    console.error("HTTP 503: Service unavailable");
    process.exit(1);
  }
  if (mode === "secret") {
    console.error(\`request failed with token=\${process.env.GH_TOKEN}\`);
    process.exit(1);
  }
  if (mode === "graphql") {
    console.log(JSON.stringify({ errors: [{ message: "Selection was rejected" }] }));
    return;
  }
  if (mode === "graphql-rate") {
    console.log(JSON.stringify({ errors: [{ message: "API rate limit exceeded", extensions: { type: "RATE_LIMITED" } }] }));
    return;
  }
  if (mode === "invalid-json") {
    console.log("not json");
    return;
  }
  if (mode === "timeout") {
    setTimeout(() => console.log(JSON.stringify({ data: {} })), 1000);
    return;
  }
  console.log(JSON.stringify({ data: { payload: JSON.parse(input), args: process.argv.slice(2) } }));
});
`;

async function fakeCommand(directory: string): Promise<string> {
  const command = path.join(directory, "fake-gh");
  await writeFile(command, FAKE_GH, "utf8");
  await chmod(command, 0o755);
  return command;
}

function environment(mode?: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"],
    ...(mode === undefined ? {} : { FAKE_GH_MODE: mode }),
  };
}

describe("GhGraphqlClient", () => {
  it("passes a JSON request on stdin, selects the configured hostname, and returns data", async () => {
    await withTempDirectory(async (directory) => {
      const command = await fakeCommand(directory);
      const client = new GhGraphqlClient({
        command,
        environment: environment(),
        hostname: "github.enterprise.test",
      });

      const data = await client.request(
        "query Example($id: ID!) { node(id: $id) { id } }",
        { id: "NODE_1" },
      );
      expect(data).toEqual({
        payload: {
          query: "query Example($id: ID!) { node(id: $id) { id } }",
          variables: { id: "NODE_1" },
        },
        args: [
          "api",
          "graphql",
          "--input",
          "-",
          "--hostname",
          "github.enterprise.test",
        ],
      });
    });
  });

  it("maps authentication, GraphQL rate-limit, and malformed-JSON failures", async () => {
    await withTempDirectory(async (directory) => {
      const command = await fakeCommand(directory);

      await expect(
        new GhGraphqlClient({
          command,
          environment: environment("auth"),
        }).request("query { viewer { id } }", {}),
      ).rejects.toMatchObject({ category: "missing_tracker_secret" });

      await expect(
        new GhGraphqlClient({
          command,
          environment: environment("status"),
        }).request("query { viewer { id } }", {}),
      ).rejects.toMatchObject({ category: "tracker_status" });

      await expect(
        new GhGraphqlClient({
          command,
          environment: environment("graphql"),
        }).request("query { viewer { id } }", {}),
      ).rejects.toMatchObject({ category: "tracker_response" });

      await expect(
        new GhGraphqlClient({
          command,
          environment: environment("graphql-rate"),
        }).request("query { viewer { id } }", {}),
      ).rejects.toMatchObject({
        category: "tracker_rate_limited",
        retryable: true,
      });

      await expect(
        new GhGraphqlClient({
          command,
          environment: environment("invalid-json"),
        }).request("query { viewer { id } }", {}),
      ).rejects.toMatchObject({ category: "tracker_response" });
    });
  });

  it("terminates and categorizes a timed-out CLI request", async () => {
    await withTempDirectory(async (directory) => {
      const command = await fakeCommand(directory);
      const client = new GhGraphqlClient({
        command,
        environment: environment("timeout"),
        timeoutMs: 20,
      });
      await expect(
        client.request("query { viewer { id } }", {}),
      ).rejects.toMatchObject({
        category: "tracker_request",
        retryable: true,
      });
    });
  });

  it("redacts tracker secret values echoed by the CLI", async () => {
    await withTempDirectory(async (directory) => {
      const command = await fakeCommand(directory);
      const request = new GhGraphqlClient({
        command,
        environment: {
          ...environment("secret"),
          GH_TOKEN: "must-not-be-logged",
        },
      }).request("query { viewer { id } }", {});

      await expect(request).rejects.toMatchObject({
        message: expect.stringContaining("token=[REDACTED]"),
      });
      await expect(request).rejects.not.toMatchObject({
        message: expect.stringContaining("must-not-be-logged"),
      });
    });
  });

  it("categorizes a missing gh executable as a retryable request failure", async () => {
    const client = new GhGraphqlClient({
      command: "/definitely/missing/gh",
      environment: environment(),
    });
    await expect(
      client.request("query { viewer { id } }", {}),
    ).rejects.toMatchObject({
      category: "tracker_request",
      retryable: true,
    });
  });
});
