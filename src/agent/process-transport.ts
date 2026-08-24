import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { isRecord, toJsonValue, type JsonValue } from "../shared/json.js";
import { AgentError } from "./errors.js";

const DEFAULT_MAX_LINE_BYTES = 10 * 1024 * 1024;
const STDERR_TAIL_BYTES = 64 * 1024;
const SHUTDOWN_GRACE_MS = 1_000;

type RequestId = number | string;

interface PendingRequest {
  readonly method: string;
  readonly reject: (error: AgentError) => void;
  readonly resolve: (value: JsonValue) => void;
  readonly timer: NodeJS.Timeout;
}

export interface ServerRequestMessage {
  readonly id: RequestId;
  readonly method: string;
  readonly params: JsonValue;
}

export interface ServerNotificationMessage {
  readonly method: string;
  readonly params: JsonValue;
}

export interface AppServerTransportHandler {
  onActivity(): void;
  onFailure(error: AgentError): void;
  onMalformed(line: string, error: AgentError): void;
  onNotification(message: ServerNotificationMessage): void;
  onOtherMessage(message: JsonValue): void;
  onRequest(message: ServerRequestMessage): void | Promise<void>;
}

export interface AppServerTransportOptions {
  readonly command: string;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly maxLineBytes?: number;
}

const noopHandler: AppServerTransportHandler = {
  onActivity: () => undefined,
  onFailure: () => undefined,
  onMalformed: () => undefined,
  onNotification: () => undefined,
  onOtherMessage: () => undefined,
  onRequest: () => undefined,
};

function requestId(value: unknown): value is RequestId {
  return typeof value === "number" || typeof value === "string";
}

function asJson(value: unknown): JsonValue {
  return toJsonValue(value, "app-server message");
}

async function validatedCwd(cwd: string): Promise<string> {
  if (!path.isAbsolute(cwd)) {
    throw new AgentError(
      "invalid_workspace_cwd",
      `Codex workspace cwd must be absolute: ${cwd}`,
    );
  }

  try {
    const entry = await lstat(cwd);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new AgentError(
        "invalid_workspace_cwd",
        `Codex workspace cwd is not a real directory: ${cwd}`,
      );
    }
    return await realpath(cwd);
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw new AgentError(
      "invalid_workspace_cwd",
      `Could not access Codex workspace cwd: ${cwd}`,
      { cause: error },
    );
  }
}

/**
 * The small process boundary for Codex's default stdio protocol.
 *
 * It owns process groups, bounded JSONL framing, request correlation, and
 * request timeouts. Protocol policy (turns, approvals, tools) lives one layer
 * above this class.
 */
export class AppServerProcessTransport {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #maxLineBytes: number;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #exitPromise: Promise<void>;
  #buffer = Buffer.alloc(0);
  #closing = false;
  #exited = false;
  #failure: AgentError | null = null;
  #handler: AppServerTransportHandler = noopHandler;
  #nextId = 1;
  #resolveExit!: () => void;
  #stderrTail = Buffer.alloc(0);

