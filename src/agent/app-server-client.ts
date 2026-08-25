import { errorMessage } from "../errors.js";
import { nullLogger, type Logger } from "../observability/logger.js";
import {
  isRecord,
  toJsonObject,
  toJsonValue,
  type JsonObject,
  type JsonValue,
} from "../shared/json.js";
import { childEnvironmentWithoutSecrets } from "./environment.js";
import { AgentError } from "./errors.js";
import type {
  AgentEvent,
  AgentEventHandler,
  AgentEventName,
} from "./events.js";
import {
  AppServerProcessTransport,
  type AppServerCommand,
  type AppServerTransportHandler,
  type ServerNotificationMessage,
  type ServerRequestMessage,
} from "./process-transport.js";
import type { AgentToolResult, AgentToolRuntime } from "./tools.js";

const CLIENT_VERSION = "0.1.0";
const DEFAULT_APPROVAL_POLICY = "never";
const DEFAULT_THREAD_SANDBOX = "workspace-write";

export interface CodexAppServerSessionOptions {
  readonly command: AppServerCommand;
  readonly cwd: string;
  readonly readTimeoutMs: number;
  readonly turnTimeoutMs: number;
  readonly adapterSecretEnvironmentNames?: readonly string[];
  readonly approvalPolicy?: JsonValue | null;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly logger?: Logger;
  readonly maxLineBytes?: number;
  readonly onEvent?: AgentEventHandler;
  readonly threadSandbox?: JsonValue | null;
  readonly title?: string | null;
  readonly toolRuntime?: AgentToolRuntime | null;
  readonly turnSandboxPolicy?: JsonValue | null;
}

export interface CodexTurnResult {
  readonly rateLimits: JsonObject | null;
  readonly sessionId: string;
  readonly status: "completed";
  readonly threadId: string;
  readonly turnId: string;
  readonly usage: JsonObject | null;
}

interface ActiveTurn {
  readonly completion: Promise<CodexTurnResult>;
  readonly number: number;
  readonly reject: (error: AgentError) => void;
  readonly resolve: (result: CodexTurnResult) => void;
  settled: boolean;
  timeout: NodeJS.Timeout | null;
  turnId: string | null;
  usage: JsonObject | null;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new AgentError(
      "response_error",
      `Codex app-server ${label} must be an object`,
    );
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AgentError(
      "response_error",
      `Codex app-server ${label} must be a non-empty string`,
    );
  }
  return value;
}

function jsonObjectOrNull(value: JsonValue): JsonObject | null {
  return isRecord(value) ? toJsonObject(value) : null;
}

function asAgentError(error: unknown): AgentError {
  return error instanceof AgentError
    ? error
    : new AgentError("turn_failed", errorMessage(error), { cause: error });
}

function toolFailure(code: string, message: string): AgentToolResult {
  return { success: false, error: { code, message } };
}

function toolResponse(result: AgentToolResult): JsonObject {
  const envelope: JsonObject = result.success
    ? { ok: true, result: result.output }
    : { ok: false, error: result.error };
  return {
    contentItems: [{ type: "inputText", text: JSON.stringify(envelope) }],
    success: result.success,
  };
}

function validateTools(runtime: AgentToolRuntime | null): void {
  if (runtime === null) return;
  const names = new Set<string>();
  for (const spec of runtime.specs) {
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(spec.name)) {
      throw new TypeError(
        `Agent tool name '${spec.name}' does not satisfy the Codex naming contract`,
      );
    }
    if (names.has(spec.name)) {
      throw new TypeError(`Duplicate agent tool name '${spec.name}'`);
    }
    names.add(spec.name);
  }
}

