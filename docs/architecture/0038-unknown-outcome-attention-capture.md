# 0038 — Receipt-bound unknown-outcome attention capture

Status: Private exact-source capture implemented; no automatic scanner or daemon.

Specification §19 includes unknown external outcomes in attention management.
Migration 0023 and the private storage port connect one retained unknown-outcome
effect receipt to one canonical recorded attention item. This is reporting, not
effect execution, reconciliation, resolution, approval or notification.

## Separate and exact history

Attention capture runs separately from external receipt insertion. A failed
attention admission cannot roll back that indispensable receipt. The caller
supplies only exact project and receipt IDs; the private store pins producer
provenance at construction. The database generates the item ID and fixed,
versioned descriptions from retained IDs, never from execution records, external
response bodies or error text. Normal urgency, absent expiry and unevaluated
quiet-hours disposition grant no interruption permission. The effect preview
reference inherits migration 0022's current indirect-evidence disclosure checks.

A receipt-specific transaction lock serializes captures. The first capture
requires the exact project's latest receipt and effect both to be unknown, no
conclusive applied/not-applied reconciliation, and finite supported source times
ordered from provenance through attempt to server observation. Inconclusive
reconciliation remains eligible. A missing, non-unknown, superseded, foreign or
already conclusively reconciled fresh source yields `not_eligible`; that result
is not a claim of overall health, absence of attention or successful execution.
SQL null project/receipt input is rejected before historical replay as well.

Canonical item, self-alias and immutable source link commit together. The link
derives project/effect/mission/time server-side and rechecks exact source
eligibility, fixed body and producer attribution. Existing unrelated history
under the reserved producer key is not adopted. Source update, delete and truncate
are denied; a populated downgrade refuses to erase attribution.

Exact same-project source replay returns original item, timestamp and producer
without a new alias, even after later reconciliation or loss of fresh producer
authority. It neither republishes restricted queue content nor renews authority.
One bounded physical READ COMMITTED session validates the complete receipt before
COMMIT and is discarded afterward. Lost COMMIT produces no automatic retry or
readback; an explicit exact source replay can recover retained attribution.

## Historical, not currently unresolved

The source trigger rechecks visible eligibility before retaining the link.
Reconciliation visible there rejects and rolls back provisional item/alias history.
Reconciliation insertion does not take the capture advisory lock, however: a
reconciliation after the link's source snapshot can commit before attention COMMIT.
That remains valid historical reporting. The body explicitly directs the observer
to subsequent reconciliation; it does not assert that intervention is still needed
now or that an external action may be repeated. No stronger current-state claim is
inferred from a successful capture or from the queue.

## Evidence and limits

Six unit cases passed after six positive cases failed against the unimplemented
capture seam. Fourteen actual PostgreSQL checks run in the sequential
`source-core`, `source-races` and `source-upgrade` AttentionQueue phases. They cover
guard-complete synthetic unknown receipts, exact unchanged effect/receipt/control
rows, source chronology, conclusive/inconclusive/later receipt selection,
restricted evidence failure without lost receipt history, immutable exact replay,
direct SQL attribution, concurrent capture and genuinely lost COMMIT, both
reconciliation timing boundaries and empty/populated downgrade. The null-scope
regression reproduced a SQL replay bypass before its explicit rejection fix.
All effect approval, lease, precondition, fencing and kill-switch guards remain
enabled; synthetic unpause and re-pause are in one transaction and are never
externally visible. No external adapter executes.

This slice does not scan a project, schedule catch-up, emit `attention.created`,
send notifications, evaluate quiet hours, resolve items, execute human decisions,
or enable a production attention manager. Independent read-only source review
passes the capture design; actual database evidence is separate from that review.
