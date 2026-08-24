import readline from "node:readline";

const scenario = process.env.FAKE_CODEX_SCENARIO ?? "normal";
const expectedTool = "fake_tracker_update";
const threadId = "thread-fake-1";
let turnNumber = 0;
let experimentalApi = false;
let advertisedTools = [];
const serverRequests = new Map();

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function completedTurn(turnId, status = "completed", error = null) {
  send({
    method: "turn/completed",
    params: {
      threadId,
      turn: {
        id: turnId,
        items: [],
        itemsView: "full",
        status,
        error,
        startedAt: 1,
        completedAt: 2,
        durationMs: 1000,
      },
    },
  });
}

function failRequest(id, message) {
  send({ id, error: { code: -32602, message } });
}

function serverRequest(method, params, check) {
  const id = `server-${serverRequests.size + 1}`;
  serverRequests.set(id, check);
  send({ id, method, params });
}

function turn(id, status = "inProgress", error = null) {
  return {
    id,
    items: [],
    itemsView: "full",
    status,
    error,
    startedAt: 1,
    completedAt: status === "inProgress" ? null : 2,
    durationMs: status === "inProgress" ? null : 1000,
  };
}

function startTurn(message) {
  turnNumber += 1;
  const turnId = `turn-fake-${turnNumber}`;
  if (message.params?.threadId !== threadId) {
    failRequest(message.id, "wrong thread id");
    return;
  }
  if (message.params?.cwd !== process.cwd()) {
    failRequest(message.id, "turn cwd did not match process cwd");
    return;
  }
  send({ id: message.id, result: { turn: turn(turnId) } });
  send({ method: "turn/started", params: { threadId, turn: turn(turnId) } });
  process.stderr.write("fake diagnostic; this is not protocol JSON\n");

  if (scenario === "stall") return;
  if (scenario === "exit") {
    process.exit(7);
  }
  if (scenario === "malformed") {
    process.stdout.write("this is not json\n");
    return;
  }
  if (scenario === "large-line") {
    process.stdout.write(`${"x".repeat(4096)}\n`);
    return;
  }
  if (scenario === "failed") {
    completedTurn(turnId, "failed", {
      message: "fake turn failure",
      codexErrorInfo: { type: "Other" },
      additionalDetails: null,
    });
    return;
  }
  if (scenario === "interrupted") {
    completedTurn(turnId, "interrupted");
    return;
  }
  if (scenario === "approval" || scenario === "file-approval") {
    serverRequest(
      scenario === "approval"
        ? "item/commandExecution/requestApproval"
        : "item/fileChange/requestApproval",
      { threadId, turnId, itemId: "command-1" },
      (response) => {
        if (response.result?.decision !== "acceptForSession") {
          completedTurn(turnId, "failed", {
            message: "approval was not accepted for the session",
            codexErrorInfo: null,
            additionalDetails: null,
          });
          return;
        }
        completedTurn(turnId);
      },
    );
    return;
  }
  if (scenario === "permission-approval") {
    serverRequest(
      "item/permissions/requestApproval",
      {
        permissions: {
          fileSystem: { read: ["/outside-workspace"], write: [] },
          network: { enabled: true },
        },
        threadId,
        turnId,
      },
      (response) => {
        if (
          response.result?.scope !== "turn" ||
          Object.keys(response.result?.permissions ?? {}).length !== 0
        ) {
          completedTurn(turnId, "failed", {
            message: "additional permissions were not declined",
            codexErrorInfo: null,
            additionalDetails: null,
          });
          return;
        }
        completedTurn(turnId);
      },
    );
    return;
  }
  if (scenario === "mcp-elicitation") {
    serverRequest(
      "mcpServer/elicitation/request",
      {
        message: "provide a secret",
        requestedSchema: { type: "object" },
        serverName: "fake",
      },
      (response) => {
        if (
          response.result?.action !== "decline" ||
          response.result?.content !== null
        ) {
          completedTurn(turnId, "failed", {
            message: "elicitation was not declined",
            codexErrorInfo: null,
            additionalDetails: null,
          });
          return;
        }
        completedTurn(turnId);
      },
    );
    return;
  }
  if (scenario === "unknown-request") {
    serverRequest("future/serverRequest", { threadId, turnId }, (response) => {
      if (response.error?.code !== -32601) {
        completedTurn(turnId, "failed", {
          message: "unknown request did not receive method-not-found",
          codexErrorInfo: null,
          additionalDetails: null,
        });
        return;
      }
      completedTurn(turnId);
    });
    return;
  }
  if (scenario === "tool" || scenario === "unsupported-tool") {
    const tool = scenario === "tool" ? expectedTool : "not_advertised";
    serverRequest(
      "item/tool/call",
      {
        threadId,
        turnId,
        callId: "tool-call-1",
        namespace: null,
        tool,
        arguments: { status: "Human Review" },
      },
      (response) => {
        const expectedSuccess = scenario === "tool";
        const content = response.result?.contentItems?.[0];
        if (
          response.result?.success !== expectedSuccess ||
          content?.type !== "inputText"
        ) {
          completedTurn(turnId, "failed", {
            message: "invalid dynamic-tool response",
            codexErrorInfo: null,
            additionalDetails: null,
          });
          return;
        }
        completedTurn(turnId);
      },
    );
    return;
  }
  if (scenario === "user-input") {
    serverRequest(
      "item/tool/requestUserInput",
      {
        threadId,
        turnId,
        itemId: "input-1",
        questions: [],
        isBlocking: true,
        autoResolutionMs: null,
      },
      () => undefined,
    );
    return;
  }
  if (scenario === "heartbeat") {
    let count = 0;
    const timer = setInterval(() => {
      count += 1;
      send({
        method: "warning",
        params: { threadId, message: `beat-${count}` },
      });
      if (count === 4) {
        clearInterval(timer);
        completedTurn(turnId);
      }
    }, 15);
    return;
  }

  send({
    method: "thread/tokenUsage/updated",
    params: {
      threadId,
      turnId,
      tokenUsage: {
        total: {
          totalTokens: 21,
          inputTokens: 12,
          cachedInputTokens: 2,
          cacheWriteInputTokens: 0,
          outputTokens: 9,
          reasoningOutputTokens: 3,
        },
        last: {
          totalTokens: 21,
          inputTokens: 12,
          cachedInputTokens: 2,
          cacheWriteInputTokens: 0,
          outputTokens: 9,
          reasoningOutputTokens: 3,
        },
        modelContextWindow: 200000,
      },
    },
  });
  send({
    method: "account/rateLimits/updated",
    params: {
      rateLimits: {
        limitId: "codex",
        limitName: "Codex",
        primary: null,
        secondary: null,
        credits: null,
        individualLimit: null,
        spendControlReached: false,
        planType: null,
        rateLimitReachedType: null,
      },
    },
  });
  completedTurn(turnId);
}

