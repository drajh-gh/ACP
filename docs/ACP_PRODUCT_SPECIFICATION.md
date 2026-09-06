# ACP product specification: airport operating model

| Field | Value |
|---|---|
| Version | 0.3 |
| Date | 2026-09-06 |
| Status | Review-ready draft; not yet an implementation-ready specification |
| Product owner and initial operator | David |
| Product name | ACP, until David selects a replacement |
| Conceptual model | Airport operations: passengers, journeys, checkpoints, clearances, and final outcomes |
| Companion | [UX/UI specification](AIRPORT_UX_UI_SPECIFICATION.md) |
| First project | SZS / SloSki |
| Execution foundation | Agentic Control Plane (ACP) |
| Basis | Accepted product interview decisions, refined destinations and communication plans, and David's approved airport model and airport-management visual direction |

Version 0.3 uses ACP as the current product name and ACP-PRODUCT-prefixed acceptance IDs. The airport operating model remains a way to organize requests and decisions, not a specification for real border-control or aviation software. A future name can change without changing request identity or operational meaning.

## 1. Product outcome and evidence

The product turns incoming project signals into prepared decisions and follows approved work to a defined final outcome. Its command center lets David understand, approve, edit, defer, reject, and unblock that work without reconstructing its history across email, trackers, coding tasks, and deployment systems.

The first user's reported problem is bursty SZS email intake: several requests may arrive within an hour, followed by a quiet period. David sends individual reports to Codex for investigation and may manage five or more matters concurrently. Repeatedly recovering the original request, implementation state, outstanding work, and client communication consumes time, delays delivery, and occasionally allows work to be missed. The interview establishes this pattern and its reported consequences; handling time has not yet been measured.

The initial success hypothesis is that reviewing prepared passengers and managing their exceptions will reduce human handling time per comparable case by 50%. This is a provisional target to test against a measured baseline, not an established result.

### 1.1 Concrete reference case

An operator-provided club email, forwarded on 2026-09-04, reports an error when supplementing a membership application. The club supplied the requested photograph through email because it could not complete the portal flow. The private mailbox locator and club name are omitted from this public copy; the original source reference is retained locally, outside Git.

The email establishes the reported blockage. This specification does not establish its technical cause or claim that a repair has been verified. It intentionally omits the individual applicant's identifying details and the photograph.

David's desired response policy for a confirmed blocked core flow is:

1. Unblock the reported individual case.
2. Investigate the root cause.
3. Establish how many other users or records may be affected.
4. Implement and verify prevention of recurrence.
5. Remediate other affected production records where necessary.
6. Complete the communications required for the matter.

The original user's recovery is a milestone within that response. It must not silently remove the remaining obligations.

### 1.2 Decision status

The following direction is user-confirmed: one-project Gmail/manual intake; automatic investigation and proposal preparation; scope approval before implementation; gated external effects; initial manual production handoffs; contextual evidence presentation; independent verification; explicit blockers; approval before redesign implementation; preserved decisions; and an attention-oriented command center.

David additionally requested a proposed final destination for every defined passenger, approval of that destination near the beginning, closure when it is achieved, returning signals for work at intermediate destinations, and a contextual communication plan for each passenger.

David approved the airport operating model and an airport-management UX/UI direction. A passenger represents a request, not a person. The precise destination taxonomy, reactivation rules, checkpoint presentation, and closure mechanics below are proposed formalizations of that direction. Section 16 identifies the small set of policies to review before declaring this specification implementation-ready. They are not historical user decisions merely because this draft uses normative language.

## 2. Scope and relationship to ACP

### 2.1 V1 scope

- One operator and one initial project: David and SZS / SloSki.
- New matters originate from a dedicated Gmail label or manual submission.
- Investigations may read relevant project documentation, source code, tracker items, and GitHub context through permitted capabilities.
- Existing linked tracker items, PRs, CI runs, and deployments may generate progress or reactivation signals. This is targeted follow-up of existing passengers, not general ingestion of every tracker or GitHub event as new work.
- An airport-management command center supports an operations board, passenger journey records, secondary review, direct draft editing, natural-language directions, decisions, blockers, manual handoffs, and visible progress.
- Approved tracker, communication, and engineering actions use ready ACP adapters. Development deployment and validation are supported where the project capabilities exist.
- Production deployments and database corrections initially use reviewed manual handoffs. The product prepares and tracks them and obtains verification evidence afterward.
- Passengers can follow the full incident lifecycle even when individual steps are performed outside the product.

### 2.2 Later scope

Broad Slack, monitoring, meeting, and tracker intake; more projects and users; automatic selection of final destinations; automatic expansion of execution permissions; and automated production mutation are later capabilities. Their interfaces may be anticipated, but they are not V1 acceptance conditions.

V1 does not need a new project tracker or a second workflow runtime. Passenger state must survive the end of a worker or conversational task.

### 2.3 ACP boundary

