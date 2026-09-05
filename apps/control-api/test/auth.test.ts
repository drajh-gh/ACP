import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  authorizeBearerHeader,
  validateConfiguredBearerToken,
} from "../src/auth.ts";

describe("control API bearer authentication", () => {
  it("accepts only an exact bearer token", () => {
    const token = "a-high-entropy-test-token-that-is-long-enough";
    assert.equal(authorizeBearerHeader(`Bearer ${token}`, token), true);
    assert.equal(authorizeBearerHeader(`Bearer ${token}x`, token), false);
    assert.equal(authorizeBearerHeader(`Basic ${token}`, token), false);
    assert.equal(authorizeBearerHeader(undefined, token), false);
  });

  it("rejects short configured secrets", () => {
    assert.throws(
      () => validateConfiguredBearerToken("too-short"),
      /at least 32 bytes/,
    );
  });

  it("rejects configured tokens that cannot be represented in a bearer header", () => {
    assert.throws(
      () => validateConfiguredBearerToken(
        " a-high-entropy-test-token-that-is-long-enough",
      ),
      /must not contain whitespace/,
    );
  });
});
