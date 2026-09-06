# ACP UX/UI specification: airport operations command center

| Field | Value |
|---|---|
| Version | 0.2 |
| Date | 2026-09-06 |
| Status | Proposed interaction specification; isolated synthetic Operations prototype available for review, production interface not implemented |
| Product name | ACP, until David selects a replacement |
| Product contract | [ACP product specification: airport operating model](ACP_PRODUCT_SPECIFICATION.md) |
| Initial operator and project | David; SZS / SloSki |

## 1. Design brief

Build the experience of a professional airport operations system for agentic project work. Requests are passengers whose journeys contain identity/context checks, evidence screening, permission checks, review, execution, waiting, and verified arrival at an approved final outcome.

The primary screen's job is to help David identify the decisions that need his attention, understand their consequences, and make them without reconstructing the request across tools. The interface must answer four questions for each passenger: why is it here, what does it need, who can clear the next step, and where does it go next?

The approved direction is airport management. The exact visual tokens, layouts, and interaction details in this document are proposals to evaluate through a prototype. The metaphor must preserve the product contract's approval, testing, communication, and manual-production boundaries.

The first [Operations prototype](../prototypes/operations/index.html) implements a
bounded subset with authored samples only. Its [review guide](../prototypes/operations/README.md)
and [delivery sequence](implementation/PRODUCT_SLICE.md) distinguish prototype
evidence, product-owner acceptance and the remaining durable implementation.

## 2. Visual direction

### 2.1 Character

Use the structure of an operations room: a live board of work, compact signs and labels, precise alignment, restrained status signals, and an adjacent desk for decisions. The signature element is a passenger journey strip whose named checkpoints correspond to the same stages shown on the operations board.

Concentrate visual character in the board typography and journey strip. Surrounding controls and evidence panels remain quiet. This should feel like software used to manage consequential work over several hours, with enough density to compare multiple requests and enough space to read one decision carefully.

Airport decoration must encode actual information. Terminal and gate labels identify workflow families and named boundaries. The UI must not fabricate airport codes, passenger nationalities, departure times, scanner progress, runway traffic, or estimated arrivals. Avoid photographs, promotional hero sections, ornamental aircraft animations, and decorative KPI cards in the working console.

### 2.2 Proposed color tokens

| Token | Value | Role |
|---|---|---|
| Operations ink | #101D2C | Main background and dark text on bright action surfaces. |
| Console panel | #1A2E43 | Review panels, selected rows, and contained operational surfaces. |
| Instrument white | #EFF4F8 | Primary text and icons. |
| Attention amber | #F3C65C | Decisions requiring David; carefully limited primary action emphasis. |
| Verified teal | #7AD6BC | Verified results and completed checks. |
| Exception red | #FF9A91 | Failed checks and urgent actionable exceptions. |

Waiting, deferred, and not-required states use explicit text and neutral outlines rather than appearing as failures. Secondary text and dividers may derive from the core tokens, but their actual contrast must be checked after implementation. No status depends on color alone.

Bright action surfaces use operations-ink text. Verify at least 4.5:1 contrast for normal text and 3:1 for large text and meaningful control boundaries in the actual rendered combinations. Hover, selected, disabled, and focused states require their own review.

### 2.3 Proposed typography

| Role | Direction |
|---|---|
| Operational headings and short signs | Bahnschrift or a suitably available condensed technical sans, used with restraint. |
| Reading and interaction | Segoe UI or a clear system sans for summaries, evidence, explanations, forms, and controls. |
| Identifiers, ages, and aligned numeric data | Cascadia Mono or a suitable system monospace; tabular numerals where available. |

These are prototype font choices with fallback stacks, not a dependency-installation requirement. Confirm availability and legibility before production selection. Naming and final brand work may refine them.

Use short uppercase column headings and navigational signs where helpful. Keep sentences, explanations, and action labels in sentence case. Start with 14–16 px readable interface text, 18–24 px section headings, and approximately 28 px page headings, then validate at the intended density and browser zoom.

### 2.4 Layout, surfaces, and motion

- Use a compact navigation rail, an operations board, and a contextual review workspace.
- Rows and aligned columns carry the workload view; evidence and decisions use readable panels.
- Use dividers and modest radii for containment, with minimal shadows and no decorative gradients.
- Distinguish source provenance, permission, verification, and execution through labels and structure as well as color.
- Update highlights are brief and quiet. Do not simulate split-flap animations on every status change.
- No ambient scan animation or spinning progress without a running operation. Respect reduced motion.

