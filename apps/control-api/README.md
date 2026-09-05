# ACP control API

The control API exposes the narrow counterpart MCP surface at `/mcp` and an
unauthenticated liveness endpoint at `/healthz`. It is designed to bind to
loopback or a private interface behind a TLS-terminating proxy; it is not a
public cleartext listener.

Required environment:

- `ACP_DATABASE_URL`: PostgreSQL connection URL.
- `ACP_MCP_BEARER_TOKEN`: whitespace-free secret of at least 32 bytes.
- `ACP_RUNTIME_PROVENANCE_ID`: exact configured ACP runtime provenance ID.

Deployment controls:

- `ACP_CONTROL_HOST` and `ACP_CONTROL_PORT` default to `127.0.0.1:8787`.
- `ACP_CONTROL_ALLOWED_HOSTS` is a comma-separated exact Host-header allowlist.
- `ACP_CONTROL_ALLOWED_ORIGINS` is a comma-separated allowlist for browser
  Origins. Requests without an Origin remain valid for server-side Codex MCP
  clients; any present Origin must match exactly.
- `ACP_ALLOWED_PLUGIN_VERSIONS` defaults to `0.1.0` and admits the exact
  `X-ACP-Plugin-Version` sent by the plugin.
- `ACP_REQUIRE_FORWARDED_HTTPS` defaults to true in production.
- `ACP_CONTROL_TRUSTED_PROXIES` is a comma-separated exact remote-address
  allowlist. Only those peers may assert a single `X-Forwarded-Proto: https`.
  A production non-loopback bind fails startup when no trusted proxy is set.

Start locally with `npm run start:control-api` after the schema, binding, and
runtime-provenance records exist. The repository deliberately contains no
bearer token or deployed endpoint.
