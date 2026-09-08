# ACP — Product-led delivery slice

Status: Isolated Operations prototype built for review; request identity and authenticated counterpart history read implemented.
Baseline: `85a137818e964065a1783fc825053cecfaadb10f` (published to GitHub `main`).
Decision: David approved bringing the product/UI specifications into the next
delivery phase and selected ACP as the current name on 2026-09-06.

## Source contract

Current intended-behavior versions (2026-09-08): technical specification 1.0.2,
product specification 0.5, and UX/UI specification 0.3. Read the current files,
including approved working-tree amendments, before selecting the next increment;
these version pins do not establish implemented behavior or approve open policies.

- [SPECIFICATION.md](../../SPECIFICATION.md) remains the technical execution and
  safety contract. No worker isolation, effect or evidence guard is relaxed.
- [ACP product specification](../ACP_PRODUCT_SPECIFICATION.md) defines the
  request/passenger, outcome, journey, obligation and communication experience.
  Its explicitly proposed policies remain proposed, not implicitly approved.
- [Airport UX/UI specification](../AIRPORT_UX_UI_SPECIFICATION.md) supplies the
  Operations board and review-flow direction. The current visible name is ACP.
- Code and exact test evidence establish implemented behavior. Neither a document,
  mock interface nor operator click establishes a real execution receipt.

This is one ACP product with an execution foundation and an operator experience,
not a second orchestrator or a replacement tracker. Existing stable operational
IDs and history remain intact. Request identity must span multiple missions;
renaming a mission to a passenger would not implement that requirement.

## Baseline versus the next product behavior

| User capability | Existing foundation | Product work still required |
|---|---|---|
| Find the request needing a decision | Recorded mission, attention, readiness and exact request-history MCP reads; immutable request/mission associations | Cross-request board projection and authenticated board integration |
| Approve an intended outcome and scope | Exact effect approvals, drift and precondition guards | Versioned destination/scope proposals and separately recorded operator decisions |
| Understand a journey | Orthogonal lifecycle states and retained evidence | Checkpoint/obligation projection across missions; no inferred passed checks |
| Edit or reject a proposal | Immutable backend history patterns | New proposal revisions, stale-review rejection, preserved underlying problem |
| See what is still owed | Recorded attention and unknown-outcome capture | Communication plans, outstanding obligations and explicit closure evaluation |
| Resume waiting work | Durable workflow and subscription primitives | Linked-signal correlation, bounded reactivation and expired-approval revalidation |
| Use the console safely | Trusted bearer MCP, not browser operator identity | Next.js console, required operator authentication and narrow control endpoints |
| Run one live SloSki case | Local worker and effect foundations | Confirmed profile, actual integration credentials, readiness and live acceptance |

## Delivery sequence and exit gates

### P1 — Reviewable Operations prototype

Decision question: can David identify the next necessary decision and understand
its scope, uncertainty, final outcome and outstanding work without reading logs?

Build the specified airport-operations board and one full secondary-review flow.
Use synthetic, clearly labeled in-memory examples; no real mailbox references,
production data, credential entry, backend calls, real sends or durable approvals.
Keep the prototype separate from production code. A lightweight standalone browser
artifact can test the interaction without adopting a new runtime; the production
console remains the specified Next.js application and requires its own hardening.

Required cases:

- Needs your decision is the initial view; filters/counts reflect the sample set.
- Current checkpoint, proposed/approved outcome, next owner and reason stay distinct.
- Scope review can be edited, approved in the simulation, or rejected; edits create
  a new proposal revision, while rejection preserves the underlying request.
- A simulated material update invalidates an open approval without stealing focus.
- Missing verification stays incomplete; a recorded operator report is not a pass.
- Waiting remains open; a returning signal retains the same request identity.
- Outcome verified / Communication due remains separate from closed.
- Mobile, keyboard and reduced-motion use retain the exact decision context.

Automated checks cover model transitions and browser interaction. Visual review
covers desktop and narrow viewports in bounded passes. David judges usability;
passing tests is not product-owner acceptance. No pilot outcome is claimed.

Candidate: [Operations prototype](../../prototypes/operations/index.html), with
[exercise instructions](../../prototypes/operations/README.md). Open the file in a
browser; it needs no server or credentials and resets its sample state on reload.
The first candidate includes five authored requests, revision-bound simulated scope
decisions, preserved rejection/history, incomplete verification, communication due,
unknown send outcome, linked-ticket return and explicit source-coverage uncertainty.
David's usability review remains the P1 exit gate.

### P2 — Durable request and review contract

The independent P2a foundation records immutable original request identity and
same-project mission associations without selecting closure, outcome taxonomy or
recurrence policy. It can proceed before P1 usability acceptance. Migration 0024
and the private `PostgresRequestStore` implement this boundary; see
[request identity](../architecture/0039-request-identity.md). One intake may seed
multiple explicitly distinct requests, and a request may link multiple missions.
The authenticated counterpart `get_request_history` read returns one bounded recorded snapshot; it
does not assess current mission state or derive a board's action priority.
No request writer endpoint, browser binding, source assignment or execution is enabled.

