# 0019 — Exact recorded capability readiness

Status: Accepted additive M3 domain contract. Durable assessment storage and
authenticated read-only MCP exposure are follow-up work, not yet implemented.

## Identity and authority

Specification §13.3 requires independent `available`, `degraded`, `unconfigured`,
`blocked`, `stale`, `revoked` and `unknown` states. A missing assessment is not
evidence of missing configuration. An available operation is not a grant, an
active-profile assertion, a global project-ready flag or permission to perform
later effects. The matrix performs no live provider probe.

Every query names one exact project, profile ID/version and 1–50 unique triples
of capability, resource key and resource version. Keys are opaque non-secret
identifiers with exact spelling; no case folding, alias resolution, wildcard
matching or inheritance across profile/resource versions is performed. Query
order determines output order. No project capability inventory or SloSki
configuration is invented. Existing `CapabilityReadiness` remains unchanged;
the richer contract is additive in `packages/domain/src/readiness.ts`.

An assessment retains a distinct `cra_` ID, the full scope, recorded state and
already-redacted reason, assessment/validity instants, up to 20 unique evidence
IDs sorted canonically, evaluator version, provenance ID and explicit nullable
predecessor ID. A row cannot supersede itself. The trusted evaluator supplies
non-secret keys and redacted explanations: text validation is not secret
detection or automatic redaction.

## Exact time and deterministic projection

Time inputs are finite Gregorian ISO timestamps with at most six fractional
digits, normalized to UTC with all six digits retained. Comparison uses integer
microseconds, including before the Unix epoch. Year zero, date rollover,
24:00 and sub-microsecond precision are rejected. Validity must be positive and
at most 24 hours; this protocol ceiling is not a default freshness promise.

The pure resolver receives a trusted snapshot clock, at most one already-selected
latest assessment per requested key, and exactly its referenced evidence. It
rejects mismatched scope, duplicate keys/IDs, future assessments and extra or
missing references. It does not select history or verify persisted provenance.

Current state and a closed machine reason code are separate from recorded
state/reason. Precedence is:

1. No assessment → `unknown` / `not_assessed`.
2. Recorded `unknown` → `unknown` / `recorded_unknown`, even after expiry.
3. Recorded `revoked` → `revoked` / `recorded_revocation`, even after expiry.
4. Any other assessment at or past `validUntil` → `stale` / `assessment_expired`.
5. An unexpired `available` or `degraded` assessment with unusable supporting
   evidence → `stale` / `supporting_evidence_unusable`.
6. Otherwise retain the recorded state / `recorded_assessment`.

There is never fallback to an older favorable row. Expiring a revocation never
lifts it. Existing negative states remain explicit until their own expiry;
evidence usability is not turned into inferred permission.

## Evidence and disclosure

All referenced evidence must exist, match the project and be nonrestricted.
Observation and retrieval instants must satisfy `observedAt <= retrievedAt <= asOf`.
Any invalid, extra, duplicate, missing, restricted or cross-project reference
denies the whole projection with one generic error; no favorable partial matrix
or identifying error is returned. For positive readiness, every supporting item
must additionally have recorded `current` freshness, `available` accessibility
and a nonblank bounded content hash. Null hash, stale/unknown freshness and
nonavailable accessibility cannot yield a positive current state.

Only evidence IDs, observation/retrieval instants, hash-presence boolean and
freshness/accessibility labels are returned. Source references, raw references,
summaries and hash values are not returned. Metadata is sorted by evidence ID.
The entire serialized matrix must fit 65,536 UTF-8 bytes; truncation is forbidden.
The response parser checks exact requested identity and recomputes every derived
state, rejecting unknown fields and favorable substitutions.

This assesses recorded deadlines and evidence metadata, not actual provider
connectivity or live evidence content. Existing evidence records have no
provenance ID; this contract does not claim evidence-origin provenance.

## Required durable follow-up

The future internal writer, not MCP/model input, is the temporary trusted
evaluator boundary. It must establish exact active workflow/provenance/profile
identity at first insert and deferred commit. First insert requires
`provenance.recordedAt <= assessedAt <= DB now < validUntil`, the 24-hour ceiling
and usable positive evidence. Its successor must name the latest exact-key
assessment and have a strictly later microsecond instant; this explicit compare-
and-swap also prevents silent clearing of revocation and contradictory concurrent
successors. Every row and predecessor relationship must be retained immutably.

Same-ID historical replay must match all canonical original terms and provenance,
but must not rerun current admission or extend validity. Reads must select latest
before evidence filtering, use one bounded database snapshot and database time,
preserve microseconds as text, and prove the requested profile exists. A read-only
MCP tool may consume that projection; it must not activate a profile, assess itself,
provision credentials, broaden policy or alter worker/effect admission.