/** A single live Codex process and thread, reusable for continuation turns. */
export class CodexAppServerSession {
  readonly #approvalPolicy: JsonValue;
  readonly #cwd: string;
  readonly #logger: Logger;
  readonly #onEvent: AgentEventHandler;
  readonly #readTimeoutMs: number;
  readonly #threadSandbox: JsonValue;
  readonly #toolRuntime: AgentToolRuntime | null;
  readonly #transport: AppServerProcessTransport;
  readonly #turnSandboxPolicy: JsonValue | null;
  readonly #turnTimeoutMs: number;
  #active: ActiveTurn | null = null;
  #closed = false;
  #closePromise: Promise<void> | null = null;
  #fatalError: AgentError | null = null;
  #latestRateLimits: JsonObject | null = null;
  #threadId: string | null = null;
  #turnCount = 0;

  private constructor(
    options: CodexAppServerSessionOptions,
    transport: AppServerProcessTransport,
  ) {
    this.#approvalPolicy = options.approvalPolicy ?? DEFAULT_APPROVAL_POLICY;
    this.#cwd = options.cwd;
    this.#logger = options.logger ?? nullLogger;
    this.#onEvent = options.onEvent ?? (() => undefined);
    this.#readTimeoutMs = options.readTimeoutMs;
    this.#threadSandbox = options.threadSandbox ?? DEFAULT_THREAD_SANDBOX;
    this.#toolRuntime = options.toolRuntime ?? null;
    this.#transport = transport;
    this.#turnSandboxPolicy = options.turnSandboxPolicy ?? null;
    this.#turnTimeoutMs = options.turnTimeoutMs;
  }

