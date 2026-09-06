import assert from "node:assert/strict";
import { it } from "node:test";
import { snapshotJsonData } from "../src/json-snapshot.ts";

const snapshot = (value: unknown) => snapshotJsonData(value, { maximumBytes: 65_536 });
it("bounded JSON snapshot detaches plain/frozen/null-prototype data and preserves JSON semantics", () => {
  const child = Object.assign(Object.create(null) as Record<string, unknown>, { value: "é😀\n\"", n: -0 });
  const input = Object.freeze({ items: Object.freeze([child, child]), yes: true, no: false, none: null, n: 1.25e30 });
  const result = snapshot(input);
  assert.deepEqual(result, { items: [{ value: "é😀\n\"", n: 0 }, { value: "é😀\n\"", n: 0 }], yes: true, no: false, none: null, n: 1.25e30 });
  child.value = "mutated";
  assert.equal(JSON.stringify(result).includes("mutated"), false);
});

it("bounded JSON snapshot counts exact escaped UTF-8 bytes including keys and punctuation", () => {
  for (const value of [null, false, 1e-7, "\ud800", { "😀\"": ["é", "\n", "😀", true, null] }, [], {}]) {
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    assert.deepEqual(snapshotJsonData(value, { maximumBytes: bytes }), value);
    assert.throws(() => snapshotJsonData(value, { maximumBytes: bytes - 1 }));
  }
});

it("bounded JSON snapshot rejects object/array accessors and serialization hooks without calls", () => {
  let calls = 0;
  const getter = () => { calls++; return "private"; };
  const object = Object.defineProperty({}, "field", { enumerable: true, get: getter });
  const array = Object.defineProperty(new Array(1), "0", { enumerable: true, get: getter });
  const iterator = Object.defineProperty([], Symbol.iterator, { value: getter });
  for (const value of [object, array, { nested: [object] }, iterator, { toJSON: getter }, Object.defineProperty({}, "toJSON", { get: getter })]) {
    assert.throws(() => snapshot(value));
  }
  assert.equal(calls, 0);
});

it("bounded JSON snapshot rejects sparse/custom/symbol/hidden shapes and non-JSON values", () => {
  for (const value of [new Array(1), Object.assign([], { extra: 1 }), Object.assign([], { [Symbol()]: 1 }),
    { [Symbol()]: 1 }, Object.defineProperty({}, "hidden", { value: 1 }), new Date(), new Map(),
    Object.create({ inherited: 1 }), Object.setPrototypeOf([], null), [undefined], { value: undefined },
    undefined, () => undefined, Symbol(), 1n, NaN, Infinity, -Infinity]) assert.throws(() => snapshot(value));
});

it("bounded JSON snapshot rejects cycles but allows repeated detached aliases", () => {
  const input: unknown[] = []; input.push(input);
  assert.throws(() => snapshot(input));
  const item = { value: 1 }, result = snapshot([item, item]) as unknown[];
  assert.notEqual(result[0], result[1]); assert.notEqual(result[0], item);
});

it("bounded JSON snapshot enforces depth, node, collection and string limits independently", () => {
  const base = { maximumBytes: 65_536 };
  assert.deepEqual(snapshotJsonData([[null]], { ...base, maximumDepth: 3 }), [[null]]);
  assert.deepEqual(snapshotJsonData([null], { ...base, maximumNodes: 2 }), [null]);
  assert.deepEqual(snapshotJsonData([null], { ...base, maximumCollectionLength: 1 }), [null]);
  assert.deepEqual(snapshotJsonData("123", { ...base, maximumStringLength: 3 }), "123");
  assert.throws(() => snapshotJsonData([[[null]]], { ...base, maximumDepth: 3 }));
  assert.throws(() => snapshotJsonData([null, null], { ...base, maximumNodes: 2 }));
  assert.throws(() => snapshotJsonData([null, null], { ...base, maximumCollectionLength: 1 }));
  assert.throws(() => snapshotJsonData({ a: 1, b: 2 }, { ...base, maximumCollectionLength: 1 }));
  assert.throws(() => snapshotJsonData("1234", { ...base, maximumStringLength: 3 }));
  assert.throws(() => snapshotJsonData({ "1234": 1 }, { ...base, maximumStringLength: 3 }));
  for (const maximumBytes of [0, -1, 1.5, Infinity, NaN]) assert.throws(() => snapshotJsonData({}, { maximumBytes }));
});

it("bounded JSON snapshot treats __proto__ as data without mutating the detached prototype", () => {
  const input = JSON.parse('{"__proto__":{"synthetic":true}}') as unknown;
  const result = snapshot(input);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.hasOwn(result as object, "__proto__"), true);
  assert.deepEqual(result, input);
});