function handle(message) {
  if (message.method === undefined && message.id !== undefined) {
    const check = serverRequests.get(message.id);
    if (check !== undefined) {
      serverRequests.delete(message.id);
      check(message);
    }
    return;
  }

  switch (message.method) {
    case "initialize": {
      if (scenario === "read-timeout") return;
      experimentalApi = message.params?.capabilities?.experimentalApi === true;
      if (message.params?.clientInfo?.name !== "symphony") {
        failRequest(message.id, "invalid client identity");
        return;
      }
      send({
        id: message.id,
        result: {
          userAgent: "fake-codex",
          platformFamily: "unix",
          platformOs: "linux",
        },
      });
      return;
    }
    case "initialized":
      return;
    case "thread/start": {
      const forbidden = [
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "GH_ENTERPRISE_TOKEN",
        "GITHUB_ENTERPRISE_TOKEN",
        "CUSTOM_TRACKER_SECRET",
      ].filter((name) => process.env[name] !== undefined);
      if (forbidden.length > 0) {
        failRequest(
          message.id,
          `secret environment leaked: ${forbidden.join(",")}`,
        );
        return;
      }
      if (message.params?.cwd !== process.cwd()) {
        failRequest(message.id, "thread cwd did not match process cwd");
        return;
      }
      if (
        message.params?.approvalPolicy !== "never" ||
        message.params?.sandbox !== "workspace-write"
      ) {
        failRequest(message.id, "unexpected default policy");
        return;
      }
      advertisedTools = message.params?.dynamicTools ?? [];
      if (
        scenario === "tool" &&
        (!experimentalApi ||
          !advertisedTools.some((tool) => tool.name === expectedTool))
      ) {
        failRequest(
          message.id,
          "dynamic tool was not advertised experimentally",
        );
        return;
      }
      send({ id: message.id, result: { thread: { id: threadId } } });
      send({ method: "thread/started", params: { thread: { id: threadId } } });
      return;
    }
    case "thread/name/set": {
      const titlePrefix = process.env.FAKE_CODEX_TITLE_PREFIX ?? "SYM-123";
      if (!message.params?.name?.startsWith(`${titlePrefix}:`)) {
        failRequest(message.id, "missing issue-identifying thread title");
        return;
      }
      send({ id: message.id, result: {} });
      return;
    }
    case "turn/start": {
      startTurn(message);
      return;
    }
    case "turn/interrupt": {
      send({ id: message.id, result: {} });
      completedTurn(message.params.turnId, "interrupted");
      return;
    }
    default:
      failRequest(
        message.id,
        `unsupported fake-client method ${message.method}`,
      );
  }
}

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  try {
    handle(JSON.parse(line));
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 70;
    lines.close();
  }
});