  static async start(
    options: CodexAppServerSessionOptions,
  ): Promise<CodexAppServerSession> {
    validateTools(options.toolRuntime ?? null);
    const environment = childEnvironmentWithoutSecrets(
      options.environment ?? process.env,
      options.adapterSecretEnvironmentNames ?? [],
    );

    let transport: AppServerProcessTransport | null = null;
    let session: CodexAppServerSession | null = null;
    try {
      transport = await AppServerProcessTransport.launch({
        command: options.command,
        cwd: options.cwd,
        environment,
        ...(options.maxLineBytes === undefined
          ? {}
          : { maxLineBytes: options.maxLineBytes }),
      });
      session = new CodexAppServerSession(options, transport);
      transport.setHandler(session.#transportHandler());
      await session.#initialize(options.title ?? null);
      return session;
    } catch (error) {
      const agentError = asAgentError(error);
      if (session !== null) {
        session.#emit("startup_failed", {
          error_code: agentError.code,
          error: agentError.message,
        });
      } else {
        const event: AgentEvent = {
          event: "startup_failed",
          timestamp: new Date().toISOString(),
          error_code: agentError.code,
          error: agentError.message,
        };
        void Promise.resolve(options.onEvent?.(event)).catch(() => undefined);
      }
      if (transport !== null) await transport.close();
      throw agentError;
    }
  }

  get threadId(): string {
    if (this.#threadId === null) {
      throw new Error("Codex session has not initialized a thread");
    }
    return this.#threadId;
  }

  get pid(): number | undefined {
    return this.#transport.pid;
  }

  async runTurn(input: string): Promise<CodexTurnResult> {
    if (this.#closed) {
      throw new AgentError("port_exit", "Codex session is closed");
    }
    if (this.#fatalError !== null) throw this.#fatalError;
    if (this.#active !== null) {
      throw new AgentError(
        "turn_failed",
        "Codex session already has an active turn",
      );
    }
    if (input.trim() === "") {
      throw new AgentError("turn_failed", "Codex turn input must not be blank");
    }

    const active = this.#newActiveTurn(++this.#turnCount);
    this.#active = active;
    this.#armTurnTimeout(active);

    const params: JsonObject = {
      threadId: this.threadId,
      input: [{ type: "text", text: input }],
      cwd: this.#cwd,
      approvalPolicy: this.#approvalPolicy,
      ...(this.#turnSandboxPolicy === null
        ? {}
        : { sandboxPolicy: this.#turnSandboxPolicy }),
    };

    try {
      const response = await this.#transport.request(
        "turn/start",
        params,
        this.#readTimeoutMs,
      );
      const turn = record(
        record(response, "turn/start result")["turn"],
        "turn",
      );
      const turnId = requiredString(turn["id"], "turn id");
      if (active.turnId !== null && active.turnId !== turnId) {
        throw new AgentError(
          "response_error",
          `Codex turn identity changed from ${active.turnId} to ${turnId}`,
        );
      }
      active.turnId = turnId;
      this.#emit("session_started", {
        continuation: active.number > 1,
        session_id: `${this.threadId}-${turnId}`,
        thread_id: this.threadId,
        turn_id: turnId,
      });
    } catch (error) {
      this.#failActive(asAgentError(error));
    }

    return active.completion;
  }

  async close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#closed = true;
    if (this.#active !== null) {
      this.#failActive(
        new AgentError("turn_cancelled", "Codex session was closed"),
      );
    }
    this.#closePromise = this.#transport.close();
    await this.#closePromise;
  }

  async #initialize(title: string | null): Promise<void> {
    const hasTools = (this.#toolRuntime?.specs.length ?? 0) > 0;
    await this.#transport.request(
      "initialize",
      {
        clientInfo: {
          name: "symphony",
          title: "Symphony",
          version: CLIENT_VERSION,
        },
        capabilities: {
          experimentalApi: hasTools,
          requestAttestation: false,
        },
      },
      this.#readTimeoutMs,
    );
    await this.#transport.notify("initialized");

    const threadParams: JsonObject = {
      cwd: this.#cwd,
      approvalPolicy: this.#approvalPolicy,
      sandbox: this.#threadSandbox,
      ephemeral: false,
      sessionStartSource: "startup",
      threadSource: "symphony",
      ...(hasTools
        ? {
            dynamicTools: this.#toolRuntime!.specs.map((spec) => ({
              type: "function",
              name: spec.name,
              description: spec.description,
              inputSchema: spec.inputSchema,
            })),
          }
        : {}),
    };
    const response = await this.#transport.request(
      "thread/start",
      threadParams,
      this.#readTimeoutMs,
    );
    const thread = record(
      record(response, "thread/start result")["thread"],
      "thread",
    );
    this.#threadId = requiredString(thread["id"], "thread id");

    if (title !== null && title.trim() !== "") {
      await this.#transport.request(
        "thread/name/set",
        { threadId: this.#threadId, name: title },
        this.#readTimeoutMs,
      );
    }
  }

  #transportHandler(): AppServerTransportHandler {
    return {
      onActivity: () => {
        if (this.#active !== null) this.#armTurnTimeout(this.#active);
      },
      onFailure: (error) => this.#handleTransportFailure(error),
      onMalformed: (line, error) => {
        this.#emit("malformed", {
          error_code: error.code,
          line_bytes: Buffer.byteLength(line),
        });
      },
      onNotification: (message) => this.#handleNotification(message),
      onOtherMessage: (message) => {
        this.#emit("other_message", { message });
      },
      onRequest: async (message) => this.#handleServerRequest(message),
    };
  }

  #handleTransportFailure(error: AgentError): void {
    this.#fatalError = error;
    if (this.#active !== null) this.#failActive(error);
  }

  #handleNotification(message: ServerNotificationMessage): void {
    const params = jsonObjectOrNull(message.params);
    switch (message.method) {
      case "error": {
        this.#emit("turn_ended_with_error", {
          method: message.method,
          params: message.params,
        });
        break;
      }
      case "thread/tokenUsage/updated": {
        if (params !== null) {
          const usage = params["tokenUsage"];
          if (isRecord(usage)) {
            const normalized = toJsonObject(usage);
            if (this.#active !== null) this.#active.usage = normalized;
            this.#emit("usage", {
              thread_id:
                typeof params["threadId"] === "string"
                  ? params["threadId"]
                  : null,
              turn_id:
                typeof params["turnId"] === "string" ? params["turnId"] : null,
              usage: normalized,
            });
          }
        }
        break;
      }
      case "account/rateLimits/updated": {
        if (params !== null && isRecord(params["rateLimits"])) {
          this.#latestRateLimits = toJsonObject(params["rateLimits"]);
          this.#emit("rate_limits", {
            rate_limits: this.#latestRateLimits,
          });
        }
        break;
      }
      case "turn/completed": {
        this.#completeTurn(params);
        break;
      }
      default: {
        this.#emit("notification", {
          method: message.method,
          params: message.params,
        });
      }
    }
  }

  #completeTurn(params: JsonObject | null): void {
    if (params === null || this.#active === null) return;
    if (
      typeof params["threadId"] === "string" &&
      params["threadId"] !== this.threadId
    ) {
      return;
    }

    let turn: Record<string, unknown>;
    let turnId: string;
    try {
      turn = record(params["turn"], "completed turn");
      turnId = requiredString(turn["id"], "completed turn id");
    } catch (error) {
      this.#failActive(asAgentError(error));
      return;
    }
    if (this.#active.turnId !== null && this.#active.turnId !== turnId) return;
    this.#active.turnId = turnId;

    const status = turn["status"];
    if (status === "completed") {
      const result: CodexTurnResult = {
        status,
        threadId: this.threadId,
        turnId,
        sessionId: `${this.threadId}-${turnId}`,
        usage: this.#active.usage,
        rateLimits: this.#latestRateLimits,
      };
      this.#emit("turn_completed", {
        session_id: result.sessionId,
        thread_id: result.threadId,
        turn_id: result.turnId,
        usage: result.usage,
      });
      this.#resolveActive(result);
      return;
    }

    const detail = isRecord(turn["error"]) ? toJsonValue(turn["error"]) : null;
    if (status === "interrupted") {
      const error = new AgentError(
        "turn_cancelled",
        `Codex turn ${turnId} was interrupted`,
        { context: { thread_id: this.threadId, turn_id: turnId } },
      );
      this.#emit("turn_cancelled", {
        thread_id: this.threadId,
        turn_id: turnId,
      });
      this.#failActive(error);
      return;
    }

    const error = new AgentError("turn_failed", `Codex turn ${turnId} failed`, {
      context: {
        thread_id: this.threadId,
        turn_id: turnId,
        detail,
      },
    });
    this.#emit("turn_failed", {
      detail,
      thread_id: this.threadId,
      turn_id: turnId,
    });
    this.#failActive(error);
  }

  async #handleServerRequest(message: ServerRequestMessage): Promise<void> {
    switch (message.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval": {
        await this.#transport.respond(message.id, {
          decision: "acceptForSession",
        });
        this.#emit("approval_auto_approved", {
          method: message.method,
          request_id: message.id,
        });
        return;
      }
      case "execCommandApproval":
      case "applyPatchApproval": {
        await this.#transport.respond(message.id, {
          decision: "approved_for_session",
        });
        this.#emit("approval_auto_approved", {
          method: message.method,
          request_id: message.id,
        });
        return;
      }
      case "item/permissions/requestApproval": {
        await this.#transport.respond(message.id, {
          permissions: {},
          scope: "turn",
        });
        this.#emit("permission_request_declined", {
          method: message.method,
          request_id: message.id,
        });
        return;
      }
      case "item/tool/requestUserInput": {
        await this.#transport.respond(message.id, { answers: {} });
        this.#emit("turn_input_required", {
          params: message.params,
          request_id: message.id,
        });
        const error = new AgentError(
          "turn_input_required",
          "Codex requested interactive user input in an unattended run",
        );
        this.#failActive(error);
        this.#interruptFromParams(message.params);
        return;
      }
      case "mcpServer/elicitation/request": {
        await this.#transport.respond(message.id, {
          action: "decline",
          content: null,
          _meta: null,
        });
        return;
      }
      case "item/tool/call": {
        await this.#executeToolCall(message);
        return;
      }
      default: {
        await this.#transport.respondError(
          message.id,
          -32601,
          `Symphony does not implement server request '${message.method}'`,
        );
        this.#emit("unsupported_server_request", {
          method: message.method,
          request_id: message.id,
        });
      }
    }
  }

  async #executeToolCall(message: ServerRequestMessage): Promise<void> {
    const params = jsonObjectOrNull(message.params);
    const tool = params?.["tool"];
    const namespace = params?.["namespace"];
    const argumentsValue = params?.["arguments"] ?? null;
    let result: AgentToolResult;

    if (typeof tool !== "string" || tool.trim() === "") {
      result = toolFailure("invalid_tool_call", "Tool name is missing");
    } else if (namespace !== null && namespace !== undefined) {
      result = toolFailure(
        "unsupported_tool",
        `Namespaced tool '${String(namespace)}/${tool}' is not supported`,
      );
    } else if (
      this.#toolRuntime === null ||
      !this.#toolRuntime.specs.some((spec) => spec.name === tool)
    ) {
      result = toolFailure(
        "unsupported_tool",
        `Tool '${tool}' was not advertised by this Symphony session`,
      );
      this.#emit("unsupported_tool_call", { tool });
    } else {
      try {
        result = await this.#toolRuntime.execute(tool, argumentsValue);
      } catch (error) {
        result = toolFailure("tool_execution_failed", errorMessage(error));
      }
    }

    await this.#transport.respond(message.id, toolResponse(result));
    this.#emit("tool_call_completed", {
      success: result.success,
      tool: typeof tool === "string" ? tool : null,
    });
  }

  #interruptFromParams(params: JsonValue): void {
    if (!isRecord(params)) return;
    const threadId = params["threadId"];
    const turnId = params["turnId"];
    if (typeof threadId !== "string" || typeof turnId !== "string") return;
    void this.#transport
      .request("turn/interrupt", { threadId, turnId }, this.#readTimeoutMs)
      .catch(() => undefined);
  }

  #newActiveTurn(number: number): ActiveTurn {
    let resolve!: (result: CodexTurnResult) => void;
    let reject!: (error: AgentError) => void;
    const completion = new Promise<CodexTurnResult>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    return {
      completion,
      number,
      reject,
      resolve,
      settled: false,
      timeout: null,
      turnId: null,
      usage: null,
    };
  }

  #armTurnTimeout(active: ActiveTurn): void {
    if (active.settled) return;
    if (active.timeout !== null) clearTimeout(active.timeout);
    active.timeout = setTimeout(() => {
      const error = new AgentError(
        "turn_timeout",
        `Codex turn was silent for ${this.#turnTimeoutMs}ms`,
        {
          context: {
            thread_id: this.#threadId,
            turn_id: active.turnId,
            timeout_ms: this.#turnTimeoutMs,
          },
        },
      );
      this.#emit("turn_failed", {
        error_code: error.code,
        thread_id: this.#threadId,
        turn_id: active.turnId,
      });
      this.#failActive(error);
      if (active.turnId !== null && this.#threadId !== null) {
        this.#interruptFromParams({
          threadId: this.#threadId,
          turnId: active.turnId,
        });
      }
    }, this.#turnTimeoutMs);
    active.timeout.unref();
  }

  #resolveActive(result: CodexTurnResult): void {
    const active = this.#active;
    if (active === null || active.settled) return;
    active.settled = true;
    if (active.timeout !== null) clearTimeout(active.timeout);
    this.#active = null;
    active.resolve(result);
  }

  #failActive(error: AgentError): void {
    const active = this.#active;
    if (active === null || active.settled) return;
    active.settled = true;
    if (active.timeout !== null) clearTimeout(active.timeout);
    this.#active = null;
    active.reject(error);
  }

  #emit(event: AgentEventName, payload: JsonObject = {}): void {
    const pid = this.#transport.pid;
    const message: AgentEvent = {
      event,
      timestamp: new Date().toISOString(),
      ...(pid === undefined ? {} : { codex_app_server_pid: pid }),
      ...payload,
    };
    void Promise.resolve(this.#onEvent(message)).catch((error: unknown) => {
      this.#logger.warn("Ignoring Codex event-handler failure", {
        event,
        error: errorMessage(error),
      });
    });
  }
}
