export type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export class ContractValidationError extends TypeError {
  readonly path: string;

  constructor(path: string, expectation: string) {
    super(`${path} ${expectation}`);
    this.name = "ContractValidationError";
    this.path = path;
  }
}

export function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractValidationError(path, "must be an object");
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ContractValidationError(path, "must be a plain object");
  }

  return value as Record<string, unknown>;
}

export function expectOnlyKeys(
  record: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[],
  path: string,
): void {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(record).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new ContractValidationError(
      path,
      `contains unexpected fields: ${unexpected.sort().join(", ")}`,
    );
  }
}

export function expectArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new ContractValidationError(path, "must be an array");
  }

  return value;
}

export function expectString(
  value: unknown,
  path: string,
  options: { readonly allowEmpty?: boolean } = {},
): string {
  if (typeof value !== "string" || (!options.allowEmpty && value.trim().length === 0)) {
    throw new ContractValidationError(path, "must be a non-empty string");
  }

  return value;
}

export function expectOptionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : expectString(value, path);
}

export function expectStringArray(value: unknown, path: string): readonly string[] {
  return expectArray(value, path).map((item, index) =>
    expectString(item, `${path}[${index}]`),
  );
}

export function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new ContractValidationError(path, "must be a boolean");
  }

  return value;
}

export function expectFiniteNumber(
  value: unknown,
  path: string,
  options: { readonly minimum?: number; readonly maximum?: number } = {},
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ContractValidationError(path, "must be a finite number");
  }

  if (options.minimum !== undefined && value < options.minimum) {
    throw new ContractValidationError(path, `must be at least ${options.minimum}`);
  }

  if (options.maximum !== undefined && value > options.maximum) {
    throw new ContractValidationError(path, `must be at most ${options.maximum}`);
  }

  return value;
}

export function expectInteger(
  value: unknown,
  path: string,
  options: { readonly minimum?: number; readonly maximum?: number } = {},
): number {
  const number = expectFiniteNumber(value, path, options);
  if (!Number.isInteger(number)) {
    throw new ContractValidationError(path, "must be an integer");
  }
  return number;
}

export function expectEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  path: string,
): T[number] {
  if (
    typeof value !== "string" ||
    !allowed.some((candidate) => candidate === value)
  ) {
    throw new ContractValidationError(
      path,
      `must be one of: ${allowed.join(", ")}`,
    );
  }

  return value as T[number];
}

const isoTimestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

export function expectIsoTimestamp(value: unknown, path: string): string {
  const timestamp = expectString(value, path);
  if (!isoTimestampPattern.test(timestamp) || Number.isNaN(Date.parse(timestamp))) {
    throw new ContractValidationError(path, "must be an ISO 8601 timestamp with a timezone");
  }

  return timestamp;
}

export function timestampMilliseconds(value: unknown, path: string): number {
  return Date.parse(expectIsoTimestamp(value, path));
}

/** PostgreSQL-compatible finite Gregorian UTC timestamp retaining all six fractional digits. */
export function parseCanonicalTimestamp(value: unknown): string {
  const input = expectIsoTimestamp(value, "exact timestamp");
  const parts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/u.exec(input);
  if (!parts || input.startsWith("0000-")) throw new TypeError("exact timestamp must have a Gregorian date and at most six fractional digits");
  const wall = new Date(`${parts[1]}Z`);
  if (Number.isNaN(wall.getTime()) || wall.toISOString().slice(0, 19) !== parts[1]) {
    throw new TypeError("exact timestamp must have a valid Gregorian date and time");
  }
  const fraction = (parts[2] ?? "").padEnd(6, "0");
  const utc = new Date(input).toISOString();
  if (utc.length !== 24 || utc.startsWith("0000-")) throw new TypeError("exact timestamp UTC year must be between 0001 and 9999");
  return `${utc.slice(0, 20)}${fraction}Z`;
}

export function timestampMicroseconds(value: unknown): bigint {
  const canonical = parseCanonicalTimestamp(value);
  return BigInt(Date.parse(canonical)) * 1000n + BigInt(canonical.slice(23, 26));
}

export function expectOptionalIsoTimestamp(
  value: unknown,
  path: string,
): string | undefined {
  return value === undefined ? undefined : expectIsoTimestamp(value, path);
}

export function expectJsonValue(value: unknown, path: string): JsonValue {
  return validateJsonValue(value, path, new WeakSet<object>());
}

function validateJsonValue(
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ContractValidationError(path, "must contain only finite JSON numbers");
    }
    return value;
  }

  if (typeof value !== "object") {
    throw new ContractValidationError(path, "must be JSON-compatible");
  }

  if (ancestors.has(value)) {
    throw new ContractValidationError(path, "must not contain circular references");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        validateJsonValue(item, `${path}[${index}]`, ancestors),
      );
    }

    const record = expectRecord(value, path);
    const parsed: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(record)) {
      parsed[key] = validateJsonValue(item, `${path}.${key}`, ancestors);
    }
    return parsed;
  } finally {
    ancestors.delete(value);
  }
}
