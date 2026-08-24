export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toJsonValue(value: unknown, path = "value"): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry, index) => toJsonValue(entry, `${path}[${index}]`));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        toJsonValue(entry, `${path}.${key}`),
      ]),
    );
  }

  throw new TypeError(`${path} is not JSON-safe`);
}

export function toJsonObject(value: unknown, path = "value"): JsonObject {
  const converted = toJsonValue(value, path);
  if (
    converted === null ||
    Array.isArray(converted) ||
    typeof converted !== "object"
  ) {
    throw new TypeError(`${path} must be an object`);
  }
  return converted;
}
