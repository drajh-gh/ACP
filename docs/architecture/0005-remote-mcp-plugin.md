# ADR 0005: Expose ACP through an authenticated remote MCP plugin

- Status: Accepted
- Date: 2026-09-04
- Specification: 1.0.0, sections 1, 7, 18, and 31

## Context

Codex must remain the primary conversational interface while ACP runs on a host
that is independent of the operator's laptop. The integration needs stable,
narrow operations for missions, projects, approvals, evidence, and status.

## Decision

Package a Codex plugin containing ACP workflow skills and a connection to the
hosted authenticated MCP server. The MCP surface is a projection of the Control
API, not a second orchestration engine. Mutation tools bind to opaque IDs,
describe their effect clearly, and return concise structured results with
references to larger artifacts.

The Codex SDK worker path and the plugin MCP path are distinct. ACP will not use
the deprecated `codex mcp-server` command as its hosted server. Codex App Server
or SDK subprocess interfaces stay on loopback or a private internal interface.

## Consequences

- Plugin/server protocol compatibility requires an explicit handshake.
- Authentication, token storage, revocation, and audit belong to the hosted API.
- Tool metadata and error contracts are part of the versioned public surface.

## References

- [Build Codex plugins](https://developers.openai.com/plugins/build/plugins)
- [Connect an MCP server](https://developers.openai.com/plugins/build/mcp-server)
- [MCP server authentication](https://learn.chatgpt.com/docs/extend/mcp)