## 3. Information architecture

| Surface | Purpose |
|---|---|
| Operations | Primary work board; opens with Needs your decision selected. Other filters expose active and recently changed work. |
| Arrivals | Recently received signals and their disposition: new passenger, attached to existing work, uncertain association, or no action required. |
| Secondary review | Decisions and blockers requiring David, ordered by configured urgency and relevant waiting time. It shares the same passenger records as Operations. |
| Waiting | Deferred and externally waiting passengers, with the reason, next owner, and wake condition or review date. |
| Completed | Verified final outcomes and their receipts. Declined, cancelled, and consolidated records remain explicitly distinguishable. |
| Project readiness | Relevant source coverage, capability health, credentials through ACP's secure flow, environments, and configured limits. |

Do not create independent copies of a request for these surfaces. They are views of the same durable passenger and its sources, decisions, and journey.

## 4. Operations board

### 4.1 Core information

Prioritize subject, current checkpoint, state or waiting reason, final outcome, next action/owner, and age. Show the project, source, communication due, and last meaningful change in supporting cells, expanded rows, or optional columns. Column density must adapt to the viewport rather than hiding critical distinctions.

Request identifiers must be stable and copyable. A displayed gate must include its function, such as Dev verification or Production handoff. Ages identify what they measure, such as waiting for decision for 24 minutes; they are not implied delivery estimates.

Filters and counts must describe their scope. If an all-active count includes passengers awaiting external work, it must not be presented as the number of decisions David needs to make.

### 4.2 Desktop wireframe

This is a structural wireframe with illustrative data, not a screenshot of running work. The EX identifiers and states below are examples and do not assert the status of any real incident.

```text
+----------------+-----------------------------------------------------------+
| ACP            | OPERATIONS                   Project: SZS   Source updated |
|                | Needs your decision  |  All active  |  Recently changed   |
+----------------+--------------------------------+--------------------------+
| Operations     | PASSENGER / REQUEST            | SECONDARY REVIEW         |
| Arrivals       | Checkpoint | State | Next      | EX-001                   |
| Secondary      |--------------------------------| Membership amendment     |
|   review       | EX-001 Membership amendment    |                          |
| Waiting        | Scope review | Decision due    | FINAL OUTCOME            |
| Completed      | Final: Production resolution   | Production issue resolved|
| Readiness      | Next: Approve scope            |                          |
|                |--------------------------------| WHY YOU ARE NEEDED       |
|                | EX-002 Submission guidance     | Scope and acceptance     |
|                | Reply review | Decision due    | require your decision.   |
|                | Final: Support answered        |                          |
|                | Next: Review reply             | PROPOSAL + BLAST RADIUS  |
|                |--------------------------------| Evidence / Uncertainty   |
|                | Selection and scroll preserved |                          |
|                | while detail is inspected      | [Approve scope] [Edit]   |
+----------------+--------------------------------+--------------------------+
```

On wide desktop layouts, keep a roughly 480–600 px review workspace beside the board when space permits. At intermediate widths, use a drawer or full detail view while retaining the board's navigation context. Exact breakpoints are prototype choices to test with realistic text, not frozen device assumptions.

### 4.3 Live behavior

- Show when source and runtime observations were last refreshed, with the relevant timezone available.
- Preserve row selection, scroll position, open evidence, and keyboard focus when unrelated updates arrive.
- Do not reorder a row away from an operator who is reviewing or acting on it. Offer a visible refresh/re-sort cue when needed.
- If new evidence invalidates an open proposal, explain the material change and disable the outdated approval.
- Distinguish a healthy empty queue from a disconnected source whose arrivals are unknown.
- Returning work shows the reactivation reason, such as linked ticket selected, without creating a second passenger.

## 5. Passenger journey workspace

The record header shows the real request subject, project, urgency and rationale, final outcome, current checkpoint, and next owner. It always distinguishes a proposed destination from an approved destination.

The journey strip is the signature view. Each checkpoint exposes its purpose, status, evidence, and next action. Branches and repeated checks are represented honestly. Completed, current, future, blocked, incomplete, and not-required checkpoints remain distinct.