The [ACP specification](../SPECIFICATION.md) supplies durable missions, bounded workflow graphs, context packets, capability enforcement, approval envelopes, effect execution, reconciliation, and lifecycle evidence. The product supplies the product concepts and operator experience around those capabilities.

A passenger may coordinate several ACP missions over time. Passenger identity must not depend on one Codex task, worker session, or workflow run. ACP remains authoritative for execution records and receipts; the product must not manufacture a successful execution state from a UI action.

The product imposes stricter V1 policy where necessary: implementation requires an approved scope, external sends require exact review, and production mutations remain manual. The command center also adds proposal and intent editing to ACP's original console scope; it must translate edits into versioned proposals rather than directly changing operational facts.

## 3. Airport domain model

The airport is a control and coordination model. Metaphorical labels help David understand a request's route; literal labels identify the actual decision, permission, action, or evidence. Operational records must retain their meaning if the eventual brand changes.

| Airport concept | Product meaning | Boundary |
|---|---|---|
| Passenger | One underlying problem or requested outcome, represented by a durable request record. | It is a unit of work, not the human sender. One sender may originate several passengers. |
| Arrival / signal | An incoming message, event, manual submission, review timer, or relevant observed change. | An arrival can update an existing passenger without creating a new one. |
| Passport | Source identity, authentication status, provenance, and project association. | A known source does not establish the truth of its claims or grant effect authority. |
| Visa / clearance | Approved scope and the applicable permissions for specified actions, targets, and conditions. | Destination approval does not authorize unknown future effects; every concrete effect retains ACP's checks. |
| Luggage | Claims, context, attachments, dependencies, proposed changes, and linked evidence. | Contents remain untrusted until assessed; sensitive data remains subject to project boundaries. |
| Processing lane | A workflow selected for the request's nature, urgency, impact, uncertainty, and available permissions. | Identity or sender familiarity alone cannot determine automatic passage. |
| Terminal | A functional workflow family, such as incident repair, change evaluation, or support resolution. | It is not a project, final outcome, or automatically granted permission. |
| Checkpoint | A required assessment or decision with a named condition, evidence, status, and owner. | Passing one checkpoint does not imply that other checks passed. |
| Screening station | Evidence validation, scope/authority checks, content-safety checks, testing, or regression assessment. | Screening reports known findings and uncertainty; a clean result does not guarantee all risks were detected. |
| Automated gate | A checkpoint or bounded action that may proceed under an established policy when all required conditions pass. | V1 does not gain new autonomy from the metaphor. Human destination and effect approvals remain where required. |
| Secondary review | A material ambiguity, redesign decision, authorization request, or blocker requiring David. | Use neutral review language; escalation is not an accusation of malicious intent. |
| Waiting area | Deferred or externally waiting work with a reason, responsible owner, and wake condition. | Waiting is not successful completion. |
| Gate | The next defined admission or execution boundary, displayed with its functional name. | A gate is an intermediate location, not necessarily the final destination. |
| Flight / execution run | A bounded, approved delivery workflow executed through ACP or a tracked manual handoff. | Not every passenger needs a flight; support and decline journeys can finish without code delivery. |
| Journey | The versioned route of checkpoints, decisions, execution steps, obligations, and communications toward the approved final destination. | Routes branch, wait, and revisit relevant checks; there is no universal compulsory sequence. |
| Journey step | A bounded part of the route that may contain several dependent actions. | Individual actions retain their own authorization, execution, and verification records. |
| Final destination / arrival | The approved final business outcome and its closure conditions. | Boarding, executing, deploying, and verifying remain separate states. |
| Incident | The underlying failure and its impact. | It can have several proposed solutions and recorded decisions. |
| Decision | An operator choice bound to a particular proposal, scope, destination, or disposition. | It records authority and rationale, not proof that an effect succeeded. |
| Obligation | Work, verification, communication, or follow-up requiring an explicit disposition before closure. | A completed waypoint cannot erase it. |
| Evidence | A source-backed observation or artifact with provenance, freshness, scope, and limits. | Agent agreement and visual polish do not substitute for verification. |

A passenger's final destination and current checkpoint are distinct. The source's passport establishes provenance; the nature and context of the request determine its lane; approved permissions govern passage. Each defined passenger has an approved destination contract and communication plan.

### 3.1 Route examples

- Core-flow incident: arrival -> identity/context checks -> investigation -> scope/destination review -> immediate-unblock proposal -> reviewed manual production handoff -> preventive implementation -> dev screening -> reviewed production handoff -> outcome verification -> required communication -> final arrival.
- Support question: arrival -> context and claim assessment -> reviewed explanation -> delivery and any required follow-up -> final arrival.
- Deferred change: arrival -> scope evaluation -> approved future outcome -> waiting area/backlog -> relevant linked-ticket signal -> resume the same passenger at the appropriate checkpoint.
- Unwarranted request: arrival -> evidence and scope assessment -> David's explicit decline decision -> required reviewed explanation -> closed as declined, never shown as a technical fix.

