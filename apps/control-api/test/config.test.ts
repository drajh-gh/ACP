import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createStableId } from "@acp/domain";

import { controlApiDatabaseLimits,parseControlApiConfig } from "../src/config.ts";

describe("control API configuration", () => {
  it("bounds control API pool capacity, connection waits and SQL/lock execution",()=>{
    assert.deepEqual(controlApiDatabaseLimits,{ max:4,connectionTimeoutMillis:3000,statement_timeout:5000,lock_timeout:2000 });
    assert.equal(Object.isFrozen(controlApiDatabaseLimits),true);
  });
  it("defaults to loopback and requires HTTPS forwarding in production", () => {
    const config = parseControlApiConfig({
      ACP_DATABASE_URL: "postgresql://localhost/acp",
      ACP_MCP_BEARER_TOKEN: "a-high-entropy-test-token-that-is-long-enough",
      ACP_RUNTIME_PROVENANCE_ID: createStableId("provenance"),
      NODE_ENV: "production",
    });

    assert.equal(config.hostname, "127.0.0.1");
    assert.equal(config.port, 8787);
    assert.equal(config.requireForwardedHttps, true);
    assert.deepEqual(config.allowedHosts, [
      "127.0.0.1:8787",
      "localhost:8787",
    ]);
    assert.deepEqual(config.allowedOrigins, []);
    assert.deepEqual(config.allowedPluginVersions, ["0.1.0", "0.2.0"]);
    assert.deepEqual(config.trustedProxyAddresses, [
      "127.0.0.1",
      "::1",
      "::ffff:127.0.0.1",
    ]);
  });

  it("rejects a non-PostgreSQL database URL", () => {
    assert.throws(
      () => parseControlApiConfig({
        ACP_DATABASE_URL: "https://example.com",
        ACP_MCP_BEARER_TOKEN: "a-high-entropy-test-token-that-is-long-enough",
        ACP_RUNTIME_PROVENANCE_ID: createStableId("provenance"),
      }),
      /PostgreSQL URL/,
    );
  });

  it("requires explicit trusted proxies for a production non-loopback bind", () => {
    assert.throws(
      () => parseControlApiConfig({
        ACP_DATABASE_URL: "postgresql://localhost/acp",
        ACP_MCP_BEARER_TOKEN: "a-high-entropy-test-token-that-is-long-enough",
        ACP_RUNTIME_PROVENANCE_ID: createStableId("provenance"),
        ACP_CONTROL_HOST: "0.0.0.0",
        NODE_ENV: "production",
      }),
      /requires an explicit trusted proxy/,
    );
  });

  it("parses exact browser origins and plugin compatibility versions", () => {
    const config = parseControlApiConfig({
      ACP_DATABASE_URL: "postgresql://localhost/acp",
      ACP_MCP_BEARER_TOKEN: "a-high-entropy-test-token-that-is-long-enough",
      ACP_RUNTIME_PROVENANCE_ID: createStableId("provenance"),
      ACP_CONTROL_ALLOWED_ORIGINS: "https://codex.example.com",
      ACP_ALLOWED_PLUGIN_VERSIONS: "0.1.0,0.1.1",
    });

    assert.deepEqual(config.allowedOrigins, ["https://codex.example.com"]);
    assert.deepEqual(config.allowedPluginVersions, ["0.1.0", "0.1.1"]);
  });
});
