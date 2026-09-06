import assert from "node:assert/strict";
import { it } from "node:test";
import { parseCanonicalTimestamp, timestampMicroseconds } from "../src/validation.ts";
import { parseReadinessTimestamp, readinessTimestampMicroseconds } from "../src/readiness.ts";

it("shares exact canonical UTC microseconds across profile and readiness contracts", () => {
  for (const [input, canonical, micros] of [
    ["2026-09-06T02:00:00.000001+02:00", "2026-09-06T00:00:00.000001Z", 1788652800000001n],
    ["1969-12-31T23:59:59.999999Z", "1969-12-31T23:59:59.999999Z", -1n],
    ["1970-01-01T00:00:00Z", "1970-01-01T00:00:00.000000Z", 0n],
  ] as const) {
    assert.equal(parseCanonicalTimestamp(input), canonical);
    assert.equal(timestampMicroseconds(input), micros);
    assert.equal(parseReadinessTimestamp(input), canonical);
    assert.equal(readinessTimestampMicroseconds(input), micros);
  }
  for (const invalid of ["0000-01-01T00:00:00Z", "2026-02-29T00:00:00Z", "2026-09-06T24:00:00Z", "2026-09-06T00:00:00.0000001Z", "infinity"]) {
    assert.throws(() => parseCanonicalTimestamp(invalid));
    assert.throws(() => timestampMicroseconds(invalid));
  }
});
