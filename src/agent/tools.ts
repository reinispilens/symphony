import type { JsonObject, JsonValue } from "../shared/json.js";

export interface AgentToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

export type AgentToolResult =
  | { readonly success: true; readonly output: JsonValue }
  | {
      readonly success: false;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly details?: JsonValue;
      };
    };

/** One immutable provider-tool snapshot bound to one Codex session. */
export interface AgentToolRuntime {
  readonly specs: readonly AgentToolSpec[];
  execute(name: string, argumentsValue: JsonValue): Promise<AgentToolResult>;
}
