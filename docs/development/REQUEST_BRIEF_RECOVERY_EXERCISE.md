# Synthetic request-brief recovery exercise

This offline developer exercise compares the retained history-only fixture with the
brief produced by the real private read coordinator and assembler. It is synthetic
test evidence, not a benchmark, fresh-reader acceptance, live binding, or a product
outcome. It makes no provider/model calls and writes JSON only to standard output.

Run under Node.js 24 from the repository root:

```bash
node --experimental-strip-types scripts/evaluate-request-brief-recovery.mjs
```

Separate modules independently author retained sources and the expected fact
inventory. Field-specific structural checks cover exact project/request/mission IDs,
original wording, scoped references and independently reviewed canonical fixture
pins (canonical source fingerprints excluding only volatile `asOf`), coverage, the decisive explicit
unavailable-evidence gap, observed-but-unassessed and missing observations,
changed source pins, pagination overflow, unavailable decisions/obligations/
communications and unavailable next-action authority. Negative controls alter the
wording and remove decisive attention/change content; each must lose its matching
fact. This avoids scoring an authored summary against itself.

Metrics are deliberately narrow and separately recorded for both paths:
`sourceReaderCalls` counts actual synthetic source-reader invocations,
`cumulativeSourceReturnedUtf8Bytes` sums every actual source response, and
`resultUtf8Bytes` measures the final history or brief delivered to the reader.
`harnessLatencyMs` is local harness elapsed time. They are not human recovery time,
worker task openings, token/cost savings, or accepted outcomes. Model, coordinator,
worker, retry and escalation usage are unavailable because none is invoked. Latency
varies by machine; do not derive or hard-code a speedup.

## Later fresh-reader protocol (not executed)

1. Freeze the fixture revision, expected-fact inventory, question sheet and limits;
   conceal expected answers from genuinely fresh readers.
2. Enrol at most six readers (three per input), allow at most 15 minutes and three
   scoped source openings per reader, and randomly assign history-only or assembled-
   brief input. Ask readers to list
   identity, exact wording, known observations, decisive missing information,
   evidence retrieval needed, overflow and authority limits. Allow only scoped
   evidence reads exposed by that input and record each opening.
3. Stop a reader at the first of 15 minutes, a fourth attempted opening, task
   completion, withdrawal, or any request for unavailable authority. Independently
   grade exact fact recovery, unsupported claims, explicit gaps,
   scoped source openings, elapsed human time and rework. A decisive omission,
   invented absence/authority, or failure to retrieve/declare the attachment gap
   fails that response. Report sample size and disagreements, not a speedup claim.
4. Stop the exercise after six completed/terminated attempts or immediately for a
   fixture leak, grading-key exposure, unsafe authority claim, or protocol deviation.
   Keep human time distinct from harness latency and task openings distinct from
   synthetic reader calls. Capture coordinator/worker/retry/escalation/model usage
   only if those components are actually used, and mark incomplete totals partial.

This protocol has **not** been executed. One synthetic case cannot establish human
or fresh-worker performance, statistical advantage, product acceptance, current
freshness, or production readiness. Generated outputs must remain outside Git.
