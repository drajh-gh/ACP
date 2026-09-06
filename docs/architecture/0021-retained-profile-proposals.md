# 0021 — Retained inert profile-proposal history

Status: Accepted, locally verified M3 ledger. No discovery adapter, operator receipt, publication,
activation or public proposal writer is introduced.

## Boundary

Migration 0018 retains the inert review contract in [ADR0020](0020-inert-profile-proposals.md)
separately from active `project_profiles`. A `pfp_` record names one existing
project and prospective profile ID/version, an optional exact immutable baseline,
an optional predecessor, and all 62 checklist fields. Bootstrap requires no
profile-bound runtime provenance. The configured producer identity is not a human
principal, source attestation or authority grant. Redaction remains its responsibility.

The private store rejects caller-owned producer, timestamps, pins, digest, state
and authority fields before database I/O. Partial discovery is normalized to the
full checklist. An actual pool must explicitly cap connections at eight,
connection/statement deadlines at ten seconds and lock waits at five seconds.
Each write uses a private transaction and physically discards its session.
Checked-out socket errors are observed across each query and no cleanup query is
sent through a known failed connection. An uncertain commit is not reported as
absence: only a fresh exact-ID read after physical discard can confirm retention.

Historical retries compare all original normalized caller terms plus the pinned
producer. They preserve the original server timestamp and evidence fingerprints,
even after a successor, candidate publication or current evidence restriction.
This is a **private writer retry**, not the public disclosure path. Changed terms
or producer identity reject. Failed independent readback preserves uncertainty;
a later explicit retry may recover the retained result.

## Optional exact evidence preconditions

The private `recordPinnedDiscovery` entrypoint accepts attributed observations and
an exact complete set of `expectedEvidencePins`. Each pin contains only evidence
ID, project ID and the opaque PostgreSQL identity fingerprint. The domain helper
rejects malformed, duplicate, missing, extra or wrong-project pins before I/O and
canonicalizes their order. Expectations are compare preconditions, not caller-owned
stored pins; the server still derives the retained evidence set.

For a new proposal ID, this entrypoint locks project, optional baseline and sorted
evidence in the same order as the ledger trigger. While holding those locks it
requires every expected fingerprint to match and every source to be current,
available, hashed, public/project-confidential and temporally valid at the database
clock. Freshness, accessibility and sensitivity are checked separately because
they are not part of the identity fingerprint. The fully parsed INSERT result's
server-derived pins must match before COMMIT. Competing evidence updates cannot
pass the held row locks before that transaction finishes.

Historical retries compare the original retained pins and all normalized terms
before COMMIT, without current admission or re-pinning. The same pin comparison
applies to fresh exact-ID readback after an uncertain commit and physical discard.
A changed current fingerprint cannot replace the original expected pin under the
same proposal ID. Successful replay is not evidence renewal or a currentness lease.