These are illustrative routes. A checkpoint that is unnecessary for the approved outcome is explicitly not required, rather than falsely recorded as passed. Communications can occur at several points in parallel with the technical route. Immediate acknowledgement does not wait for final arrival.

### 3.2 Stable display vocabulary

Use Passenger / request when introducing the concept, Journey for its progress and obligations, and Final outcome alongside destination labels. Passport, visa, luggage, terminal, and flight may organize detail views, but action labels must name their effects: Approve scope, Send reply, Review production handoff, or Retry verification. Avoid ambiguous commands such as Clear passenger or Let through.

Functional gate labels such as Dev verification and Production handoff must remain visible. Decorative gate codes, nationality categories, airport codes, or scheduled flight times must not be invented as if they were operational facts.

## 4. Final destinations and waypoints

### 4.1 Proposed final-destination taxonomy

| Type | Intended result | Required distinction |
|---|---|---|
| Production issue resolved | The approved production flow is restored, required prevention and affected-case remediation are verified, and required communications are complete. | A merged PR, a deployment alone, or one user's workaround does not establish this result. |
| Requested change delivered | Approved behavior is delivered and verified in the explicitly named final environment, with required communications complete. | A dev-only final outcome must be deliberately approved as that limited scope; it cannot imply production delivery. |
| Support matter answered | An evidence-backed explanation or usage guidance has been delivered, and any required confirmation or follow-up condition is satisfied. | Classifying a report as user error does not by itself answer the requester. |
| Request declined | David's explicit decision and rationale are recorded, and required communication is complete. | The UI says declined, not fixed. Any continuing defect or limitation remains visible in the decision and cannot be reported as resolved. |

These types describe business outcomes. Their detailed conditions are specific to each passenger. New destination types require an explicit policy decision in V1 rather than an agent inventing a new kind of successful closure.

### 4.2 Waypoints

For an incident whose final destination is production resolution, backlog, triage completed, PR open, merged to dev, deployed to dev, dev validation passed, release prepared, and individual user unblocked are waypoints.

Landing a ticket in backlog does not close that passenger. It changes the passenger to deferred, preserves its approved final destination and obligations, and records an owner plus a reactivation condition or review date.

Development validation may be the approved final outcome only for an explicitly limited assignment. For example, a requested change may intentionally stop at a validated development candidate. The completion label must name that limitation. The product must not change a production incident's destination to dev validation to make it appear complete.

Duplicate consolidation and cancellation are administrative dispositions, not evidence that a final outcome was achieved. A consolidated record redirects to the surviving passenger and preserves its sources and decisions. Cancellation remains distinguishable from successful closure.

### 4.3 Destination contract

Before implementation begins, the product proposes a destination contract containing:

- The underlying problem or request and the reason this outcome is warranted.
- The final-destination type, intended user-visible behavior, target environment, and scope.
- Observable acceptance conditions and disqualifying findings.
- Required verification and its evidence rules.
- Required obligations, including prevention and cohort remediation where applicable.
- The communication plan and which items are completion conditions.
- Intermediate waypoints and planned journey steps.
- Known uncertainty, assumptions, exclusions, and dependencies.
- Contract revision, approving actor, and approval time.

Exact candidate SHAs, effect payloads, and production cohorts may become known later. Their subsequent approvals bind those concrete identities; the initial destination approval must not pretend they were already reviewed.

Every material revision records its reason and returns to David for approval. Reducing required scope or changing the final destination must never be an automatic response to failed testing or difficult implementation. Displaced obligations must receive an explicit disposition.

### 4.4 Closure evaluation

A passenger closes only when the current approved destination contract passes. The evaluator must establish that:

1. The approved outcome is verified against the relevant current candidate and environment, or the approved final disposition has been recorded.
2. Required tests and acceptance checks have passed with applicable evidence.
3. Required effects are verified, with no unknown outcome that could invalidate closure.
4. All required obligations have been fulfilled or explicitly resolved through an approved contract revision.
5. Every triggered, required communication-plan item is complete.
6. No material conflict, new evidence, or approval drift invalidates the result.

The closure record contains the contract revision and supporting evidence. Closure of the passenger does not silently change a tracker state; that remains a separately governed effect.

When technical acceptance passes but a closing message remains due, show outcome verified / communication due. The final-message trigger is technical acceptance, not passenger closure, so the communication requirement cannot create a circular dependency.

## 5. Intake, correlation, and returning signals

### 5.1 Intake behavior

The product authenticates provider events, deduplicates deliveries, preserves original source references, and exposes incomplete source coverage. Source text remains untrusted evidence, even when it contains apparent agent instructions.

Each intake is classified as a new matter, continuation, duplicate, irrelevant signal, or uncertain association. Several independent requests in one email may create separate passengers with shared source references. Several emails about the same underlying matter may belong to one passenger.

Relatedness must be supported by source identity, linked objects, project context, and evidence. Uncertain merges are proposed for review. Associations must respect project and data boundaries.

