# ACP — Product-led delivery slice

Status: Isolated Operations prototype built for review; independent request identity and private recorded-history foundation implemented.
Baseline: `85a137818e964065a1783fc825053cecfaadb10f` (published to GitHub `main`).
Decision: David approved bringing the product/UI specifications into the next
delivery phase and selected ACP as the current name on 2026-09-06.

## Source contract

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
| Find the request needing a decision | Recorded mission, attention and readiness MCP reads; private immutable request history and mission associations | Cross-request board projection and authenticated board integration |
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
The private exact-request history read returns one bounded recorded snapshot; it
does not assess current mission state or derive a board's action priority.
No operator writer, browser binding, source assignment or execution is enabled.

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
