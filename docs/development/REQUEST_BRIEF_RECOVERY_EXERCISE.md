# Synthetic request-brief recovery exercise

This offline developer exercise compares the retained history-only fixture with the
brief produced by the real private read coordinator and assembler. It is synthetic
test evidence, not a benchmark, fresh-reader acceptance, live binding, or a product
outcome. It makes no provider/model calls and writes JSON only to standard output.

Run under Node.js 24 from the repository root:

```bash
node --experimental-strip-types scripts/evaluate-request-brief-recovery.mjs
```

The fixture separately records retained sources and the expected fact inventory.
The evaluator checks exact request/mission IDs, original wording, source pins and
coverage, the decisive scoped-retrieval-or-gap detail, stale/missing observations,
changed source pins, pagination overflow, unavailable decisions/obligations/
communications and unavailable next-action authority. Negative controls alter the
wording and remove decisive attention/change content; each must lose its matching
fact. This avoids scoring an authored summary against itself.

Metrics are deliberately narrow: `readerCalls` is actual synthetic reader
invocations, `returnedUtf8Bytes` is the UTF-8 size of returned JSON, and
`harnessLatencyMs` is local harness elapsed time. They are not human recovery time,
worker task openings, token/cost savings, or accepted outcomes. Model, coordinator,
worker, retry and escalation usage are unavailable because none is invoked. Latency
varies by machine; do not derive or hard-code a speedup.

## Later fresh-reader protocol (not executed)

1. Freeze the fixture revision, expected-fact inventory, question sheet and limits;
   conceal expected answers from genuinely fresh readers.
2. Randomly assign history-only or assembled-brief input, then ask readers to list
   identity, exact wording, known observations, decisive missing information,
   evidence retrieval needed, overflow and authority limits. Allow only scoped
   evidence reads exposed by that input and record each opening.
3. Independently grade exact fact recovery, unsupported claims, explicit gaps,
   scoped source openings, elapsed human time and rework. A decisive omission,
   invented absence/authority, or failure to retrieve/declare the attachment gap
   fails that response. Report sample size and disagreements, not a speedup claim.
4. Keep human time distinct from harness latency and task openings distinct from
   synthetic reader calls. Capture coordinator/worker/retry/escalation/model usage
   only if those components are actually used, and mark incomplete totals partial.

This protocol has **not** been executed. One synthetic case cannot establish human
or fresh-worker performance, statistical advantage, product acceptance, current
freshness, or production readiness. Generated outputs must remain outside Git.