Intake preserves the distinction between reported behavior, observed failure, expected behavior, requested change, agreed scope, priority, and commitment. A client's report does not itself prove the cause or authorize the requested solution.

### 5.2 Deferred passengers

A deferred passenger remains durable and discoverable. It has a responsible owner, reason for deferral, final destination, outstanding obligations, and at least one meaningful wake condition or explicit review date.

Potential wake conditions include a linked ticket being selected or assigned, a relevant reply or new report, a dependency becoming available, a scheduled review date, and David's manual resume action. Their configuration is project-specific.

When a relevant change occurs, the product attaches it to the existing passenger, refreshes context, and evaluates whether a new decision or permitted next step is available. A backlog status transition must not create a second independent passenger for the same unresolved matter.

Reactivation does not restore expired approvals. Any next effect must pass current scope, policy, capability, and precondition checks.

### 5.3 Closed passengers and recurrence: proposed policy

- A duplicate or delayed event describing already-observed state is recorded or deduplicated without reopening work.
- Evidence that may contradict the closure moves the passenger into completion review and alerts David. Historical closure evidence remains intact; the current UI exposes the challenge to it. Investigation can proceed within read-only authority.
- If closure is shown to have been invalid, the original passenger resumes with a recorded explanation and refreshed approvals where needed.
- A genuinely new recurrence after verified resolution becomes a linked new passenger with a newly proposed destination. The earlier result and the recurrence relationship remain visible.
- An uncertain distinction between invalid closure and recurrence becomes a review decision; the product must not silently pick the interpretation that makes its history look better.

### 5.4 Delivery reliability and feedback loops

The product uses the supported event or reconciliation capabilities of each source. Webhook-only assumptions must not hide gaps. Linked-object cursors, coverage health, and bounded reconciliation follow ACP's contracts.

An event caused by the product's own action may confirm progress. It must not blindly generate new independent work. New evidence that expands an affected cohort or changes behavior invalidates any approval whose scope no longer matches.

## 6. Preparation and first decision

Before the first scope approval, the product can perform permitted read-only investigation and prepare internal drafts. Creating an external draft or tracker item is still an external effect and follows its applicable approval rules.

The initial review should answer:

1. What happened, and what was actually requested?
2. What has been established, and what remains uncertain?
3. What related work or prior decision already exists?
4. What outcome does the product recommend and why?
5. What is the expected impact of acting, waiting, or declining?
6. What will the approved plan attempt, and what later decisions remain?

The card contains an evidence-backed summary, proposed destination, acceptance brief, communication plan, impact and risk explanation, and clear alternatives where a decision is material. It must not require reading raw worker logs.

Specialist workers are used when they can resolve distinct questions or supply relevant verification. Every signal does not require a fixed committee of agents. Shared agreement is not a substitute for source evidence.

## 7. Journey steps, authority, and redesign

### 7.1 V1 authority

| Activity | V1 rule |
|---|---|
| Read-only investigation and internal preparation | Automatic within project capabilities and budgets. |
| Selecting or materially revising a final destination | David approves. |
| Implementation | Starts after approved scope and applicable ACP capability admission. |
| Tracker, message, PR, merge, or dev-deployment effects | Execute only with current approvals or an exact applicable approved envelope, required gates, and verification. |
| Every external client send | David reviews the exact recipients and content before sending. |
| Production deployment or database correction | Prepared and reviewed in the product; performed through an explicit manual handoff in V1. |
| Material redesign | Affected implementation pauses for a new product decision. |

An approved journey step may cover several fully understood dependent actions, but each action retains its own execution and verification record. Unprepared future changes are not covered by approving an outcome.

### 7.2 Reviewable effect proposal

A consequential proposal presents the exact intended change, target, scope, blast radius, preconditions, verification method, recovery approach, and uncertainty. Production database handoffs identify the selection criteria and observed cohort; uncertain or potentially affected users must be distinguished from confirmed affected users.

Blast radius includes relevant users, roles, workflows, records, environments, integrations, and shared components. A small code diff must not be treated as proof of a small impact.

### 7.3 Redesign decision

When a proposed solution substantially changes how the existing system works, particularly the frontend interaction, implementation for the affected passenger pauses until David confirms the decision. The product prepares:

- The existing behavior and the proposed behavior.
- Clearly highlighted differences and affected journeys.
- Evidence for the underlying need and the proposed solution.
- Tangible expected benefits, downsides, costs, dependencies, and blast radius.
- Alternatives and the consequences of retaining the existing behavior.
- A recommendation that clearly acknowledges when disadvantages outweigh advantages.
- A rationale suitable for explaining the decision to the requester.

Read-only clarification and proposal preparation may continue within budget. This pause must not silently authorize an alternative workaround or production change. Other unrelated passengers remain independently schedulable.

### 7.4 Editing and rejection

David may edit draft wording directly or give natural-language directions. Changes to behavior, scope, recipients, environment, candidate, cohort, or other material conditions produce a new proposal revision and invalidate affected approvals. The product must preserve prior versions.

