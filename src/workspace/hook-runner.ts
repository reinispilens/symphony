import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";

import { SymphonyError, errorMessage } from "../errors.js";
import {
  nullLogger,
  type Logger,
  type LogFields,
} from "../observability/logger.js";

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const FORCE_KILL_GRACE_MS = 500;

export type HookName =
  "after_create" | "after_run" | "before_remove" | "before_run";

export interface HookExecution {
  readonly command: string;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly logFields?: LogFields;
  readonly name: HookName;
  readonly timeoutMs: number;
}

export interface HookResult {
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly name: HookName;
  readonly output: string;
  readonly outputTruncated: boolean;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
}

class BoundedOutput {
  readonly #chunks: Buffer[] = [];
  readonly #maximumBytes: number;
  #bytes = 0;
  truncated = false;

  constructor(maximumBytes: number) {
    this.#maximumBytes = maximumBytes;
  }

  append(chunk: Buffer): void {
    const remaining = this.#maximumBytes - this.#bytes;
    if (remaining <= 0) {
      this.truncated = true;
      return;
    }
    if (chunk.length > remaining) {
      this.#chunks.push(chunk.subarray(0, remaining));
      this.#bytes += remaining;
      this.truncated = true;
      return;
    }
    this.#chunks.push(chunk);
    this.#bytes += chunk.length;
  }

  toString(): string {
    return Buffer.concat(this.#chunks, this.#bytes).toString("utf8");
  }
}

function terminate(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") throw error;
  }
}

export interface HookRunnerOptions {
  readonly logger?: Logger;
  readonly maximumOutputBytes?: number;
}

export class HookRunner {
  readonly #logger: Logger;
  readonly #maximumOutputBytes: number;

  constructor(options: HookRunnerOptions = {}) {
    this.#logger = options.logger ?? nullLogger;
    this.#maximumOutputBytes =
      options.maximumOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  async run(execution: HookExecution): Promise<HookResult> {
    const startedAt = Date.now();
    const output = new BoundedOutput(this.#maximumOutputBytes);
    this.#logger.info("Workspace hook started", {
      ...execution.logFields,
      hook: execution.name,
      workspace_path: execution.cwd,
      timeout_ms: execution.timeoutMs,
    });

    return new Promise<HookResult>((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      let forceKillTimer: NodeJS.Timeout | undefined;
      const child = spawn("sh", ["-lc", execution.command], {
        cwd: execution.cwd,
        detached: process.platform !== "win32",
        env: execution.environment,
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout?.on("data", (chunk: Buffer) => output.append(chunk));
      child.stderr?.on("data", (chunk: Buffer) => output.append(chunk));

      const timeout = setTimeout(() => {
        timedOut = true;
        try {
          terminate(child, "SIGTERM");
          forceKillTimer = setTimeout(() => {
            try {
              terminate(child, "SIGKILL");
            } catch {
              // The close event remains the authoritative result.
            }
          }, FORCE_KILL_GRACE_MS);
        } catch (error) {
          this.#logger.warn("Could not terminate timed-out workspace hook", {
            ...execution.logFields,
            hook: execution.name,
            workspace_path: execution.cwd,
            error: errorMessage(error),
          });
        }
      }, execution.timeoutMs);

      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
        reject(
          new SymphonyError(
            "hook_failed",
            `Could not start ${execution.name} hook: ${error.message}`,
            {
              cause: error,
              context: { hook: execution.name, workspace_path: execution.cwd },
            },
          ),
        );
      });

      child.once("close", (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
        const result: HookResult = {
          durationMs: Date.now() - startedAt,
          exitCode,
          name: execution.name,
          output: output.toString(),
          outputTruncated: output.truncated,
          signal,
          timedOut,
        };
        this.#logger.info("Workspace hook finished", {
          ...execution.logFields,
          hook: execution.name,
          workspace_path: execution.cwd,
          duration_ms: result.durationMs,
          exit_code: exitCode,
          signal,
          timed_out: timedOut,
          output_truncated: result.outputTruncated,
        });
        resolve(result);
      });
    });
  }
}
