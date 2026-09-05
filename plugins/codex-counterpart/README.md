# ACP Codex counterpart plugin

This validated plugin package bundles the ACP counterpart workflow and an
authenticated Streamable HTTP MCP connection. Distribution still requires a
personal or repository marketplace entry; this repository does not modify an
operator's personal Codex marketplace automatically.

Before installation, replace the reserved
`https://acp.example.invalid/mcp` URL in `.mcp.json` with the deployed HTTPS
control endpoint. Set `ACP_MCP_BEARER_TOKEN` in the Codex host environment to
the same high-entropy secret configured on the control API. Do not store that
secret in this repository.

The MCP client sends `X-ACP-Plugin-Version: 0.1.0`; the control API rejects a
missing or incompatible version before tool dispatch.

The bundled tools create a durable mission, read one exact mission projection,
and list a bounded set of active missions. They expose no credentials and do
not execute external effects.
