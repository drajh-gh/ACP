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
- `ACP_ALLOWED_PLUGIN_VERSIONS` defaults to `0.1.0,0.2.0,0.3.0` and admits the exact
  `X-ACP-Plugin-Version` sent by the plugin. An explicit list replaces the default;
  it is never broadened automatically.
- `ACP_REQUIRE_FORWARDED_HTTPS` defaults to true in production.
- `ACP_CONTROL_TRUSTED_PROXIES` is a comma-separated exact remote-address
  allowlist. Only those peers may assert a single `X-Forwarded-Proto: https`.
  A production non-loopback bind fails startup when no trusted proxy is set.

Start locally with `npm run start:control-api` after the schema, binding, and
runtime-provenance records exist. The repository deliberately contains no
bearer token or deployed endpoint.

## Recorded readiness

`get_project_readiness` accepts one exact registered project/profile/version and
1–50 explicit unique capability/resource/version keys. Migration 0017 must be
applied. The schema `2.0.0` result retains independent recorded/current states,
database `asOf`, deadlines and bounded evidence metadata. The complete matrix is
limited to 65,536 UTF-8 bytes; unavailable, undisclosable, malformed, mismatched or
oversized snapshots return one generic tool error and no partial data.

This uses the existing global trusted bearer-client boundary, not per-project
user authorization. Exact scope validation prevents reference substitution; it
does not add a project ACL. The read-only tool neither probes providers nor writes
assessments, activates profiles, provisions credentials or changes execution
authority. No current binding assertion or aggregate readiness flag is implied.

The local integration gate `pwsh -File scripts/check-postgres.ps1 -Readiness http`
uses an owned disposable database and loopback HTTP fixture. It does not deploy
this service or install the counterpart plugin.

## Inert profile review

Control API and source counterpart version `0.3.0` add two read-only tools:
`get_project_profile_proposal` and `get_profile_confirmation_request`. Each accepts
only exact `projectId` and `proposalId` values, calls one bounded storage snapshot
and returns the complete domain-validated document. Migration 0018 is required.
No latest selector, discovery operation or mutation is exposed.

Historical proposals retain all 62 observed/proposed/missing/conflicted or proposed
not-applicable fields and their attributed evidence fingerprints. Current disclosure
is checked, but historical facts may have changed. A review request requires the
exact latest reviewable draft, vacant candidate, unchanged baseline and usable
identity-matched evidence at its recorded `asOf`. The complete nested proposal,
safe evidence metadata and digests are validated before reaching the MCP wire.
Canonical proposal/request ceilings are 262,144/524,288 UTF-8 bytes. Any unavailable,
malformed, mismatched, oversized or undisclosable result produces the same whole-
document error without structured content or private diagnostics.

The shared trusted bearer is not a stable human principal or per-project ACL.
Neither document is an operator confirmation receipt, approval, freshness
reservation, published profile, activation or permission grant. A future write
flow needs its own authenticated-human and current-facts contract.

`pwsh -File scripts/check-postgres.ps1 -ProfileProposals http` verifies the actual
loopback MCP route with a SELECT-only role and disposable PostgreSQL data. It
does not install the source plugin, deploy a service or contact a live model.