```text
PASSENGER / REQUEST EX-001                         Final outcome: Production

Arrival -> Context -> Scope review -> Implementation -> Dev verification
 Passed     Passed    YOUR DECISION      Pending          Pending
                                                          |
                         Final arrival <- Communication <- Production handoff
                            Pending          Pending            Manual

The route is illustrative. Optional branches and early communications appear
where the approved plan requires them; the UI does not imply a universal path.
```

Use secondary sections for Source/passport, Scope and permissions/visa, Evidence/luggage, Decisions, Linked work, Environment and candidate, Manual handoffs, and Communication plan. Literal names remain visible so David does not need to decode the metaphor to inspect a fact.

A passenger that ends with an explanation or decline has a suitable shorter journey. It must not appear to have skipped compulsory engineering work or taken a fictional flight.

## 6. Secondary review and exact approvals

### 6.1 Review structure

The first reading order is: what needs deciding, the recommendation, why it is supported, material uncertainty and blast radius, then the exact proposed decision or action. Detailed logs and source artifacts remain available without being the default narrative.

For a redesign, show before and after behavior side by side on desktop and in clearly labeled sequence on narrow screens. Highlight changes to user steps, permissions, data, and integrations. Explain benefits, costs, downsides, and alternatives. Do not bury an unfavorable trade-off under a positive summary.

For an external effect, keep recipients or targets, environment, relevant candidate/cohort, effect preview, and known verification limits visible near the authorization control.

| Review type | Example primary action | Required boundary |
|---|---|---|
| Initial outcome and scope | Approve scope | Does not authorize unknown later payloads or production mutations. |
| Prepared client reply | Send approved reply | Exact recipients and content are shown; plan approval alone is insufficient. |
| Proposed tracker update | Approve ticket update | The changes and target are visible. |
| Production plan | Approve manual handoff | The product does not execute the production mutation in V1. |
| Missing verification | Provide evidence / Retry verification | A user assertion does not silently mark an unperformed check as passed. |
| Redesign | Approve revised scope | The before/after and trade-offs are reviewed; implementation waits for this decision. |

Use the action label that matches the actual operation. Do not add a generic Clear passenger button that conflates approval, execution, and completion. Bulk authorization across unrelated passengers is outside the first prototype; any combined approval must remain an exact, reviewable bounded set of actions within its authorized scope.

### 6.2 Edits, rejection, and stale proposals

Simple draft edits retain a visible preview. Behavior or scope directions create a revised proposal and refresh the relevant checks. An affected approval is visibly invalidated when its reviewed state changes.

Reject solution records the reason and returns the underlying problem for alternatives or an explicit disposition. Decline request and Cancel remaining work are separately named controls. The UI explains unresolved obligations before either action is recorded.

An approval that is already pending or submitted shows its state without encouraging duplicate clicks. If the result is unknown, present the reconciliation state and relevant next action instead of a blind resend option.

## 7. Evidence review

The evidence view starts with the acceptance condition, result, environment, candidate, observation time, and limitations. It then presents the most useful medium: screenshot, recorded walkthrough, preview application, structured test result, or a combination.

Screenshots should be legible and anchored to the behavior shown. Recordings should identify the relevant segment. Preview applications must identify the candidate and environment, and their provenance must remain visible. A polished preview is not live production verification.

Passed acceptance conditions and missing or failed regression checks must remain visible together. A large green completion indicator must not obscure an incomplete required check elsewhere in the same destination contract.

## 8. Waiting, blockers, and communication

Waiting records show the reason, next owner, next wake condition, and outstanding obligations. A backlog item can display a production final outcome without appearing finished. A reactivation shows what changed and which checkpoint is eligible next.

Blocker resolution offers a specific input or handoff based on the actual missing condition. General text input, source links, file evidence, and scope decisions may be supported where appropriate. Credential entry uses ACP's secure readiness flow, never an ordinary comment field.

The communication plan appears as a compact list of messages with purpose, recipient, trigger, required/conditional/optional status, and current drafting/review/delivery state. An urgent acknowledgement can become actionable before implementation starts. Final communication becomes due after technical acceptance, before final closure.

A passenger can show Outcome verified / Communication due. It reaches Final arrival only when its approved completion contract passes. A failed or unknown send remains visible and cannot disappear behind a completed engineering stage.

## 9. Responsive and accessible behavior

At narrow widths, the board becomes a prioritized request list and selecting a passenger opens a full workspace. Preserve the required decision, state, final outcome, and next owner. Offer other fields on expansion rather than forcing a full desktop table into tiny columns.

