# ACP Operations prototype

Mode: Operate. Audience: David managing concurrent SloSki requests.

Open `index.html` in a browser. It is a standalone, dependency-free UI prototype;
no server, install, login or credentials are needed. All cases and evidence are
synthetic. State exists only in the page and resets on reload. Content Security
Policy disables network connections, form submissions and third-party resources.

The user-pinned airport-operations direction is implemented as an aligned request
board, adjacent review desk and a selected request's named journey strip. The
primary action stays beside exact scope and the simulation boundary. No decorative
animation, fabricated capacity, flight schedule or live clock is used.

## Try the review flow

1. Inspect EX-001's proposed outcome, scope, uncertainty and outstanding obligations.
2. Edit scope and save a new sample revision; inspect earlier revisions under
   Journey & record. Approve the exact current revision in the simulation.
3. Reset and reject the solution with a reason. The original request stays open.
4. Under the board, simulate changed scope. Approval is disabled until the revised
   proposal is loaded. It remains unapproved until a separate simulated decision.
5. EX-002 keeps role verification incomplete after an operator evidence report.
6. EX-003 demonstrates communication due and an unknown send response. No actual
   message is sent, and the duplicate-send control is disabled.
7. Open Waiting and simulate the linked-ticket return. EX-004 retains its identity.
8. Search for a nonexistent request and simulate a source gap; no live absence
   conclusion is presented. Test the board and review on a narrow viewport too.

## Scope and retention

Retain this prototype and its checks for David's review. It is not production
console code or a source of runtime authority. Production work requires a fresh
implementation boundary using the specified Next.js console, operator identity,
durable request/proposal contracts and real evidence-backed control endpoints.
Closure/recurrence policy remains proposed; the completed example is illustrative.

The prototype evaluates interaction, not adoption, correctness of a real incident
diagnosis, authenticated approvals, persistence, delivery or a live pilot's success.
No first-prototype code is automatically promoted to the production runtime.

## Checks

`npm run test:operations-prototype` runs the twelve state-model checks. These are
also included in the sequential root `npm test` suite.

Browser checks use an already installed Playwright module supplied explicitly as
`ACP_PLAYWRIGHT_MODULE`; they install nothing, deny HTTP(S) requests, use local file
URLs and close their owned browser. Root gates remain separate and sequential.
Run `node prototypes/operations/browser-check.mjs` with that module path configured.
Set `ACP_PROTO_CAPTURE=1` to also retain desktop/mobile screenshots under
`.impeccable/review/`. The check uses an installed Microsoft Edge browser. Run it
inside the repository's bounded process wrapper on this Windows host; do not
overlap it with another heavy gate. Generated review evidence is ignored by Git.

The samples exercise parts of the acceptance scenarios, not whole production
acceptance. In particular, an evidence report does not perform the recheck required
by ACP-PRODUCT-09; the unknown-send sample does not perform ACP-PRODUCT-14's tracker
effect; and scope review does not create a durable acceptance contract. See the
[review evidence and limits](../../docs/implementation/OPERATIONS_PROTOTYPE_REVIEW.md).
David's usability acceptance and all production implementation remain separate.
