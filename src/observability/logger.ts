export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export const nullLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface JsonLineLoggerOptions {
  readonly minimumLevel?: LogLevel;
  readonly now?: () => Date;
  readonly sink?: Pick<NodeJS.WritableStream, "write">;
}

const LEVEL_PRIORITY: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function jsonSafe(value: unknown, seen = new WeakSet<object>()): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    if (Array.isArray(value)) {
      const result = value.map((entry) => jsonSafe(entry, seen));
      seen.delete(value);
      return result;
    }
    const result = Object.fromEntries(
      Object.entries(value).flatMap(([key, entry]) =>
        entry === undefined ? [] : [[key, jsonSafe(entry, seen)]],
      ),
    );
    seen.delete(value);
    return result;
  }
  return String(value);
}

/** A dependency-free, operator-visible JSON-lines logger. */
export class JsonLineLogger implements Logger {
  readonly #minimumPriority: number;
  readonly #now: () => Date;
  readonly #sink: Pick<NodeJS.WritableStream, "write">;

  constructor(options: JsonLineLoggerOptions = {}) {
    this.#minimumPriority = LEVEL_PRIORITY[options.minimumLevel ?? "info"];
    this.#now = options.now ?? (() => new Date());
    this.#sink = options.sink ?? process.stderr;
  }

  debug(message: string, fields?: LogFields): void {
    this.#log("debug", message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.#log("info", message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.#log("warn", message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.#log("error", message, fields);
  }

  #log(level: LogLevel, message: string, fields: LogFields = {}): void {
    if (LEVEL_PRIORITY[level] < this.#minimumPriority) return;
    const line = `${JSON.stringify(
      jsonSafe({
        ...fields,
        timestamp: this.#now().toISOString(),
        level,
        message,
      }),
    )}\n`;
    try {
      this.#sink.write(line);
    } catch (error) {
      if (this.#sink === process.stderr) return;
      try {
        process.stderr.write(
          `${JSON.stringify({
            timestamp: this.#now().toISOString(),
            level: "warn",
            message: "log_sink outcome=failed",
            error: error instanceof Error ? error.message : String(error),
          })}\n`,
        );
      } catch {
        // Logging must never become orchestration state or crash the daemon.
      }
    }
  }
}
