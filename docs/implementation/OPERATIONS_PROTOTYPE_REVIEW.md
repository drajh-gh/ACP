# Operations prototype — review evidence

Date: 2026-09-06. Candidate: local, uncommitted P1 prototype on published
`85a137818e964065a1783fc825053cecfaadb10f`. This record is not approval of a
production contract, live integration or pilot outcome.

Open [the prototype](../../prototypes/operations/index.html) in a browser and follow
the [eight review exercises](../../prototypes/operations/README.md). It has five
authored EX requests, no persistence, no provider connection and no live authority.

## Verification

| Gate | Observed result and limit |
|---|---|
| State-model tests | 12 passed. Initial behavior tests were RED before implementation; two journey regressions failed before the review fix and passed afterward. |
| Final root regression suite | 786 tests / 35 suites passed, zero skipped or failed, with sequential test-file execution. Local output: `.impeccable/review/regression.txt`. |
| Browser behavior | 15 check groups passed in installed headless Edge, using local file URLs and denied HTTP(S). Covers revisions, rejection, both draft guards, unknown send, incomplete verification, return identity, keyboard/dialog focus, revealed editors and exact narrow decision context. |
| Responsive behavior | No page overflow at widths 1440, 1100, 1024, 720, 390 and 320. Narrow action placement is checked against the full review-content bounds. Reduced-motion preference enabled. |
| Contrast / connection bounds | Declared foreground pairs on ink/panel meet 4.5:1; this is not a full accessibility audit. CSP denies connections; attempted fetch fails; no authored remote requests or page script errors observed. |
| Type check and secret scan | Passed. The secret scan is not a privacy review of the supplied product-interview documents. |
| Mechanical design detector | Ran once; degraded regex fallback returned no findings. Missing optional parsers prevent full selector/property/contrast inspection, so this is not detector clearance. |
| Visual and source review | Two screenshot rounds. Fresh read-only reviewer identified five fixes, then scored all five resolved with disposition `ship`. The verdict covers those fixes, not whole-surface or product-owner acceptance. |

All heavy checks ran sequentially inside bounded Windows kill-on-close process jobs;
owned browser/test process trees were terminated or exited and verified empty.
No long-running preview server is needed. Review images and test output are local,
Git-ignored artifacts under `.impeccable/review/`.

The five resolved findings were: mobile actions obscuring scope; board/journey stage
disagreement; draft loss through source-gap or revised-proposal controls; editors
opening outside visible focus; and omitted checkpoint, owner and age in detail.
The harness did not expose typed shipped Impeccable agents: a fresh generic subagent
followed the supplied finish-reviewer fallback contract, and another drafted the
design-system files read-only for the root writer.

## Product acceptance remains separate

The samples demonstrate parts of ACP-PRODUCT-04/05/06/08/09/11/14/16/21/26/28/30/31/32
and UX-01/02/04/05/07/09/10/11/12/13/14/15/16. They do not pass those entire production
scenarios. No durable request, acceptance contract, independent recheck, tracker
effect, delivery receipt, live update, automatic resume or authenticated approval
is created. Source identity, failure states and complete communication/closure
contracts need fuller production coverage.

David still needs to judge decision clarity, board density, checkpoint wording,
scope editing/rejection, visibility of outstanding work, and mobile navigation.
Final-outcome taxonomy, exact closure conditions and recurrence policy remain open.
The [selected delivery sequence](PRODUCT_SLICE.md) places durable implementation
and a configured SloSki pilot after those relevant gates.

## Exact reviewed files

SHA-256 hashes identify the checked local artifacts independently of a future
commit. Paths below are relative to `prototypes/operations/`.

| File | SHA-256 |
|---|---|
| index.html | `AB093C58857993B8C1A22A50AE643AEBAFB552648D2E376B3216F90CCC7673EF` |
| styles.css | `F9B756D670384380319FB4E05BCD936ED043C5ADEC074BE8718DEB600207025E` |
| app.js | `D54A30E408617E98A0771D1AB677E809DF63928500502916AD051834B17BB471` |
| model.js | `14902B4EDC4129C500D22E10F1DB8997589159CE3138A2F5362C02933D8F4848` |
| model.test.mjs | `F739952BB1CDB4D795F4F662B28C234FE3CA3608E67BF052167BEAF393F0D207` |
| browser-check.mjs | `06ACDFDB0A95EAE0EE48D06BD3DF05D698D43A678FB5C75F827C123332D4FA2D` |
