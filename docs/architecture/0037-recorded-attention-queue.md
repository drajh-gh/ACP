# 0037 — Recorded attention queue, separate from decisions and notifications

Status: Domain contract, durable recording/read projection and read-only MCP tool implemented.

Specification §19 defines twelve attention types and decision-ready item fields;
§31.1 names the mission-attention read surface. This local slice advances M5
independently of unfinished M2 execution isolation and real project onboarding.

## Recorded meaning

Items carry a stable `ati_` ID and exact project, zero to fifty mission/evidence
references, the specified type and urgency, decision-ready text, optional
recommendation/alternatives/consequence/expiry/preview references, a producer
deduplication key, allowed response descriptions and quiet-hours disposition.
The last two are recorded text, not executable policy or authority. An item of
type `exact_approval_requested` reports that request; it is not itself an exact
approval envelope or proof that a current approval card can be constructed.

`effectPreviewIds` use existing `eff_` IDs because immutable effect proposals
already carry previews; no independent preview entity is invented. Storage must
bind each reference to the same project and a mission included in the item.
No preview payload or current approval coverage is included in this queue DTO.
Project-wide items may have no mission or evidence, explicitly preserving the
absence of recorded references rather than fabricating support.

## Exact identity and bounded pages

Item parsing detaches descriptor-only JSON, rejects unknown/unsafe fields, bounds
the entire encoded item to 32 KiB, validates canonical text and IDs, canonicalizes
reference sets and UTC microsecond expiry, and freezes the result. Response and
alternative order, and absent versus present-empty optional fields, are meaningful.
The semantic digest excludes only `itemId`. This is producer-key exact semantic
deduplication, not a classifier that claims differently worded requests equivalent.

Migration 0022 implements one canonical row per project/key plus an
immutable alias for every accepted supplied item ID. Exact repeated semantics
return the original item; an alias or key cannot later name different content.
Fresh history requires a project-bound private producer; exact historical replay
does not manufacture fresh authority. No automatic uncertain-COMMIT retry or
replacement item is permitted. PostgreSQL storage checksums must not be confused
with the JavaScript semantic digest algorithm. New canonical rows and new aliases
require finite, supported-year producer timestamps no later than server admission,
an active exact project binding, and disclosable references. The existing composite
provenance/binding foreign key pins workflow, profile, policy and completion pairs.
The original canonical item and every accepted request ID remain immutable. An
empty migration rollback works; a populated rollback refuses to remove history.

The private TypeScript producer owns provenance at construction and runs one
bounded, physically isolated READ COMMITTED transaction. Complete receipt parsing
precedes COMMIT; fresh provenance and canonical self-alias attribution must agree.
An uncertain COMMIT discards the connection without retry or automatic readback.
An explicit exact replay can recover historical attribution even when the original
producer or evidence could no longer admit fresh history. This does not publicly
disclose a now-restricted item or renew any authority.

Queue queries require an exact project and optionally a mission and after-item
cursor, with default 20 and maximum 50 rows. Ordering is critical/high/normal/low,
oldest recorded UTC microsecond first, then stable ID. A continuation identifies
the exact final returned item; storage validates the full cursor tuple in the
same scope. Invalid or foreign cursors are errors, not empty queues. Pages have a
64-KiB whole-response bound; overflow or malformed data denies the whole page.
Pagination is bounded recorded history, not a cross-page atomic live snapshot.

Expiry is recomputed at the returned observation time, with distinct not-expiring,
not-expired and expired values. Expired items remain recorded; nothing silently
resolves them. Coverage is `recorded_items_only`, freshness `not_assessed`, and
authority `not_granted`. An empty page proves no readiness, completion or absence
of unrecorded problems. One MVCC SELECT enforces current disclosure for all selected
mission/evidence/effect references, including the cursor anchor and lookahead row,
before a page can be returned. Restricted, missing, malformed or cross-project
evidence denies the whole page; this includes evidence reachable only through an
effect preview. Stale or inaccessible evidence is retained as recorded context,
not promoted to fresh or usable evidence. Reads need SELECT only, take no row locks
and mutate no state. Separate pages need not share a database snapshot.

## Authenticated counterpart read

`get_mission_attention` exposes the exact project queue with optional mission and
canonical cursor through the existing authenticated, Origin-checked control API.
It is the underscore-named MCP implementation of §31.1's `missions.get_attention`.
It returns `{ attention }`, reparses the entire detached domain queue, and bounds
the complete structured envelope to 64 KiB. Any unknown scope, invalid cursor,
private persistence error, malformed result or overflow yields one generic error
without structured content or a smaller substitute page. Source metadata, preview
bodies and private producer receipts are not included.

The advertised API and repository plugin advance to `0.4.0`; default admission
retains `0.1.0`–`0.3.0`. Explicit operator compatibility lists remain authoritative.
The seventh tool is allowlisted in the source plugin and its counterpart skill
preserves recorded-only meaning. This is the shared trusted bearer-client boundary,
not console OAuth or a per-user/project ACL. No marketplace entry, installation,
cache refresh, deployment or configured live credential is changed.

## Non-goals and evidence

No acknowledgement, resolution, recurrence, approval decision, notification,
quiet-hours evaluation, digest grouping, interruption, Slack message, human
identity grant, automatic producer or effect execution is enabled by this contract.
Supplied descriptions must already be appropriately minimized/redacted by the
trusted producer; structural parsing cannot prove arbitrary prose secret-free.

Thirteen local cases cover all twelve types, exact scope, detached unsafe-object
rejection, whole-item bounds, optional absence, reference normalization, semantic
identity, microsecond expiry and ordering, stable-ID ties and exact continuation.
Eight positive tests failed against the unimplemented seam before implementation.
Independent read-only review found no critical defect and identified the optional-
presence and tie-order evidence gaps subsequently covered by explicit tests.

Nine storage unit cases and 23 actual PostgreSQL checks cover canonical/alias
concurrency, lost actual COMMIT without automatic recovery, producer chronology,
same-project and indirect evidence disclosure, restricted lookahead, whole-page
overflow, immutable references, SELECT-only access, concurrent MVCC evidence
changes and empty/populated downgrade behavior. Meaningful regressions first
reproduced future producer admission, fresh receipt attribution substitution and
lookahead-only disclosure before their fixes. Independent read-only review passes
the corrected SQL and TypeScript boundary. These tests do not prove a deployment,
trusted prose redaction, a per-user/project ACL or an executed human decision.

Eleven HTTP cases cover all types and four compatible plugin versions, exact
query/response identity, action-field rejection, private-error containment,
unsafe-object hooks, and a domain-valid queue whose wrapper exceeds 64 KiB.
The initial positive route cases failed because no attention tool was registered;
the new-version requests were also refused before implementation. Six additional
actual PostgreSQL/HTTP checks verify SELECT-only execution, one query/no transaction
connect, complete pagination, absent/foreign scope errors, restricted lookahead,
source/provenance privacy and zero SQL for invalid or unauthenticated calls.
Independent read-only review found no decisive MCP defect. All 768 local tests,
TypeScript, secret scanning and whitespace checks pass.
