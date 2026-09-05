import assert from "node:assert/strict";
import { it } from "node:test";
import { createStableId, type CompletionEvaluation } from "@acp/domain";
import { parseCounterpartMissionStatus } from "../src/counterpart-status.ts";
import { statusFixture } from "./fixtures/counterpart-status.ts";

it("mission status preserves microsecond timestamps and unobserved dimensions without fabricated defaults",()=>{
  const input=statusFixture(); assert.deepEqual(parseCounterpartMissionStatus(input),input);
  assert.notEqual(parseCounterpartMissionStatus(input),input);
});

const observation=()=>({ recordId:createStableId("event"),observedAt:"2026-09-06T00:00:30.123456+00:00" });
function observedFixture() {
  const base=statusFixture(),evidenceId=createStableId("evidence");
  return { ...base,lifecycle:{
    candidate:{ state:"merged",candidateId:createStableId("candidate"),observation:observation(),revision:{
      repositoryId:createStableId("repository"),worktreePath:"C:\\status-fixture",branch:"feature/ExactCase",headSha:"a".repeat(40),evidenceIds:[evidenceId] } },
    deployments:[{ environment:"production",state:"failed",artifactVersion:{ status:"unknown" },observation:observation(),evidenceIds:[evidenceId] }],
    acceptance:{ state:"passed",candidateRevision:"b".repeat(40),evidenceIds:[evidenceId],observation:observation() },
    tracker:{ adapterId:"test-tracker",externalId:"ITEM-1",nativeState:"On development",semanticCategory:"on_development",sourceVersion:"revision:2",observation:observation() },
    effects:[{ effectId:createStableId("effect"),state:"unknown_outcome" }],
    businessCompletion:{ state:"pending",evidenceIds:[evidenceId],observation:observation() },
  },evidence:[{ evidenceId,observedAt:"2026-09-05T00:00:00.000001+00:00",freshness:"stale",accessibility:"inaccessible" }] };
}
function evaluationFor(input:Pick<ReturnType<typeof statusFixture>,"missionId"|"completionContractId"|"completionContractVersion">):CompletionEvaluation {
  return { evaluationId:createStableId("completionEvaluation"),missionId:input.missionId,
    contract:{ id:input.completionContractId,version:input.completionContractVersion },status:"passed",
    evaluatedAt:"2026-09-06T00:00:10.123456+00:00",reasons:[],disqualifiers:[],requiredReceiptsVerified:true,evidenceFreshnessVerified:true,
    lifecycleDigest:"c".repeat(64),provenanceId:createStableId("provenance") };
}
it("recorded lifecycle dimensions disagree without being rewritten to match scoped mission completion",()=>{
  const base=observedFixture(),applied=evaluationFor(base),latest={ ...applied,evaluationId:createStableId("completionEvaluation"),
    status:"failed",evaluatedAt:"2026-09-06T00:00:40.123456+00:00",disqualifiers:["Recorded production verification failed."] };
  const input={ ...base,state:"complete_for_scope",completion:{ appliedEvaluationId:applied.evaluationId,appliedEvaluation:applied,latestEvaluation:latest } };
  const parsed=parseCounterpartMissionStatus(input);
  assert.deepEqual(parsed,input); assert.equal(parsed.lifecycle.deployments[0]?.state,"failed");
  assert.equal(parsed.lifecycle.acceptance?.candidateRevision,"b".repeat(40)); assert.equal(parsed.evidence[0]?.freshness,"stale");
  assert.notEqual(parsed.completion.appliedEvaluation?.evaluationId,parsed.completion.latestEvaluation?.evaluationId);
  base.lifecycle.candidate.revision.evidenceIds.length=0; assert.equal(parsed.lifecycle.candidate?.revision.evidenceIds.length,1);
});
it("observed defaults are not confused with unobserved dimensions or unknown artifact identity",()=>{
  const input={ ...statusFixture(),lifecycle:{ ...statusFixture().lifecycle,
    acceptance:{ state:"pending",evidenceIds:[],observation:observation() },
    businessCompletion:{ state:"not_evaluated",evidenceIds:[],observation:observation() },
    deployments:[{ environment:"staging",state:"verified",artifactVersion:{ status:"unknown" },evidenceIds:[],observation:observation() }],
    tracker:{ adapterId:"test",externalId:"1",nativeState:"Unmapped custom state",sourceVersion:"v1",observation:observation() },
  } };
  assert.deepEqual(parseCounterpartMissionStatus(input),input);
});
it("expired recorded acceptance waivers are reported historically without renewed approval",()=>{
  const base=observedFixture(),input={ ...base,lifecycle:{ ...base.lifecycle,acceptance:{ state:"waived",candidateRevision:"b".repeat(40),
    evidenceIds:base.lifecycle.acceptance.evidenceIds,observation:observation(),waiver:{ authority:"test:operator",reason:"Historical bounded exception.",
      candidateRevision:"b".repeat(40),scope:"Exact old candidate.",waivedAt:"2026-09-04T00:00:00Z",expiresAt:"2026-09-05T00:00:00Z" } } } };
  assert.deepEqual(parseCounterpartMissionStatus(input),input);
});
it("status rejects missing exact applied completion identity and cross-mission evaluation metadata",()=>{
  const base=statusFixture(),applied=evaluationFor(base);
  assert.throws(()=>parseCounterpartMissionStatus({ ...base,state:"complete_for_scope" }),/applied/u);
  for(const changed of [{ ...applied,missionId:createStableId("mission") },{ ...applied,status:"failed" },
    { ...applied,requiredReceiptsVerified:false },{ ...applied,evidenceFreshnessVerified:false },{ ...applied,evaluationId:createStableId("completionEvaluation") }]) {
    assert.throws(()=>parseCounterpartMissionStatus({ ...base,state:"complete_for_scope",completion:{ appliedEvaluationId:applied.evaluationId,
      appliedEvaluation:changed,latestEvaluation:applied } }));
  }
  assert.throws(()=>parseCounterpartMissionStatus({ ...base,completion:{ ...base.completion,latestEvaluation:{ ...applied,contract:{ ...applied.contract,version:"2.0.0" } } } }),/pinned contract/u);
});
it("status rejects malformed or missing observation/evidence identity rather than falling back",()=>{
  const base=observedFixture();
  for(const field of ["candidate","acceptance","tracker","businessCompletion"] as const) {
    assert.throws(()=>parseCounterpartMissionStatus({ ...base,lifecycle:{ ...base.lifecycle,[field]:{ ...base.lifecycle[field],observation:undefined } } }));
  }
  assert.throws(()=>parseCounterpartMissionStatus({ ...base,evidence:[] }),/selected evidence/u);
  assert.throws(()=>parseCounterpartMissionStatus({ ...base,evidence:[...base.evidence,...base.evidence] }),/selected evidence/u);
  assert.throws(()=>parseCounterpartMissionStatus({ ...base,evidence:[{ ...base.evidence[0],evidenceId:createStableId("evidence") }] }),/selected evidence/u);
});
it("status bounds UTF-8 bytes, collections and duplicate identities without silent truncation",()=>{
  const base=statusFixture(),effect={ effectId:createStableId("effect"),state:"verified" };
  assert.throws(()=>parseCounterpartMissionStatus({ ...base,requestedScope:"ž".repeat(40000) }),/bounded snapshot/u);
  assert.throws(()=>parseCounterpartMissionStatus({ ...base,lifecycle:{ ...base.lifecycle,effects:Array.from({ length:201 },()=>({ ...effect,effectId:createStableId("effect") })) } }),/bounded snapshot/u);
  assert.throws(()=>parseCounterpartMissionStatus({ ...base,lifecycle:{ ...base.lifecycle,effects:[effect,effect] } }),/unique identities/u);
});
it("status cannot claim assessed freshness, conflict freedom or new execution authority",()=>{
  const base=statusFixture();
  assert.throws(()=>parseCounterpartMissionStatus({ ...base,authorizationGranted:true }),/unexpected fields/u);
  assert.throws(()=>parseCounterpartMissionStatus({ ...base,assessment:{ ...base.assessment,freshness:"verified" } }));
  assert.throws(()=>parseCounterpartMissionStatus({ ...base,assessment:{ ...base.assessment,conflicts:"none" } }));
});
it("status requires explicit null and exact nested shapes rather than silently normalizing unknown fields",()=>{
  const base=observedFixture();
  for(const field of ["candidate","tracker"] as const) {
    assert.throws(()=>parseCounterpartMissionStatus({ ...base,lifecycle:{ ...base.lifecycle,[field]:undefined } }));
  }
  for(const field of ["candidate","acceptance","tracker","businessCompletion"] as const) {
    assert.throws(()=>parseCounterpartMissionStatus({ ...base,lifecycle:{ ...base.lifecycle,[field]:{ ...base.lifecycle[field],rawContent:"must not enter status" } } }));
  }
  assert.throws(()=>parseCounterpartMissionStatus({ ...base,lifecycle:{ ...base.lifecycle,candidate:{ ...base.lifecycle.candidate,
    revision:{ ...base.lifecycle.candidate.revision,rawContent:"unexpected" } } } }));
  for(const field of ["deployments","effects"] as const) {
    assert.throws(()=>parseCounterpartMissionStatus({ ...base,lifecycle:{ ...base.lifecycle,[field]:[{ ...base.lifecycle[field][0],rawContent:"unexpected" }] } }));
  }
});
it("latest evaluation cannot omit or contradict the immutable applied record or sort before it",()=>{
  const base=statusFixture(),applied=evaluationFor(base);
  for(const latest of [null,{ ...applied,status:"failed" },{ ...applied,evaluationId:createStableId("completionEvaluation"),
    evaluatedAt:"2026-09-06T00:00:10.123455+00:00" }]) {
    assert.throws(()=>parseCounterpartMissionStatus({ ...base,state:"complete_for_scope",completion:{ appliedEvaluationId:applied.evaluationId,
      appliedEvaluation:applied,latestEvaluation:latest } }));
  }
});
it("status rejects an over-limit environment set without silently dropping environments",()=>{
  const base=statusFixture();
  assert.throws(()=>parseCounterpartMissionStatus({ ...base,lifecycle:{ ...base.lifecycle,deployments:Array.from({ length:51 },(_,i)=>({
    environment:`environment-${i}`,state:"not_deployed",artifactVersion:{ status:"unknown" },evidenceIds:[],observation:observation(),
  })) } }),/bounded snapshot/u);
});
it("latest current-format evaluations require coherent pass/fail verification metadata",()=>{
  const base=statusFixture(),current=evaluationFor(base);
  for(const latest of [{ ...current,requiredReceiptsVerified:false },{ ...current,evidenceFreshnessVerified:false },
    { ...current,status:"failed",disqualifiers:[] }]) {
    assert.throws(()=>parseCounterpartMissionStatus({ ...base,completion:{ ...base.completion,latestEvaluation:latest } }),/evaluation/u);
  }
});
it("exact migration-backfilled evaluations remain historical without becoming applied completion authority",()=>{
  const base=statusFixture(),current=evaluationFor(base),legacy={ ...current,requiredReceiptsVerified:false,evidenceFreshnessVerified:false,
    lifecycleDigest:`legacy-unverified:${current.evaluationId}` };
  for(const status of ["passed","failed"] as const) {
    const input={ ...base,completion:{ ...base.completion,latestEvaluation:{ ...legacy,status } } };
    assert.deepEqual(parseCounterpartMissionStatus(input),input);
  }
  assert.throws(()=>parseCounterpartMissionStatus({ ...base,state:"complete_for_scope",completion:{ appliedEvaluationId:legacy.evaluationId,
    appliedEvaluation:legacy,latestEvaluation:legacy } }),/applied/u);
});
it("reserved legacy markers cannot be forged into verified current or applied evaluations",()=>{
  const base=statusFixture(),current=evaluationFor(base),marker=`legacy-unverified:${current.evaluationId}`;
  for(const latest of [{ ...current,lifecycleDigest:marker },{ ...current,lifecycleDigest:marker,requiredReceiptsVerified:false },
    { ...current,requiredReceiptsVerified:false,evidenceFreshnessVerified:false,lifecycleDigest:`legacy-unverified:${createStableId("completionEvaluation")}` }]) {
    assert.throws(()=>parseCounterpartMissionStatus({ ...base,completion:{ ...base.completion,latestEvaluation:latest } }),/legacy/u);
  }
});