  private constructor(
    child: ChildProcessWithoutNullStreams,
    maxLineBytes: number,
  ) {
    this.#child = child;
    this.#maxLineBytes = maxLineBytes;
    this.#exitPromise = new Promise((resolve) => {
      this.#resolveExit = resolve;
    });

    child.stdout.on("data", (chunk: Buffer) => this.#acceptChunk(chunk));
    child.stdout.on("end", () => this.#acceptEnd());
    child.stderr.on("data", (chunk: Buffer) => this.#rememberStderr(chunk));
    child.stdin.on("error", (error) => {
      if (!this.#closing) {
        this.#fail(
          new AgentError(
            "protocol_write_failed",
            "Could not write to the Codex app-server protocol stream",
            { cause: error },
          ),
        );
      }
    });
    child.on("error", (error) => {
      if (!this.#closing) this.#fail(this.#spawnError(error));
    });
    child.on("close", (code, signal) => {
      this.#exited = true;
      this.#resolveExit();
      if (!this.#closing) this.#fail(this.#exitError(code, signal));
    });
  }

  static async launch(
    options: AppServerTransportOptions,
  ): Promise<AppServerProcessTransport> {
    const cwd = await validatedCwd(options.cwd);
    const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) {
      throw new TypeError("maxLineBytes must be a positive integer");
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn("bash", ["-lc", options.command], {
        cwd,
        detached: process.platform !== "win32",
        env: { ...options.environment },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw new AgentError(
        "codex_not_found",
        "Could not launch the Codex app-server command",
        { cause: error },
      );
    }

    const transport = new AppServerProcessTransport(child, maxLineBytes);
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (error) => reject(transport.#spawnError(error)));
    });
    return transport;
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  setHandler(handler: AppServerTransportHandler): void {
    this.#handler = handler;
    if (this.#failure !== null) handler.onFailure(this.#failure);
  }

  async request(
    method: string,
    params: JsonValue,
    timeoutMs: number,
  ): Promise<JsonValue> {
    if (this.#failure !== null) throw this.#failure;
    if (this.#closing) {
      throw new AgentError("port_exit", "Codex app-server is closing");
    }

    const id = this.#nextId++;
    let settle!: PendingRequest;
    const response = new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new AgentError(
            "response_timeout",
            `Codex app-server request '${method}' timed out after ${timeoutMs}ms`,
            { context: { method, timeout_ms: timeoutMs } },
          ),
        );
      }, timeoutMs);
      timer.unref();
      settle = { method, reject, resolve, timer };
    });
    this.#pending.set(id, settle);

    try {
      await this.#write({ id, method, params });
    } catch (error) {
      const pending = this.#pending.get(id);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.#pending.delete(id);
      }
      throw error;
    }
    return response;
  }

  async notify(method: string): Promise<void> {
    await this.#write({ method });
  }

  async respond(id: RequestId, result: JsonValue): Promise<void> {
    await this.#write({ id, result });
  }

  async respondError(
    id: RequestId,
    code: number,
    message: string,
  ): Promise<void> {
    await this.#write({ id, error: { code, message } });
  }

  async close(): Promise<void> {
    if (this.#closing) return this.#exitPromise;
    this.#closing = true;
    this.#rejectPending(
      new AgentError("port_exit", "Codex app-server session was closed"),
    );

    if (this.#exited) return;
    this.#child.stdin.end();
    this.#signal("SIGTERM");

    let forceTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.#exitPromise,
      new Promise<void>((resolve) => {
        forceTimer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
        forceTimer.unref();
      }),
    ]);
    if (forceTimer !== undefined) clearTimeout(forceTimer);

    if (!this.#exited) {
      this.#signal("SIGKILL");
      await this.#exitPromise;
    }
  }

  #acceptChunk(chunk: Buffer): void {
    if (this.#failure !== null || this.#closing) return;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);

    for (;;) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline < 0) break;
      const line = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (line.byteLength > this.#maxLineBytes) {
        this.#lineTooLarge(line.byteLength);
        return;
      }
      this.#acceptLine(line);
      if (this.#failure !== null) return;
    }

    if (this.#buffer.byteLength > this.#maxLineBytes) {
      this.#lineTooLarge(this.#buffer.byteLength);
    }
  }

  #acceptEnd(): void {
    if (
      this.#failure !== null ||
      this.#closing ||
      this.#buffer.byteLength === 0
    ) {
      return;
    }
    if (this.#buffer.byteLength > this.#maxLineBytes) {
      this.#lineTooLarge(this.#buffer.byteLength);
      return;
    }
    const line = this.#buffer;
    this.#buffer = Buffer.alloc(0);
    this.#acceptLine(line);
  }

  #acceptLine(rawLine: Buffer): void {
    const line = rawLine.at(-1) === 0x0d ? rawLine.subarray(0, -1) : rawLine;
    if (line.byteLength === 0) return;
    this.#handler.onActivity();

    const text = line.toString("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      const error = new AgentError(
        "malformed_message",
        "Codex app-server emitted malformed JSONL",
        { cause },
      );
      this.#handler.onMalformed(text, error);
      this.#fail(error);
      return;
    }

    let message: JsonValue;
    try {
      message = asJson(parsed);
    } catch (cause) {
      const error = new AgentError(
        "malformed_message",
        "Codex app-server emitted a non-JSON-safe message",
        { cause },
      );
      this.#handler.onMalformed(text, error);
      this.#fail(error);
      return;
    }

    if (!isRecord(parsed)) {
      this.#handler.onOtherMessage(message);
      return;
    }

    const id = parsed["id"];
    const method = parsed["method"];
    if (requestId(id) && typeof method !== "string") {
      this.#acceptResponse(id, parsed);
      return;
    }
    if (typeof method === "string") {
      const params =
        parsed["params"] === undefined ? null : asJson(parsed["params"]);
      if (requestId(id)) {
        void Promise.resolve(
          this.#handler.onRequest({ id, method, params }),
        ).catch((cause: unknown) => {
          this.#fail(
            cause instanceof AgentError
              ? cause
              : new AgentError(
                  "response_error",
                  `Failed to handle Codex server request '${method}'`,
                  { cause },
                ),
          );
        });
      } else {
        this.#handler.onNotification({ method, params });
      }
      return;
    }

    this.#handler.onOtherMessage(message);
  }

  #acceptResponse(id: RequestId, message: Record<string, unknown>): void {
    if (typeof id !== "number") {
      this.#handler.onOtherMessage(asJson(message));
      return;
    }
    const pending = this.#pending.get(id);
    if (pending === undefined) {
      this.#handler.onOtherMessage(asJson(message));
      return;
    }

    clearTimeout(pending.timer);
    this.#pending.delete(id);
    if (message["error"] !== undefined) {
      const errorValue = isRecord(message["error"])
        ? message["error"]
        : { message: "Unknown app-server response error" };
      const responseMessage =
        typeof errorValue["message"] === "string"
          ? errorValue["message"]
          : "Unknown app-server response error";
      pending.reject(
        new AgentError(
          "response_error",
          `Codex app-server request '${pending.method}' failed: ${responseMessage}`,
          {
            context: {
              method: pending.method,
              response_error: asJson(errorValue),
            },
          },
        ),
      );
      return;
    }

    try {
      pending.resolve(asJson(message["result"] ?? null));
    } catch (cause) {
      pending.reject(
        new AgentError(
          "response_error",
          `Codex app-server request '${pending.method}' returned an invalid result`,
          { cause, context: { method: pending.method } },
        ),
      );
    }
  }

  async #write(message: unknown): Promise<void> {
    if (this.#failure !== null) throw this.#failure;
    if (this.#closing) {
      throw new AgentError("port_exit", "Codex app-server is closing");
    }

    const payload = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(payload) > this.#maxLineBytes) {
      throw new AgentError(
        "line_too_large",
        `Codex protocol output exceeded ${this.#maxLineBytes} bytes`,
      );
    }

    await new Promise<void>((resolve, reject) => {
      this.#child.stdin.write(payload, "utf8", (error) => {
        if (error === null || error === undefined) resolve();
        else {
          reject(
            new AgentError(
              "protocol_write_failed",
              "Could not write to the Codex app-server protocol stream",
              { cause: error },
            ),
          );
        }
      });
    });
  }

  #lineTooLarge(observedBytes: number): void {
    const error = new AgentError(
      "line_too_large",
      `Codex app-server line exceeded ${this.#maxLineBytes} bytes`,
      {
        context: {
          max_line_bytes: this.#maxLineBytes,
          observed_bytes: observedBytes,
        },
      },
    );
    this.#handler.onMalformed("", error);
    this.#fail(error);
  }

  #rememberStderr(chunk: Buffer): void {
    const combined = Buffer.concat([this.#stderrTail, chunk]);
    this.#stderrTail =
      combined.byteLength <= STDERR_TAIL_BYTES
        ? combined
        : combined.subarray(combined.byteLength - STDERR_TAIL_BYTES);
  }

  #spawnError(error: Error): AgentError {
    return new AgentError(
      "codex_not_found",
      "Could not launch the Codex app-server command",
      { cause: error },
    );
  }

  #exitError(code: number | null, signal: NodeJS.Signals | null): AgentError {
    if (code === 127) {
      return new AgentError(
        "codex_not_found",
        "The configured Codex app-server command was not found",
        { context: { exit_code: code } },
      );
    }
    return new AgentError(
      "port_exit",
      `Codex app-server exited before the session ended (code=${String(code)}, signal=${String(signal)})`,
      {
        context: {
          exit_code: code,
          signal,
          stderr_bytes: this.#stderrTail.byteLength,
        },
      },
    );
  }

  #fail(error: AgentError): void {
    if (this.#failure !== null || this.#closing) return;
    this.#failure = error;
    this.#rejectPending(error);
    this.#handler.onFailure(error);
  }

  #rejectPending(error: AgentError): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #signal(signal: NodeJS.Signals): void {
    if (this.#exited) return;
    const pid = this.#child.pid;
    try {
      if (process.platform !== "win32" && pid !== undefined && pid > 0) {
        process.kill(-pid, signal);
      } else {
        this.#child.kill(signal);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}
