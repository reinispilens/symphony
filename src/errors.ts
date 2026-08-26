import type { JsonObject } from "./shared/json.js";

export type SymphonyErrorCode =
  | "agent_sandbox_refused"
  | "config_validation_error"
  | "deployment_binding_invalid"
  | "deployment_binding_refused"
  | "delivery_provider_failed"
  | "delivery_provider_refused"
  | "delivery_refused"
  | "fresh_attempt_invalid"
  | "fresh_attempt_reset_failed"
  | "governance_manifest_invalid"
  | "governance_refused"
  | "hook_failed"
  | "hook_timeout"
  | "interactive_control_refused"
  | "interactive_input_invalid"
  | "materialization_failed"
  | "materialization_refused"
  | "missing_workflow_file"
  | "preparation_failed"
  | "preparation_refused"
  | "repository_driver_failed"
  | "repository_driver_refused"
  | "repository_profile_invalid"
  | "runtime_quiescence_refused"
  | "template_parse_error"
  | "template_render_error"
  | "tracker_policy_invalid"
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
