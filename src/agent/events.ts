import type { JsonValue } from "../shared/json.js";

export type AgentEventName =
  | "approval_auto_approved"
  | "malformed"
  | "notification"
  | "other_message"
  | "permission_request_declined"
  | "rate_limits"
  | "session_started"
  | "startup_failed"
  | "tool_call_completed"
  | "turn_cancelled"
  | "turn_completed"
  | "turn_ended_with_error"
  | "turn_failed"
  | "turn_input_required"
  | "unsupported_server_request"
  | "unsupported_tool_call"
  | "usage";

export interface AgentEvent {
  readonly event: AgentEventName;
  readonly timestamp: string;
  readonly codex_app_server_pid?: number;
  readonly [key: string]: JsonValue | undefined;
}

export type AgentEventHandler = (event: AgentEvent) => void | Promise<void>;
