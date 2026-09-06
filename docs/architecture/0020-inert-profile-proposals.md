# 0020 — Inert whole-profile proposals and exact review requests

Status: Accepted M3 domain foundation. [ADR0021](0021-retained-profile-proposals.md)
adds a private proposal ledger and current read snapshots. Filesystem/provider acquisition,
operator confirmation receipts, publication and activation remain unimplemented.

## Separate proposal and runtime boundaries

Specification §13.1–13.4 requires whole-profile discovery, visible missing facts,
operator confirmation and no expansion of global authority. Existing
`project_profiles.profile` is an immutable generic JSON document consumed by
runtime code; it is not a safe place to publish unconfirmed discovery output.
The new `ProjectProfileProposal` is a separate inert review envelope. Its candidate
profile tuple is an intended destination, not a registered or active profile.

The pure builder takes selected, already-redacted discovery results and fills
every unaddressed required field with an explicit missing reason and question.
It neither searches files/providers nor authenticates sources. A future discovery
adapter must preserve document contents as data, not instructions or permissions.
It must not turn repository presence into assumed branch protection, ownership,
deployment authority or secret availability.

## Complete checklist, not a compiled profile

### Attributed discovery reduction

`reduceProfileDiscoveryObservations` accepts only already-selected, redacted
`{ fieldId, value, evidenceIds }` source reports. An exact field and at least one
evidence ID attribute each value; this is not proof of source authority, freshness,
coverage or truth. The reducer performs no I/O or instruction execution.

It returns every checklist field in catalog order. Absence means no attributed
observation was supplied, with a fixed unanswered question; it never invents an
empty collection or non-applicability. An explicit empty collection with evidence
remains an observed value. Equal canonical JSON values merge their sorted unique
evidence IDs. Two to five distinct values remain unresolved alternatives, ordered
by canonical value digest. Caller order, repeated observations and object-key
spelling order cannot select a winner. Array order and value case remain semantic.
No source ranking or “most recent wins” rule is inferred.

Input is capped at 310 dense observations and 1,048,576 UTF-8 JSON bytes. Individual
facts retain the existing depth/node/value/byte limits. More than five alternatives
or 20 merged evidence IDs for one value rejects the whole reduction, never truncates.
The completed field map then passes the same credential/tracker semantics, total
field bytes and 1,240 distinct-evidence ceiling as direct proposal assembly.
Only `observed`, `missing` and `conflicted` are produced; explicit proposed values
and proposed non-applicability remain separate correction inputs.

The private store's `recordDiscovery` validates exact candidate/predecessor scope,
reduces before I/O and delegates to the existing `record` protocol. Replay identity
is the normalized complete field map plus configured producer and exact candidate
metadata, not a raw observation sequence. Reordering/repeating equivalent reports
does not create another fact or observation-run audit record. Changed reduced
content or evidence requires a new exact successor. Existing evidence fingerprints,
private transaction disposal, uncertain-commit recovery and public disclosure
checks remain authoritative. No new table, migration, public writer or provider
inventory is introduced, and this is not the complete §13.1 onboarding flow.

### Static manifest extraction

The worker's `discoverNpmPackageManifest` is a concrete syntax adapter for supplied
package-JSON bytes. It checks a supplied exact content hash before fatal UTF-8
decoding, rejects duplicate decoded JSON keys and extracts only conventional
test/lint/build script declarations into existing attributed observations. Names
and command fingerprints are retained, including matching pre/post fingerprints;
command bodies are undisclosed and never executed. Names suggest configuration
categories only, not verified purpose, successful checks, required gates or safety.

