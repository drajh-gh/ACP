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

This source package is version `0.3.0` and sends `X-ACP-Plugin-Version: 0.3.0`;
the control API rejects a missing or incompatible version before tool dispatch.
The API's default compatibility list retains `0.1.0` and `0.2.0` and admits `0.3.0`; an
operator's explicit allowlist remains authoritative. Updating this source does
not install the plugin, refresh a cache, or deploy the API.

The bundled tools create a durable mission, read one exact mission projection,
list a bounded set of active missions, and read `get_project_readiness` for an
exact registered project/profile/version and explicit capability/resource keys.
Readiness requires schema migration 0017 and returns a bounded, metadata-only
schema `2.0.0` snapshot; it does not perform live probes, assert active profile
configuration, expose a readiness writer, or grant permission to act.

Two additional read-only tools require migration 0018:
`get_project_profile_proposal` reads one exact retained draft with all 62 fields;
`get_profile_confirmation_request` reads its complete review request from one
current recorded snapshot. Both require exact project and proposal IDs. Historical
drafts remain attributable, not necessarily current. Review requests require the
latest complete draft, usable identity-matched evidence, an unchanged baseline and
a still-vacant target. These observations are not reservations or human approval.
Neither tool writes, discovers, confirms, publishes, activates or grants authority;
invalid or undisclosable results return no partial document. All tools
use the existing trusted bearer-client boundary, not per-project user ACLs.
They expose no credentials and do not execute external effects.