This is an opt-in private producer protocol, not a new direct-SQL invariant:
`record` and `recordDiscovery` intentionally retain their existing looser draft
admission. No public writer, migration, caller migration or automatic coordinator
is introduced. An opaque fingerprint does not prove source bytes, filesystem path,
content-hash provenance or authority. In particular, this method does not bind the
manifest adapter's supplied bytes/hash to a database source; secure acquisition and
that separate durable binding remain future work. The optional
[supplied-manifest coordinator](../../apps/worker/README.md#database-bound-supplied-manifest-discovery)
adds an invocation-local byte/database relationship: it obtains a current private
descriptor, checks supplied bytes against its SHA-256, and uses this exact pin
precondition. It neither changes the historical ledger nor establishes acquisition
provenance. Its private descriptor read is not added to the public persistence or
MCP interface.

## Immutable chains and evidence

Each exact project/candidate tuple has one root and an unbranching successor chain.
Admission locks the project/baseline and evidence in stable order, then the target
advisory namespace and latest row. A correction must name the exact latest
predecessor and have a strictly later database timestamp. Unique root, predecessor
and scope/time constraints also prevent stale repeatable-read snapshots from
forking history. UPDATE, DELETE and TRUNCATE are rejected on both parent and pins.

The server derives the evidence union, same-project fingerprints, timestamp,
state, explicit denied authority markers, body and storage checksum. Normalized
child pins must exactly match the immutable header. Missing, restricted,
off-project, malformed or future evidence rejects. Stale, inaccessible or unhashed
evidence can support an attributed draft, but never a current confirmation request.
The default deferred constraint rechecks pinned identity and disclosure at commit.
Privileged SQL can force that check early; this is not an unconditional
end-of-transaction guarantee outside the private producer protocol. Read-side
checks still detect later drift or restriction.

SQL validates complete closed field envelopes, bounded references and metadata;
the domain parser additionally validates bounded fact JSON and credential/tracker
semantics. The private writer reparses its full returned body before COMMIT.
Privileged direct SQL is not a supported producer API and is not a source of
operator authority. Public reads reparse rather than trusting a stored favorable state.

## Distinct identity algorithms

`storage_digest` is `acp.jsonb_sha256(body)`, a PostgreSQL serialization checksum.
It is **not** the JavaScript `canonicalJsonDigest` used for the visible proposal
and confirmation request. JSONB key order and numeric formatting need not match
JavaScript canonicalization. No legacy checksum function is changed.

`baseProfile.profileDigest` is also explicitly the PostgreSQL checksum of the
exact retained baseline. It is computed and compared inside the database so
legacy integers/decimals cannot be rounded by an ordinary JavaScript JSON parser.
Baseline existence/content does not mean “latest” or “active”: no current-profile
head exists, and none is inferred from version ordering, publication time or bindings.

Proposal bodies cross the driver boundary as raw `body::text`, including INSERT
and historical replay. Read queries return body text as a separate result column,
not a doubly escaped string inside the metadata JSON. A bounded lexer validates every numeric token outside
quoted strings before JSON parsing. Exact decimal coefficient/exponent comparison
against its JavaScript serialization rejects rounding, overflow and underflow;
scale/exponent spelling variants remain equivalent. Numeric tokens are capped at
1,024 characters and exponent digits at six; no powers of ten are materialized.
Only then is the visible proposal digest reconstructed and checked with the domain parser.
The canonical proposal ceiling remains 262,144 UTF-8 bytes. SQL body serialization
and the internal metadata snapshot each have a separate 524,288-byte ceiling; these
are distinct bounds, not assertions of equivalent serialization. Oversize results
fail as a whole without truncation.

## Current reads, not reservations

Exact historical reads and confirmation-request reads each use one bounded MVCC
statement. Selection never falls back to another proposal or project. Current
evidence metadata is checked before the body is returned. Restricted, missing,
off-project, malformed or future references deny the whole payload with constant
errors; source references, raw content and content-hash values are never exposed.
A historical proposal can remain visible after ordinary source identity or
freshness deterioration, but a confirmation request cannot.

The request additionally requires a reviewable latest proposal, vacant candidate
version, matching exact baseline, current accessible hashed evidence and unchanged
fingerprints. Candidate occupancy is checked against the global profile ID/version
primary key, not only the proposal's project. Absence and latestness are snapshot
observations, **not reservations** against concurrent legacy publication or later
corrections. The request digest covers the full visible proposal and safe current
evidence metadata at `asOf`.

No request is an accepted confirmation, authorization lease or activation token.
A future endpoint must authenticate a stable human principal, bind the exact visible
candidate and recheck current facts. The existing shared bearer and effect approval
envelopes do not supply that missing human-confirmation contract.

## Read-only counterpart interface

Control API and repository-source counterpart `0.3.0` expose exact
`get_project_profile_proposal` and `get_profile_confirmation_request` reads.
Each accepts only `projectId` and `proposalId`, delegates directly to one storage
snapshot and reparses the complete response before MCP output validation. The
wire request parser rebuilds its complete canonical document, checks the caller's
expected scope and binds all nested data and digests. This proves self-consistency,
not current database facts or human intent; current facts still come from storage.

Strict output schemas retain all 62 field envelopes, complete nested proposals,
safe evidence and inert authority literals. Recursive JSON schemas are descriptive
supersets; the domain parser additionally enforces byte/depth/node/value semantics.
Both tools have read-only, non-destructive, idempotent, closed-world annotations.
All unavailable or rejected results collapse to one constant tool error without
partial structured content or private diagnostics. Invalid selectors reject before
persistence. No proposal writer or operator-confirmation endpoint is registered.

The existing global trusted bearer boundary remains unchanged. It is neither
per-project user authorization nor an authenticated human confirmation identity.
Default client compatibility retains `0.1.0` and `0.2.0` and admits `0.3.0`; an
explicit operator allowlist replaces the defaults in either direction. Updating
source manifests and skills does not install or deploy them.

## Preservation and verification

An empty 0018 downgrade removes only its tables/functions. A populated downgrade
refuses to discard proposal or pin history. Earlier migrations and runtime tables
are left intact. Focused `ProfileProposals` phases run against disposable seeded
PostgreSQL with bounded owned processes; they never call a model or live provider.
The `regression` phase runs existing readiness core and read-only HTTP checks under
0018. The `http` phase exercises both new read tools over loopback with an actual
SELECT-only database role, including full nonempty evidence, large escaped JSON,
identity/freshness/disclosure drift, supersession, target publication and exact-
numeric whole denial. Native worker/provisioner paths are unchanged.
The `pinned` phase checks complete-set admission, stricter current usability,
pre-lock drift, lock exclusion, pre-COMMIT returned-pin mismatch rollback,
historical original-pin replay and lost-COMMIT exact-pin recovery against actual
PostgreSQL. It also proves the older unpinned draft semantics remain available.