Absent relevant declarations leave the reducer's fields unanswered. Unknown
manifest properties are ignored, not interpreted as project identity, registered
repositories, authority or runtime availability. Parsing and extracted facts have
separate explicit bounds, and any failure returns no partial observation set.
See the [worker contract](../../apps/worker/README.md#static-npm-manifest-discovery)
for the exact limits and official syntax references.

This adapter proves its copied bytes match the caller-supplied hash, not that the
evidence ID currently names those bytes in PostgreSQL or on disk. The fixture's
explicit acquisition and evidence registration demonstrate correct composition,
not independent production source identity or a race-free acquisition protocol.
The generic writer still trusts source attribution and does not compare the
adapter's top-level content hash; current database evidence fingerprints and
disclosure checks remain separate. The optional
[database-bound coordinator](../../apps/worker/README.md#database-bound-supplied-manifest-discovery)
now reads the current SHA-256 and fingerprint together and connects matching
supplied bytes to the locked private pin precondition. This establishes that
invocation's byte/database relationship, not filesystem/provider acquisition or
a durable independently replayable cleartext content-hash transcript.

### Field states

The schema `1.0.0` checklist has exactly 62 independently answerable fields in
the 15 specification areas. Field IDs are case-sensitive dotted identifiers.

| Section | Required fields |
|---|---|
| identity | project, client, stakeholders, environments |
| repositories | inventory, defaultBranches, developmentBranches, protections, owners |
| tracker | adapterAndInstance, nativeStates, semanticMappings, itemTypes, transitionPolicy |
| verification | tests, linting, builds, ci, reviewRules, requiredGates |
| deployment | paths, stagingAvailability, productionAuthority, verification, rollback |
| context | product, business, scopeBoundaries, designDirection, personas, acceptanceMethods |
| communications | channels, externalRecipients, internalRecipients, messageApprovalRules |
| knowledge | sources, sourceAuthorityRules, freshnessExpectations, memoryDestinations |
| data | sensitivity, restrictedSources, redaction, retention |
| orchestration | workflowBindings, schedules, reconciliationSources, cursorStrategies, completionContracts |
| attention | quietHours, escalationRules, failureThresholds, unattendedLimits |
| execution | hostRequirements, browserRequirements, concurrencyLimits |
| credentials | references, readIdentities, writeIdentities |
| revalidation | mutableTargets, methods |
| compatibility | runtimeRequirements, adapterRequirements |

Each field is one of:

- `observed`: a value and at least one evidence reference; an attribution claim,
  not independent verification of truth or freshness.
- `proposed`: a value, rationale and optional evidence references; not settled policy.
- `missing`: a reason and exact question, with no silently invented value.
- `conflicted`: two to five distinct attributed values and an unresolved question;
  no automatic winner selection.
- `not_applicable`: explicitly proposed non-applicability with rationale and optional
  evidence, not the default for unsuccessful discovery.

An explicit observed empty collection means an attributed “none”; it is not an
unknown inventory. A stored envelope must contain every field exactly once and
must not contain extra fields. Unlike discovery assembly, its parser never fills
silently omitted fields. State is recomputed: any conflict yields `conflicted`,
otherwise any missing field yields `needs_input`, otherwise it is `reviewable`.

**Reviewable means checklist coverage only.** Most field values remain bounded
inert JSON, not typed runtime configuration. This contract does not validate every
composite subfield, repository/environment/channel cross-reference, schedule zone,
completion rule, compatibility requirement or policy limit. It does not prove the
proposed facts are true or sufficiently complete for activation. Those semantics
belong to an explicit future compiler and authority-delta evaluator. Even all
proposed non-applicability declarations remain subject to human review.

Two structural boundaries are enforced now. Credential catalog entries contain
only exact `cdr_` references, versions and purposes; read and write identity records
remain separate and must match a supplied resolved catalog. Conflicting duplicate
catalog identities reject. If the catalog itself is missing/conflicted, partial
identity discovery remains visible, but cannot produce a confirmation request.
Tracker mappings retain exact adapter/version/instance/item-type/native-state
identity and one existing semantic category or explicit null. Duplicate mapping
identities reject; case-distinct native states remain distinct and no universal
transition workflow is inferred.

Reference-shaped credential validation is **not secret detection**. Free-text
purpose, identity references, questions, rationales, producer strings and generic
facts can contain arbitrary caller text. Non-secret/redacted input remains the
trusted producer's responsibility; these validators cannot prove that guarantee.

`knowledge.sourceAuthorityRules` is the sole proposal copy. A future compiler must
deliberately map it to the exact root `sourceAuthorityRules` required by legacy
context assembly. The proposal envelope must never be inserted directly as an
active profile. Existing node-context worker limits and separate workflow bindings
remain unchanged; proposed values are not applied limits or new `wfb_` identities.

## Exact identity and bounded representation

Every proposal has its own `pfp_` ID, exact project/candidate profile tuple, optional
same-profile prior version plus PostgreSQL storage digest, optional predecessor proposal ID,
configured producer component/version/artifact digest, and proposed-at timestamp.
The producer identity avoids requiring profile-bound runtime provenance before a
first profile exists. It is neither an operator principal nor a verified source
attestation. Storage binds it to its configured trusted producer, rather than
accepting it as model-selected authority. `baseProfile.profileDigest` is explicitly
`acp.jsonb_sha256` of the exact retained baseline JSONB, not the JavaScript canonical
proposal digest. An independently published version does not establish a current
profile head; the database has no authoritative head pointer.

The digest covers all metadata, every field/value/gap, evidence pins, derived state
and explicit `not_evaluated` / `not_authorized` authority markers. Correcting a
field, changing a target/base/predecessor/producer, or changing a retained evidence
fingerprint changes that digest. Evidence IDs are unique and sorted; every
reference has exactly one same-project pin and extra pins are rejected. Domain
pin parsing does not establish that a fingerprint came from real stored evidence.

The envelope is bounded to 262,144 UTF-8 bytes. Individual JSON values are bounded
to 4,096 bytes, eight nested levels, 2,000 nodes, 100 keys/items per container,
canonical text and finite safe-range numbers. Sparse/decorated arrays reject;
negative zero normalizes to zero so JSON/database round-trips preserve returned
value identity. Unsafe prototype keys, unsupported objects, malformed Unicode,
and silent truncation are rejected. Evidence references are capped at 20 per
attribution and 1,240 unique pins per proposal.

Exact finite Gregorian timestamps share one canonical UTC-microsecond parser.
Existing readiness exports remain aliases; its valid timestamp behavior and
schema remain unchanged. Readiness also rejects sparse collections and coerced
sensitivity labels rather than letting malformed in-memory data weaken evidence
requirements.

## Confirmation request, not operator confirmation

`buildProfileConfirmationRequest` requires a complete reviewable proposal and a
trusted current storage snapshot. That caller must establish the current proposal,
vacant candidate version, unchanged exact baseline and current evidence together.
The pure function cannot authenticate those booleans or fingerprints.

The request is denied as a whole if the proposal is superseded, incomplete or
conflicted; the candidate exists; the baseline differs; the clock predates the
proposal; or any evidence is missing, duplicated, cross-project, restricted,
identity-changed, unhashed, noncurrent, inaccessible or temporally invalid. There
is no fallback to an earlier proposal or identifying partial error.

A successful request contains the **complete proposal**, current evidence
metadata, exact `asOf`, proposal digest, evidence-snapshot digest and a digest over
the full request body. Current admitted sensitivity participates in those hashes;
changing public/confidential classification cannot reuse the same request digest.
Its kind is `confirmation_request_only`, authority assessment is `not_evaluated`
and activation is `not_authorized`. There is no operator ID or confirmed-at field.

This is not a signed approval, a freshness lease, an activation token, or proof of
the authenticated operator's intent. Any future acceptance endpoint must bind an
authenticated stable human principal to that exact visible candidate and recheck
current state. The existing shared bearer and effect-specific approval envelopes
must not be relabeled as profile confirmation. Confirmation, global-policy
narrowing, publication and workflow activation remain separate later stages.
