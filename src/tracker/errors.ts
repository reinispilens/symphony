export type TrackerErrorCategory =
  | "invalid_tracker_config"
  | "missing_tracker_secret"
  | "tracker_pagination"
  | "tracker_rate_limited"
  | "tracker_request"
  | "tracker_response"
  | "tracker_status"
  | "unsupported_tracker_kind";

export interface TrackerErrorOptions {
  readonly cause?: unknown;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryAfterMs?: number;
  readonly retryable?: boolean;
}

export class TrackerError extends Error {
  readonly category: TrackerErrorCategory;
  readonly details: Readonly<Record<string, unknown>>;
  readonly retryAfterMs: number | null;
  readonly retryable: boolean;

  constructor(
    category: TrackerErrorCategory,
    message: string,
    options: TrackerErrorOptions = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "TrackerError";
    this.category = category;
    this.details = options.details ?? {};
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.retryable = options.retryable ?? false;
  }
}