Rejecting a solution records the decision and rationale while keeping the original problem visible. The product proposes an alternative, asks for an explicit deferral or decline, or reports that no supported alternative is available. Alternative exploration is bounded; rejection does not authorize endless investigation.

### 7.5 Partial and unknown outcomes

Journey steps are not assumed to be atomic across services. If a ticket update succeeds and a message fails, both states remain visible and the proposed recovery targets the unfinished action. Uncertain outcomes must be reconciled before retrying potentially duplicated effects. Approval is not success, and a manual done assertion is not an independent verification receipt.

## 8. Verification and evidence

The product derives a proposed acceptance brief and regression coverage from the request, approved project behavior, affected workflows, and implementation impact. David approves the intended outcome with the scope; detailed tests are prepared by agents.

A separate verification worker assesses the candidate against that brief. The implementing worker's report is evidence to examine, not sufficient acceptance by itself. Independence of roles does not guarantee correctness; required coverage and unresolved limitations remain visible.

For the membership-amendment example, candidate acceptance conditions include successful submission by the club, correct persistence of the amendment, and visibility to SZS for continuation of the intended process. These are proposed product-level conditions; the real project's authoritative workflow and permissions must determine the detailed coverage.

Relevant regression coverage should consider affected core journeys, user roles and access boundaries, existing data states, error paths, and the consistency of related records. Scope is based on impact, not only the original happy path.

### 8.1 Presentation

The product chooses screenshots, a recorded walkthrough, a preview application, structured observations, or an appropriate combination according to what must be demonstrated. Evidence identifies its environment, candidate, observation time, acceptance condition, and limitations.

Visual evidence demonstrates the behavior it actually shows. It must not be presented as proof that unseen regression, permission, or data-integrity checks passed. Evidence shown to David should be compact enough to review and sufficient to inspect the conclusion.

### 8.2 Incomplete evidence

An unperformed required check is verification incomplete, not passed. A failed required check is failed. The product continues bounded investigation or repair where authorized; otherwise it creates a blocker owned by David.

David's response may supply missing evidence, access, an approved scope change, or direction for another attempt. It does not silently convert an unexecuted check into a pass. V1 does not offer a blanket waive-all-testing action. A changed acceptance contract is a visible decision with its consequences and outstanding obligations preserved.

## 9. Communication plan

Every defined passenger has a proposed communication plan, approved with its destination. A plan may require no external messages, but that must be an explicit contextual choice with a reason.

Each plan item contains:

- Purpose and intended audience.
- Channel and proposed recipients or recipient-selection rule.
- Trigger, priority, and any approved timing requirement.
- Whether it is required, conditional, or optional.
- The facts that must be established before drafting or sending it.
- Draft, review, send, and delivery/verification state.
- Whether it is a final-destination completion condition.
- Any required response from the recipient and the waiting/escalation rule.

### 9.1 Contextual examples

| Context | Proposed plan |
|---|---|
| High-impact blockage of a core flow | Prompt acknowledgement, material updates when warranted, confirmation of the immediate unblock, and final resolution communication. |
| Small straightforward correction | One completion message may be sufficient. |
| Insufficient information | A specific clarification request, followed by a visible wait for the needed response. |
| Proposed redesign with unfavorable trade-offs | A reviewed explanation of the evidence, recommendation, and decision, with a suitable alternative where supported. |
| Backlog deferral | Communicate the deferral when context requires it; avoid inventing a delivery commitment. |

Urgent acknowledgement is proposed promptly but still requires send approval in V1. It may be approved before implementation or destination review is complete. Its wording must reflect current facts: receiving a report or investigating it does not justify claiming that a fix has started or promising a deadline.

For forwarded reports, the product recommends recipients from the established correspondence and project rules. It does not assume that contacting the original end user directly is appropriate.

Approval of a communication plan is not approval of unknown future message content. Each actual client send requires review of its exact recipients and text. A materially changed plan receives a new version. Superseded or unnecessary messages are explicitly disposed of rather than silently dropped.

Required communication failures keep closure pending. Duplicate provider events must not send duplicate acknowledgements. Lack of a reply counts as acceptance only if the approved contract explicitly defines such a rule; silence alone is not evidence of satisfaction.

## 10. Airport-management command center

The visual and interaction direction is a professional airport operations system: a live operations board, readable lanes and checkpoints, a focused secondary-review workspace, and visible exceptions. The [UX/UI specification](AIRPORT_UX_UI_SPECIFICATION.md) defines the proposed layout, typography, colors, wireframes, and screen-level acceptance conditions.

### 10.1 Information architecture and default view

Operations is the primary board, opening with Needs your decision selected. Supporting views expose Arrivals, Secondary review, Waiting, Completed, and Project readiness. All-active and other status filters remain available. This preserves the approved attention-first default while expressing the airport model.

Each passenger row shows a request identity and subject, project, request type, current checkpoint, approved or proposed final destination, exact state or waiting reason, next action and owner, relevant age, and communication due. Secondary columns can be revealed when screen space allows. Summary counts must be derived from actual records and identify their time window or filter.

