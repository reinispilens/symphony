import type { JsonObject } from "../shared/json.js";

export type AgentErrorCode =
  | "codex_not_found"
  | "fresh_attempt_refused"
  | "invalid_workspace_cwd"
  | "line_too_large"
  | "malformed_message"
  | "port_exit"
  | "protocol_write_failed"
  | "response_error"
  | "response_timeout"
  | "turn_cancelled"
  | "turn_failed"
  | "turn_input_required"
  | "turn_timeout";

export class AgentError extends Error {
  readonly code: AgentErrorCode;
  readonly context: JsonObject;

  constructor(
    code: AgentErrorCode,
    message: string,
    options: { readonly cause?: unknown; readonly context?: JsonObject } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "AgentError";
    this.code = code;
    this.context = options.context ?? {};
  }
}
