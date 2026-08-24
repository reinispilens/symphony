export type TimerHandle = ReturnType<typeof setTimeout>;

export interface OrchestratorClock {
  clearTimeout(handle: TimerHandle): void;
  nowMs(): number;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
}

export const systemClock: OrchestratorClock = {
  clearTimeout: (handle) => clearTimeout(handle),
  nowMs: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
};