A passenger waiting in backlog for production resolution must remain visibly waiting. A passenger whose technical outcome is verified but final reply is due must show Communication due. Administrative cancellation and consolidation remain distinguishable from verified arrival.

The operations board is the primary work surface. A journey diagram is a supplementary explanation of dependencies, not the only way to identify or act on a blocker.

### 10.2 Passenger detail and secondary review

Selecting a row opens a passenger workspace while preserving the board's filter, selection, and scroll context. Detail combines:

- Why this request exists, its evidence-backed recommendation, and the decision needed now.
- Passport/source provenance and project association.
- Approved destination and scope, with pending revisions clearly distinguished.
- A journey strip showing checkpoints passed, current, pending, blocked, and not required.
- A review surface for before/after behavior, blast radius, benefits and downsides, acceptance evidence, and exact proposed effects.
- Luggage/evidence with claim status, provenance, freshness, and limitations.
- Decisions, linked work, current candidate and environment observations, manual handoffs, and the communication plan.

The primary action names the exact effect or decision. Approving scope, approving a message, and approving a production handoff are separate controls. A review must preserve visible recipients, target environment, scope, and material uncertainty when its action is taken.

David can edit a draft directly, give natural-language directions, request investigation, reject a proposed solution, defer work, resolve a blocker, or inspect supporting evidence. Cancelling a passenger, changing its final destination, and declining the underlying request are separately named actions with visible consequences.

### 10.3 Checkpoint and permission display

Every displayed checkpoint has a condition, current status, evidence or missing-evidence explanation, and next owner. Use distinct states for Passed, Failed, Incomplete, Awaiting your decision, Waiting externally, and Not required.

Automated gates display the actual policy and conditions permitting passage. An approved human review remains visually distinguishable from a gate that required no new human action. A familiar sender must not receive a universal trusted-passenger badge that implies all requests are safe or permitted.

Screening does not become a fictional animated scan. The interface displays actual checks, findings, and progress only when supported by runtime events. Reaching a gate or boarding an execution run is not final arrival.

### 10.4 Unblocking flow

1. David opens secondary review and sees the missing condition, its consequence, attempted investigation, and the recommended resolving action.
2. The product offers the relevant interaction: provide context or evidence, answer a question, revise scope, authorize more investigation, or follow a specific external handoff.
3. David's response is recorded against the blocker and applicable proposal revision.
4. The product rechecks the relevant condition or applies the explicit product decision through the correct authority boundary.
5. Only eligible dependent work resumes; a failed recheck leaves a specific blocker.

Secrets use ACP's credential-management surface, never a general text answer or an audit note. Work performed outside the interface can be reported with a source reference or observed through a linked integration. The interface distinguishes operator-reported completion from independently verified completion.

### 10.5 Attention, live updates, and workload

Urgent production blockers may interrupt through a configured notification channel. Ordinary progress remains in Operations. Repeated unchanged blocker notifications are suppressed. Quiet-hours and urgency rules come from the approved project configuration.

Live updates show their freshness and meaningful change. A row must not jump away while David is reading or acting on it. If a material update invalidates the open proposal, the action is disabled and the changed condition is explained; a stale detail view must not allow approval of an outdated effect.

David can reprioritize or defer passengers. Correlated messages consolidate attention around the underlying matter. A returning ticket updates the same passenger and shows why it returned. Five simultaneous passengers should not require five open coding conversations to understand their next steps.

Budgets and host limits remain controlled by ACP, including Windows responsiveness. A visual capacity display must use actual admitted/queued work and configured capacity; it must not invent a flight schedule or an estimated completion time.

### 10.6 Accessibility and responsive operation

All actions are keyboard accessible with visible focus and meaningful labels. Tables expose understandable headers and detail associations. Status uses text and icons in addition to color. Updates do not steal focus or repeatedly announce unchanged states.

On narrow screens, prioritize the request, required decision, state, and final outcome. Passenger detail becomes a full-page workspace. Critical proposal context remains visible before authorization; responsive layout must not hide recipients, production targets, or known verification gaps. Reduced-motion preferences are respected.

## 11. Records, learning, and information boundaries

Decision records retain actor, time, reviewed proposal and destination revisions, evidence, rationale, affected scope, and any supersession. An incident remains the problem record; decisions explain choices made about it. A communication claiming completion must be traceable to the verified outcome it describes.

The product captures edits, acceptance, rejection, and subsequent outcomes for evaluation and improved recommendations. An approval alone is not proof that the recommendation was correct. Future rule suggestions require evidence and David's approval; V1 must not grant itself broader authority, automatically select final destinations, or apply its own policy upgrades.

Source content, personal data, credentials, raw recordings, and evidence retention follow ACP's project boundaries and retention policies. Use source references and minimal relevant excerpts; avoid duplicating entire mailboxes or sensitive attachments into passenger histories. A missing or expired artifact remains explicitly unavailable and is not treated as passed evidence.

