import type { JsonObject } from "./shared/json.js";

export type SymphonyErrorCode =
  | "agent_sandbox_refused"
  | "config_validation_error"
  | "deployment_binding_invalid"
  | "deployment_binding_refused"
  | "fresh_attempt_invalid"
  | "fresh_attempt_reset_failed"
  | "hook_failed"
  | "hook_timeout"
  | "missing_workflow_file"
  | "preparation_failed"
  | "preparation_refused"
  | "repository_driver_failed"
  | "repository_driver_refused"
  | "repository_profile_invalid"
  | "runtime_quiescence_refused"
  | "template_parse_error"
  | "template_render_error"
  | "workflow_front_matter_not_a_map"
  | "workflow_parse_error"
  | "workspace_not_directory"
  | "workspace_path_unsafe";

export class SymphonyError extends Error {
  readonly code: SymphonyErrorCode;
  readonly context: JsonObject;

  constructor(
    code: SymphonyErrorCode,
    message: string,
    options: { readonly cause?: unknown; readonly context?: JsonObject } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "SymphonyError";
    this.code = code;
    this.context = options.context ?? {};
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
