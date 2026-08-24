import type { JsonObject } from "../shared/json.js";

export interface TrackerConfigProfile {
  readonly kind: string;
  readonly defaultActiveStates?: readonly string[];
  readonly defaultTerminalStates?: readonly string[];
  readonly secretEnvironmentNames: readonly string[];
  resolveProvider(
    provider: JsonObject,
    environment: Readonly<Record<string, string | undefined>>,
  ): JsonObject;
}

export type TrackerConfigProfiles = ReadonlyMap<string, TrackerConfigProfile>;