## 12. ACP capabilities and readiness

| Capability | Product dependency and required behavior |
|---|---|
| Project profile and source authority | Establish expected behavior, scope authority, integrations, environments, roles, and budgets. Unknown readiness is visible. |
| Durable intake and context | Preserve signal identity, source provenance, related work, and versioned context across workers. |
| Gmail | Selected intake, scoped investigation, exact reviewed sends, delivery reconciliation, and source coverage health. |
| Existing project tracker | Read existing items, perform approved updates, and observe changes to linked deferred work. |
| GitHub and engineering workers | Preserve candidate identity, run approved implementation, read CI/PR state, and verify supported effects. |
| Development environment | Deploy the selected candidate through approved actions and provide appropriate verification access and test data. |
| Approval and effect services | Enforce scope, exact effect authority, drift checks, partial outcomes, and reconciliation. |
| Timers and subscriptions | Wake deferred work and wait for external outcomes without relying on an agent's conversation remaining alive. |
| Manual handoff and verification | Present exact production plans and distinguish operator actions from independently established results. |
| Console and audit | Provide the airport operations board, passenger journeys, secondary review, and editing experience while retaining authoritative runtime state and decision history. |

ACP foundation completion alone does not establish that every integration is ready. The implementation plan must pin the actual ACP candidate and inspect capability readiness. A missing capability becomes a visible prerequisite or a supported manual handoff, not an assumed implementation.

## 13. Rollout and evaluation

### 13.1 Preparation

Configure the SZS source label, source and tracker mappings, expected behavior references, dev environment, evidence access, recipients, notification channel, quiet hours, review triggers, and ACP budgets. Values not established in the interview are project-onboarding inputs, not invented defaults.

Use representative historical cases to check source grouping, diagnosis limits, proposed destinations, trade-off explanations, blockers, and communication plans. Historical replay must not perform live external effects.

### 13.2 Live pilot

Start with the approved project and source boundary. David approves destinations and scope, reviews consequential proposals, and performs the initial manual production handoffs. Track the same passenger through verification and communication.

Measure human attention spent on investigation preparation, review, corrections, execution handoffs, context recovery, and follow-up. Compare similar case classes and report the number of cases and measurement method. Do not claim the 50% target from a few incomparable examples.

Also measure missed or duplicated matters, substantive corrections, time to a prepared decision, waiting time, reopened outcomes, required checks that could not run, communication completion, verification gaps, and cost per accepted outcome. Record severe regressions and unapproved effects separately from the handling-time metric.

Pilot evaluation expects no unapproved effects or unexplained lost cases in the observed sample. This is not a guarantee of future zero failures. Any failure requires a specific disposition before expansion.

### 13.3 Operational limits

Investigation, repair attempts, model spending, and concurrency inherit explicit ACP budgets. Reaching a limit creates a clear checkpoint or blocker with the evidence so far and a recommended next action. V1 must not increase those limits for itself.

Source or execution capabilities can be paused while preserving passengers, approved contracts, completed effects, and obligations. Resuming a capability revalidates current authority and target state. Rollback or shutdown must not discard pending manual handoffs or unknown outcomes.

## 14. Observable acceptance scenarios