Keyboard navigation supports row selection, opening and closing detail, moving through review controls, and returning to the previous board position. Focus remains visible and predictable. Use native table, form, button, and dialog semantics where applicable.

Status uses text and icons as well as color. Live-region announcements report meaningful changes without announcing every background heartbeat. Motion can be reduced or removed without losing information. At increased browser zoom, the authorization context and controls must remain usable.

On a small screen, no approval may hide its production target, recipients, material scope, or known verification gaps behind an unrelated collapsed panel. If the detail is lengthy, the review must retain clear anchors back to those facts before the action is taken.

## 10. Empty, stale, and failure states

| State | Required presentation |
|---|---|
| No pending decisions and sources healthy | State that no decisions are waiting; show the relevant observation time and a path to active/waiting work. |
| Source unavailable | Show the coverage gap and last successful observation; do not claim there are no arrivals. |
| Verification incomplete | Name the missing required check, consequence, and resolving action. |
| Verification failed | Show the failed condition and supported repair or review action. |
| Permission expired | Identify the affected capability and its secure renewal path. |
| Manual action reported complete | Show awaiting verification until the required evidence is established. |
| Unknown external outcome | Show reconciliation and suppress unsafe duplicate execution. |
| Final destination reached | Show the approved contract, verification, and communication completion that justify closure. |
| Declined or cancelled | Show the actual disposition and rationale without a fixed/resolved success label. |

## 11. Prototype scope and evaluation

The first prototype should demonstrate the Operations board and one complete Secondary review flow with clearly labeled illustrative data. It should then cover incomplete verification, deferred reactivation, and outcome verified / communication due.

Evaluate whether David can determine, without opening raw logs:

1. Which passenger needs his decision first and why.
2. The difference between its current checkpoint and final outcome.
3. What is established, what is uncertain, and what action he would authorize.
4. How to edit or reject the proposed solution without losing the underlying problem.
5. What missing condition must be verified before an incomplete check can pass.
6. Whether an action happened in dev or production, and whether it was verified.
7. Whether the client still needs a message.
8. Why deferred work returned and who owns the next step.

Compare the layout against the stated workflow rather than judging only its airport appearance. Visual fidelity, decision accuracy, review time, and navigation effort are separate evaluation dimensions. The live product's 50% attention-reduction target remains governed by the product pilot, not by an attractive static prototype.

## 12. UI acceptance scenarios

| ID | Required behavior |
|---|---|
| UX-01 | Operations opens with Needs your decision selected and shows the actual filter scope. |
| UX-02 | A passenger row and detail both distinguish checkpoint, final outcome, and next action. |
| UX-03 | Known source identity cannot visually imply universal permission or verified claim validity. |
| UX-04 | Passed, failed, incomplete, awaiting decision, externally waiting, and not required remain distinguishable without color. |
| UX-05 | Live updates preserve review context and disable materially stale approvals with an explanation. |
| UX-06 | Before/after, blast radius, benefits, and downsides remain inspectable before redesign approval. |
| UX-07 | Every consequential action uses a specific label and exposes its exact target and relevant scope. |
| UX-08 | Production action controls offer manual handoff and verification in V1, not automatic mutation. |
| UX-09 | Rejected solutions preserve the underlying incident and its outstanding obligations. |
| UX-10 | Incomplete checks remain visible alongside successful visual demonstrations. |
| UX-11 | Returning tracker work resumes the same passenger and explains the triggering change. |
| UX-12 | Technical completion with a required unsent reply remains Communication due, not Closed. |
| UX-13 | Keyboard, reduced-motion, zoomed, and narrow-screen use preserve review and approval context. |
| UX-14 | Empty and disconnected states communicate different levels of source knowledge. |
| UX-15 | No screen fabricates flight times, scan progress, capacity, or verification success. |
| UX-16 | Illustrative prototype data cannot be mistaken for live operational facts. The interface uses ACP until David selects a replacement name. |

## 13. Naming and design follow-through

Use ACP consistently in the interface, product documents, and prototype. Keep the wordmark and brand-specific assets replaceable for a future naming decision. The airport operating model does not require a literal aviation name. Any replacement must be evaluated in actual interface phrases, including Operations, passenger detail, secondary review, and final outcome.

The next design step is a reviewable prototype of the specified board and one passenger's decision flow. Final font selection, exact spacing and breakpoints, icon treatment, and branded assets follow that evaluation and the naming decision. They must preserve the behavior and authority boundaries already established here.
