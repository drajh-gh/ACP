# 0019 — Exact recorded capability readiness

Status: Accepted additive M3 domain and storage contract. Authenticated read-only
MCP exposure remains follow-up work, not yet implemented.

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
latest assessment per requested key, exactly its referenced evidence and an
explicit identity-match result for every assessment. It
rejects mismatched scope, duplicate keys/IDs, future assessments and extra or
missing references. It does not select history or verify persisted provenance.

Current state and a closed machine reason code are separate from recorded
state/reason. Precedence is:

1. No assessment → `unknown` / `not_assessed`.
2. Recorded `unknown` → `unknown` / `recorded_unknown`, even after expiry.
3. Recorded `revoked` → `revoked` / `recorded_revocation`, even after expiry.
4. Any other assessment at or past `validUntil` → `stale` / `assessment_expired`.
5. An unexpired `available` or `degraded` assessment whose retained evidence
   identity differs → `stale` / `supporting_evidence_identity_changed`.
6. An unexpired `available` or `degraded` assessment with unusable supporting
   evidence → `stale` / `supporting_evidence_unusable`.
7. Otherwise retain the recorded state / `recorded_assessment`.

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
Each entry separately reports `evidenceIdentityMatches` (null when unassessed).
An identity mismatch does not falsify the current hash-presence/freshness labels.
The snapshot schema is now `2.0.0`: the required identity comparison replaces
the domain-only `1.0.0` envelope from the earlier local checkpoint. Version 1
responses are explicitly rejected; legacy identity matches are never fabricated.
The entire serialized matrix must fit 65,536 UTF-8 bytes; truncation is forbidden.
The response parser checks exact requested identity and recomputes every derived
state, rejecting unknown fields and favorable substitutions.

This assesses recorded deadlines and evidence metadata, not actual provider
connectivity or live evidence content. Existing evidence records have no
provenance ID; this contract does not claim evidence-origin provenance.

## Durable writer and snapshot

The internal writer, not MCP/model input, is the temporary trusted evaluator
boundary. Its constructor pins provenance/evaluator identity and requires an
explicitly bounded pool (at most eight connections, ten-second connection/statement
limits and five-second lock limit; fixtures use tighter values). Database checks
establish exact active workflow/provenance/profile identity at first insert and
the default deferred commit. First insert requires
`max(provenance.recordedAt, binding.activeFrom) <= assessedAt <= DB now < validUntil`,
the 24-hour ceiling and usable positive evidence. Its successor must name the
latest exact-key assessment and have a strictly later microsecond instant; this explicit compare-
and-swap also prevents silent clearing of revocation and contradictory concurrent
successors. Provenance establishes identity/profile scope, not general evaluator
eligibility for arbitrary keys; a role-bound evaluator registry remains future work.

Migration 0017 retains append-only `capability_readiness_assessments` and normalized
`capability_readiness_evidence` links, both protected from update/delete/truncate.
The server derives each evidence pin under lock; callers cannot supply it. Its
opaque fingerprint covers project, canonical source type/reference, UTC observation/
retrieval instants, source version, content hash, raw reference and bounded redacted
summary. Freshness/accessibility/sensitivity and retention policy are not identity
fields. Unsupported source identity/range fails closed. Same-ID source/content
replacement produces identity drift, while a restricted/cross-project/missing
current reference denies the whole matrix. Evidence links prevent deletion of
referenced records, but do not freeze their mutable metadata.

Lock order is exact binding `FOR SHARE`, sorted evidence `FOR SHARE`, subject
advisory lock, then latest predecessor row. A SHA-256 subject digest keeps indexes
bounded even for large Unicode keys; every lookup also compares the full tuple.
Digest collisions can deny, never alias. Unique root, predecessor and timestamp
constraints prevent forks even under stale repeatable-read snapshots.

The private producer uses its own physical transaction session, preserves default
constraint deferral and destroys that session on every outcome. A caller executing
arbitrary privileged SQL can force deferred checks early; this is outside that
producer protocol, not an unconditional end-of-transaction guarantee. An adversarial
fixture does so, then changes evidence and retires the binding: the later read
still detects drift and cannot yield positive current readiness. Historical reads
deliberately do not assert that the profile's workflow binding is currently active.

Same-ID historical replay must match all canonical original terms and provenance,
but does not rerun current admission or extend validity. After an attempted insert
fails or COMMIT acknowledgement is uncertain, the failed physical session is closed
before independent exact-ID readback. Only an exact immutable record confirms
historical replay; missing/failed readback is not success. Conflicting terms reject.

The read path uses one bounded read-only MVCC statement and database clock, selects
latest before evidence filtering, preserves microseconds as text, proves exact
profile existence, checks retained/current evidence identity and denies bad or
oversized payloads before returning them. It also works in a read-only transaction.
Downgrade is allowed only while both new tables are empty; populated history and
all predecessor tables remain retained.

A future read-only MCP tool may consume this projection; it must not activate a
profile, assess itself, provision credentials, broaden policy or alter worker/effect
admission. No readiness writer or provider probe is exposed to the counterpart yet.