| ID | Scenario | Required result |
|---|---|---|
| ACP-PRODUCT-01 | Five independent emails arrive during an hour. | Each receives a durable disposition and traceable passenger or association; no source is silently lost. |
| ACP-PRODUCT-02 | Several sources concern the same unresolved problem. | They attach to one supported passenger; uncertain associations are reviewable. |
| ACP-PRODUCT-03 | One email contains independent requests. | The product can propose separate passengers while preserving the common source and avoiding lost subrequests. |
| ACP-PRODUCT-04 | A passenger is defined for production resolution. | David reviews a final destination, acceptance brief, plan, and communications before implementation. |
| ACP-PRODUCT-05 | Its ticket lands in backlog. | The passenger is deferred with its final destination intact; backlog is not successful closure. |
| ACP-PRODUCT-06 | That linked ticket is selected or a review date arrives. | The existing passenger receives the signal and returns for eligible work or attention without duplicate execution. |
| ACP-PRODUCT-07 | A candidate deploys to dev before required tests finish. | The UI shows deployment and pending validation separately; the production destination remains outstanding. |
| ACP-PRODUCT-08 | A required regression check cannot run. | Verification is incomplete; a specific blocker identifies what David can do. No pass is inferred. |
| ACP-PRODUCT-09 | David resolves the blocker externally. | The product records the report, rechecks the relevant condition, and resumes only eligible dependent work. |
| ACP-PRODUCT-10 | A repair requires a changed frontend journey. | A before/after, evidence-backed trade-off proposal is presented; implementation pauses for the decision. |
| ACP-PRODUCT-11 | David rejects that redesign. | The rejected proposal and rationale are preserved; the original problem remains explicitly active, deferred, or deliberately declined. |
| ACP-PRODUCT-12 | The individual reported case is unblocked. | Required root-cause, prevention, cohort-remediation, and communication obligations remain visible. |
| ACP-PRODUCT-13 | A production correction is needed. | V1 creates an exact reviewed manual handoff, records execution evidence, and verifies before advancing; it does not execute the mutation automatically. |
| ACP-PRODUCT-14 | A ticket action succeeds but a message response is lost. | The partial and unknown outcomes remain distinct; reconciliation precedes a potentially duplicate send. |
| ACP-PRODUCT-15 | A high-impact report needs acknowledgement. | The product prepares an appropriately urgent, factually supported message and obtains exact send approval. |
| ACP-PRODUCT-16 | The technical outcome is verified but final communication is due. | The final draft becomes actionable and closure stays pending until the required communication condition is met. |
| ACP-PRODUCT-17 | The approved contract explicitly requires no external communication. | The reason is visible and closure does not invent a message requirement. |
| ACP-PRODUCT-18 | All current approved destination conditions are met. | The passenger closes with its contract revision and evidence; tracker and deployment facts are not inferred from the closure alone. |
| ACP-PRODUCT-19 | A stale event arrives after closure. | It does not reopen completed work or duplicate an effect. |
| ACP-PRODUCT-20 | New evidence contradicts closure, or the issue genuinely recurs later. | The product distinguishes completion review from a linked new recurrence and exposes uncertainty about that distinction. |
| ACP-PRODUCT-21 | New evidence changes the approved cohort, recipients, or behavior. | The affected approvals become invalid and the exact revised proposal requires review. |
| ACP-PRODUCT-22 | A budget is exhausted or a capability becomes unavailable. | The passenger retains its evidence and obligations, exposes a specific blocker, and does not bypass the limit. |
| ACP-PRODUCT-23 | A worker or conversational task ends. | Passenger context, decisions, subscriptions, outstanding work, and verified results remain recoverable. |
| ACP-PRODUCT-24 | Repeated successful approvals accumulate. | They inform evaluation and recommendations without automatically expanding destination-selection or execution authority. |
| ACP-PRODUCT-25 | A known sender submits a request without the required effect authority. | Passport/source identity does not bypass visa/permission or risk checks. |
| ACP-PRODUCT-26 | An operator opens the airport-style command center. | Operations opens with Needs your decision selected and distinguishes current checkpoint from final destination. |
| ACP-PRODUCT-27 | A support question needs no engineering execution. | Its route can reach the approved outcome without a fictional flight or unnecessary engineering checkpoints. |
| ACP-PRODUCT-28 | A check is skipped, unavailable, or not required. | Its actual state remains distinct from Passed in both the operations board and passenger detail. |
| ACP-PRODUCT-29 | A policy permits an automated gate. | The UI identifies the permitting conditions while preserving V1 destination, send, and production boundaries. |
| ACP-PRODUCT-30 | A material event arrives while an effect proposal is open. | The proposal explains the drift, disables stale approval, and preserves the operator's board context. |
| ACP-PRODUCT-31 | A passenger is inspected on a narrow screen or by keyboard. | The required decision, exact effect context, final outcome, and evidence limitations remain accessible. |
| ACP-PRODUCT-32 | An airport-themed UI is shown with no live runtime activity. | It does not fabricate scan progress, flight times, capacity figures, or operational success. |

## 15. Traceability to the accepted recommendations

| Interview item | Specification coverage |
|---|---|
| 1. Initial scope | Sections 1, 2, 12, 13 |
| 2. One underlying matter per passenger | Sections 3 and 5 |
| 3. Preparation before approval | Sections 6 and 7 |
| 4. V1 execution and manual production | Sections 2, 7, 12 |
| 5. Destinations, refined to include returning intermediate work | Sections 4 and 5 |
| 6. Testing and evidence | Section 8 |
| 7. Editing and rejection | Sections 7 and 10 |
| 8. Blocker resolution | Sections 8 and 10 |
| 9. Closure, refined to an approved final destination | Section 4 |
| 10. Communication, refined to a contextual plan per passenger | Section 9 |
| 11. Command center and attention | Section 10 |
| 12. Records and learning | Section 11 |
| 13. Limits and pilot success | Section 13 |

## 16. Remaining review and implementation readiness

The airport model, airport-management visual direction, and earlier product decisions are approved directions. The current product name is ACP until David selects a replacement. This draft and its UX/UI companion make that direction concrete without claiming an implemented live interface.

Review should focus on the proposed destination taxonomy and recurrence distinctions from version 0.1, and the specific checkpoint vocabulary, board density, visual tokens, and interaction details in the companion. These are design proposals for evaluation, not newly asserted historical user decisions.

Implementation planning must pin the actual ACP capability baseline, resolve project-onboarding inputs, and map the acceptance scenarios to concrete checks. The first UI prototype should demonstrate the operations board and one complete secondary-review flow using clearly labeled illustrative data before it claims live control.

This specification defines intended product behavior. It does not claim that the product, its UI, its adapters, or the referenced incident repair have been implemented or tested.
