import type { JsonObject } from "./shared/json.js";

export type SymphonyErrorCode =
  | "config_validation_error"
  | "fresh_attempt_invalid"
  | "fresh_attempt_reset_failed"
  | "hook_failed"
  | "hook_timeout"
  | "missing_workflow_file"
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