#### Next bounded increment: request brief (proposed, 2026-09-08)

Add a read-only counterpart brief using the immutable request history and separately
permitted mission/attention observations. Follow technical specification section
16.5 and product scenarios ACP-PRODUCT-33–35. Preserve each source's identity,
coverage, observation time and authority limits; do not reinterpret
`get_request_history` as a live status or priority API. Records not implemented yet,
including destination decisions, obligations and communications, remain unavailable.
Do not add an editable summary ledger or infer empty obligations from missing data.

Exercise a fresh-reader recovery case, stale and missing records, bounded overflow,
cross-project denial and source changes during assembly. The brief must retain
known evidence while exposing any inability to establish a coherent current view.
It grants no creation, execution, approval or closure authority. Measure recovery
time and unnecessary task/source openings against the existing history-only read.
This increment can precede the open closure/recurrence policies; live board binding
still needs its separately authenticated operator surface. UX-17–18 are added
requirements, not retroactive passing claims for the existing prototype.

The workflow-video review also clarifies durable wake reasons, quiet notifications
and usage reporting. Verify the existing primitives against those requirements
before adding runtime machinery. Model/effort routing, automated client integration
and BB/Herdr adoption remain research decisions, not dependencies of this increment.

Apply technical section 16.2.1 to the request brief and its retrieval responses:
retain source pins and coverage, expose overflow through continuation or refusal,
and return scoped evidence references instead of broad source or log payloads.
Technical sections 26.3.1 and 29.2 and ACP-PRODUCT-36 govern subsequent efficiency
evaluation and complete delegation accounting. Reconcile existing contracts before
adding fields or runtime machinery. Keep unavailable usage explicit; do not claim
savings from the brief alone. The routing comparison is required before adopting
an efficiency routing policy, not a prerequisite to the bounded read-only brief.
Portal, another provider, fixed model routes and a universal file-size threshold
are not selected by this amendment.

Implementation status (2026-09-08): the first foundation now provides a pure,
runtime-validated domain projection and deterministic assembler over exact request
history, selected mission-status observations and recorded attention pages. It is
not yet stored or exposed through API, MCP or UI. Destination decisions,
obligations, communications and next-action authority remain explicitly
unavailable. The projection distinguishes unavailable attention from an observed
empty or paginated page, retains executable scoped read selectors and source-change
pins, reports missing and stale issues independently, and refuses association or
byte overflow as a whole result. Live source acquisition and the acceptance
measurement remain later increments.
The separate [BB trial assessment](../research/BB_TRIAL_ASSESSMENT.md) records
the checked version, local prerequisites, account checks and stop procedure.

After the policy decisions below, implement versioned destination/scope proposals,
obligations, communication plans and decisions.
Bind the board's exact projection and stale-action checks to real retained records.
Reuse ACP approvals/effects; UI scope approval never pre-approves future payloads.
Exercise restart/replay, conflicting updates and partial/unknown results.

### P3 — One manual-intake end-to-end case

Build manual intake through investigation, scope review, tracked implementation,
independent verification, required communication and closure. Gate each capability
on actual readiness. Where production changes are needed, retain the reviewed
manual handoff and distinguish reported completion from verified results.

### P4 — Narrow SloSki pilot

Add selected Gmail-label intake, the real configured tracker and GitHub capabilities,
linked progress signals and required notifications. Configure the deployment and
operator identity only with the necessary confirmed inputs and authority. Measure
handling time and failures without inferring the provisional 50% improvement target.

Broad Slack/monitoring/meeting intake, additional projects, self-expanded authority
and automated production mutation are not prerequisites for this first pilot.
Their ACP milestones remain open; this sequence does not mark them complete.

## Decisions and inputs still needed

| Item | Owner / gate | What can proceed before it |
|---|---|---|
| Final-outcome taxonomy and exact closure conditions | David; before production request/closure contract | Review prototype and policy-neutral request identity/mission links |
| Invalid closure versus genuine recurrence | David; before automatic reopen/recurrence behavior | Present uncertainty; no automatic choice |
| Board density, checkpoint wording and interaction fit | David's prototype review | Bounded desktop/mobile prototype and tests |
| Project sources, Gmail label, tracker mapping, environments and recipients | Confirmed SloSki onboarding | Synthetic/manual-input development |
| Operator identity, credential provisioning, hosting and live model access | Secure configuration and separate live-effect authority | Local read-only/prototype checks |

Naming is not a blocker: all new surfaces and documents use ACP until David changes
it. A future name must not rename retained operational IDs or alter authorization.

## Not yet claimed

No live console, deployed integration, production approval, sent communication,
autonomous end-to-end pilot or final policy acceptance is established. Request
identity persistence is private infrastructure, not the complete durable passenger
journey or an authenticated intake endpoint. Previous M2/M3/M5 evidence remains
valid only at its recorded scope.
