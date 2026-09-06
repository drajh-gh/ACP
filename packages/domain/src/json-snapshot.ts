import { ContractValidationError, type JsonValue } from "./validation.ts";

export interface JsonSnapshotLimits {
  readonly maximumBytes: number;
  readonly maximumDepth?: number;
  readonly maximumNodes?: number;
  readonly maximumCollectionLength?: number;
  readonly maximumStringLength?: number;
}

/** Detach bounded JSON data without invoking accessors or serialization hooks.
 * This is not a sandbox for hostile Proxy traps or a process-wide prototype mutation. */
export function snapshotJsonData(value: unknown, limits: JsonSnapshotLimits): JsonValue {
  const { maximumBytes, maximumDepth = 32, maximumNodes = 10_000,
    maximumCollectionLength = 200, maximumStringLength = 4096 } = limits;
  for (const limit of [maximumBytes, maximumDepth, maximumNodes, maximumCollectionLength, maximumStringLength]) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("JSON snapshot limits must be positive safe integers");
  }
  const ancestors = new WeakSet<object>(), encoder = new TextEncoder();
  let bytes = 0, nodes = 0;
  const reject = (): never => { throw new ContractValidationError("JSON data", "requires a bounded snapshot of plain JSON data"); };
  const addBytes = (count: number) => { bytes += count; if (bytes > maximumBytes) reject(); };
  const stringBytes = (text: string) => {
    if (text.length > maximumStringLength) reject();
    addBytes(encoder.encode(JSON.stringify(text)).byteLength);
  };
  const visit = (input: unknown, depth: number): JsonValue => {
    if (++nodes > maximumNodes || depth > maximumDepth) reject();
    if (input === null) { addBytes(4); return null; }
    if (typeof input === "string") { stringBytes(input); return input; }
    if (typeof input === "boolean") { addBytes(input ? 4 : 5); return input; }
    if (typeof input === "number") {
      if (!Number.isFinite(input)) reject();
      addBytes(JSON.stringify(input).length); return Object.is(input, -0) ? 0 : input;
    }
    if (typeof input !== "object") return reject();
    if (ancestors.has(input)) return reject();
    const array = Array.isArray(input), prototype = Object.getPrototypeOf(input);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) reject();
    ancestors.add(input);
    try {
      if (array) {
        const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
        const length: unknown = lengthDescriptor?.value;
        if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > maximumCollectionLength) return reject();
        const keys = Reflect.ownKeys(input);
        if (keys.length !== length + 1 || keys.some((key) => typeof key !== "string"
          || (key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key)))) reject();
        addBytes(2 + Math.max(0, length - 1));
        const result: JsonValue[] = [];
        for (let index = 0; index < length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
          if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return reject();
          result.push(visit(descriptor.value, depth + 1));
        }
        return result;
      }
      const keys = Reflect.ownKeys(input);
      if (keys.length > maximumCollectionLength) reject();
      addBytes(2 + Math.max(0, keys.length - 1));
      const result: Record<string, JsonValue> = {};
      for (const key of keys) {
        if (typeof key !== "string") return reject();
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return reject();
        stringBytes(key); addBytes(1);
        Object.defineProperty(result, key, { value: visit(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return result;
    } finally { ancestors.delete(input); }
  };
  return visit(value, 1);
}
