# 0039 — Original request identity and mission associations

Status: Private storage and recorded-history projection implemented; operator and board integration absent.

The product contract requires one original request to survive work across multiple
missions. A mission rename cannot establish that identity. The independent P2a
slice therefore introduces `req_` IDs, an immutable original request record, and
append-only mission associations. It deliberately does not select the proposed
final-outcome taxonomy, closure criteria or recurrence policy. David's prototype
usability acceptance remains separate.

## Retained meaning, not authority

A registration retains the exact request ID, project, source intake ID, title and
summary. It requires an intake already assigned to that same project; it cannot
classify or reassign unassigned intake. Multiple explicitly distinct requests may
originate from one intake. Equal wording never silently merges request identities.
The source intake remains separate; later scope interpretation must not overwrite
the original statement.

A separate record associates one request with an existing same-project mission
and an exact explanatory reason. A request may link multiple missions, and a
mission may serve multiple requests. Associations do not create missions, start
workflows, approve scope, grant effects, resolve attention or evaluate closure.
There is no removal, correction, automatic linking or semantic deduplication API.
Future correction behavior needs its own retained-history contract.

## Exact private recording boundary

The domain parsers accept only complete bounded plain JSON with typed IDs and
canonical, unmodified wording. They reject unknown authority or provenance fields,
accessors and unsafe object behavior. The private `PostgresRequestStore` captures
producer provenance at construction, requires an explicitly bounded pool, validates
the complete exact database receipt before COMMIT and discards its physical
session. The producer ID is not an operator-authentication token.

Migration 0024 enforces same-project source and mission references through composite
foreign keys, and protects both new histories against UPDATE, DELETE and TRUNCATE.
Insert triggers validate direct SQL too, require a currently active same-project
workflow-binding producer, and generate recording timestamps on the server. Caller
timestamps are rejected. Immutable runtime provenance must have a finite, supported,
non-future recording time. Recording permission never transfers to the linked work.

Request-key transaction locks serialize registration and associations. Repeating
the same request ID, or request/mission pair, succeeds only for identical terms
and the original producer. Changed terms or producer fail; no aliases or revisions
are silently created. Historical exact replay retains its original timestamp
after the producer's binding retires and grants no fresh recording authority.
A lost COMMIT remains uncertain: no automatic retry or readback runs. Explicit
exact replay can recover an already committed receipt without duplicating history.

The migration runner owns the transaction. Empty downgrade/re-upgrade is supported;
a populated downgrade refuses to erase either history. Existing intake and mission
records are not backfilled into invented requests. This private schema is not a
security boundary against a database owner who can alter or disable its guards.

## Read-only recorded history

`getRequestHistory` takes only an exact project/request pair and reads the original
statement plus its recorded mission associations in one PostgreSQL statement.
Missing or foreign scope returns no record. A genuinely unlinked request returns
an empty association list, not a claim that nothing remains to do. The response
marks coverage as `recorded_associations_only`, freshness as `not_assessed` and
authority as `not_granted`. It exposes no producer/runtime provenance, source
envelope, mission lifecycle state, approval or readiness conclusion.

The fixed bounds are 100 associations and 65,536 serialized bytes. SQL retrieves
one extra association to detect overflow, then denies an overfull or oversized
history without returning a prefix, invented cursor or smaller replacement. The
domain boundary validates the entire immutable result, exact identity, canonical
mission-ID order, unique associations and microsecond chronology. SQL uses one
MVCC snapshot, so a concurrent association is seen either in that statement or a
subsequent read, never mixed across multiple queries. No locks or writer procedures
run in the production read. The caller owns bounded connection and SQL settings.

This is historical reporting: retirement of a recording producer neither hides
the original history nor refreshes its timestamps or grants authority. The read
works with SELECT on only the two request tables and no access to runtime
provenance. It remains a private persistence function, not an authenticated API.

## Qualification and remaining boundary

Eight domain tests and eight storage unit tests cover immutable terms, identity
separation, unsafe input, exact provenance, receipt substitution, session errors and
commit uncertainty. Focused real PostgreSQL phases are available through
`scripts/check-postgres.ps1 -RequestIdentity core`, `races` and `upgrade`; run them
sequentially. Each has the existing 90-second owned harness limit and 30-second
Node phase, and destroys only its owned disposable database container.

The candidate passes all 14 real PostgreSQL groups (7 core, 4 races, 3 upgrade),
including direct fresh-association denial after producer retirement. Full strict
TypeScript, all 802 local tests and 15 unchanged-prototype browser groups pass.
Independent read-only source assurance passes. Its initial non-blocking coverage
observation prompted the explicit retirement regression and was closed on delta review.
The original domain and store seams were exercised RED before their implementation.

The subsequent private history projection adds seven domain and five storage unit
cases, with four failing RED cases at each new seam before implementation. Six
actual PostgreSQL groups in `-RequestIdentity history` prove exact/missing/foreign
scope, SELECT-only least-privilege access, concurrent MVCC history, both whole-result
overflow guards, retained historical reads after producer retirement and unchanged
execution/control records. The test-only advisory lock used to expose MVCC timing
does not exist in the production query.
This history candidate passes independent read-only source assurance, strict
TypeScript, all 814 local tests, secret scanning and whitespace checks. No
additional browser behavior changed; the prior 15-group prototype check remains
applicable to its unchanged source hashes.

No authenticated request endpoint, browser binding, live intake,
proposal decision, obligation, communication plan or closure evaluator is part of
this checkpoint. The synthetic Operations prototype remains in-memory and cannot
persist these records. Further selected work must preserve both that distinction
and the original request while adding exact revision-bound review semantics.
