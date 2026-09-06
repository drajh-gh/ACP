import {
  assertLifecyclePacketVersion,expectArray,expectBoolean,expectEnum,expectIsoTimestamp,expectOnlyKeys,expectRecord,expectString,
  parseLifecycleVector,parseStableId,
  type AcceptanceLifecycle,type BusinessCompletionLifecycle,type CandidateLifecycle,type CompletionEvaluation,
  type DeploymentLifecycle,type EffectLifecycle,type StableId,type TrackerLifecycle,
} from "@acp/domain";
import { counterpartMissionMaximumBytes, counterpartMissionCollectionLimit, parseCounterpartMissionSummaryFields,
  parseCounterpartMissionNodes, snapshotCounterpartMissionData, type CounterpartMissionProjection } from "./counterpart-mission-projection.ts";

export const counterpartStatusMaximumBytes=counterpartMissionMaximumBytes;
export const counterpartStatusCollectionLimit=counterpartMissionCollectionLimit;
export const counterpartStatusEnvironmentLimit=50;

export interface CounterpartStatusEvidence {
  readonly evidenceId:StableId<"evidence">;
  readonly observedAt:string;
  readonly freshness:"current"|"stale"|"unknown";
  readonly accessibility:"available"|"inaccessible"|"missing"|"malformed"|"unknown";
}
export interface CounterpartMissionStatus extends CounterpartMissionProjection {
  readonly statusSchemaVersion:"1.0.0";
  readonly asOf:string;
  readonly lifecycle:{
    readonly candidate:CandidateLifecycle|null;
    readonly deployments:readonly (DeploymentLifecycle&{ readonly evidenceIds:readonly StableId<"evidence">[] })[];
    readonly acceptance:AcceptanceLifecycle|null;
    readonly tracker:TrackerLifecycle|null;
    readonly effects:readonly EffectLifecycle[];
    readonly businessCompletion:BusinessCompletionLifecycle|null;
  };
  readonly completion:{
    readonly appliedEvaluationId:StableId<"completionEvaluation">|null;
    readonly appliedEvaluation:CompletionEvaluation|null;
    readonly latestEvaluation:CompletionEvaluation|null;
  };
  readonly assessment:{ readonly kind:"recorded_only";readonly freshness:"not_assessed";readonly conflicts:"not_assessed" };
  /** Recorded metadata only, never source text, paths, raw evidence or permission. */
  readonly evidence:readonly CounterpartStatusEvidence[];
}

/** Recorded, bounded and normalized metadata. No live completion evaluation,
 * mutation, authority renewal, inferred freshness or invented absent state. */
export function parseCounterpartMissionStatus(value:unknown):CounterpartMissionStatus {
  const input=exact(snapshotCounterpartMissionData(value),["missionId","projectId","state","requestedScope","workflowId","workflowVersion","completionContractId",
    "completionContractVersion","createdAt","updatedAt","nodes","statusSchemaVersion","asOf","lifecycle","completion","assessment","evidence"],"status");
  const summary=parseCounterpartMissionSummaryFields(input),nodes=parseCounterpartMissionNodes(input.nodes);
  const { missionId,state,completionContractId,completionContractVersion }=summary;
  const completion=exact(input.completion,["appliedEvaluationId","appliedEvaluation","latestEvaluation"],"status.completion");
  const appliedEvaluationId=completion.appliedEvaluationId===null ? null : parseStableId(completion.appliedEvaluationId,"completionEvaluation");
  const appliedEvaluation=evaluation(completion.appliedEvaluation),latestEvaluation=evaluation(completion.latestEvaluation);
  for(const item of [appliedEvaluation,latestEvaluation]) {
    if(item && (item.missionId!==missionId || item.contract.id!==completionContractId || item.contract.version!==completionContractVersion)) {
      throw new TypeError("status evaluation does not match its mission and pinned contract");
    }
  }
  if((state==="complete_for_scope")!==(appliedEvaluationId!==null)
    || (appliedEvaluationId===null)!==(appliedEvaluation===null)
    || (appliedEvaluation && (appliedEvaluation.evaluationId!==appliedEvaluationId || appliedEvaluation.status!=="passed"
      || appliedEvaluation.lifecycleDigest.startsWith("legacy-unverified:")
      || appliedEvaluation.disqualifiers.length!==0 || !appliedEvaluation.requiredReceiptsVerified || !appliedEvaluation.evidenceFreshnessVerified))) {
    throw new TypeError("status requires the exact applied passing completion evaluation");
  }
  if(appliedEvaluation) {
    if(!latestEvaluation || (latestEvaluation.evaluationId===appliedEvaluation.evaluationId
      && JSON.stringify(latestEvaluation)!==JSON.stringify(appliedEvaluation))
      || (latestEvaluation && (microseconds(latestEvaluation.evaluatedAt)<microseconds(appliedEvaluation.evaluatedAt)
        || (microseconds(latestEvaluation.evaluatedAt)===microseconds(appliedEvaluation.evaluatedAt)
          && latestEvaluation.evaluationId<appliedEvaluation.evaluationId)))) {
      throw new TypeError("latest status evaluation contradicts retained applied evaluation or ordering");
    }
  }
  const lifecycle=exact(input.lifecycle,["candidate","deployments","acceptance","tracker","effects","businessCompletion"],"status.lifecycle");
  const deploymentInputs=array(lifecycle.deployments,counterpartStatusEnvironmentLimit),effectInputs=array(lifecycle.effects);
  if(lifecycle.candidate!==null) {
    const c=exact(lifecycle.candidate,["candidateId","state","observation","revision"],"status.candidate");
    exact(c.revision,["repositoryId","worktreePath","branch","headSha","evidenceIds"],"status.candidate.revision");
  }
  if(lifecycle.acceptance!==null) {
    const a=shape(lifecycle.acceptance,["state","evidenceIds","observation"],["candidateRevision","waiver"],"status.acceptance");
    if(a.waiver!==undefined) shape(a.waiver,["authority","reason","candidateRevision","scope","waivedAt"],["expiresAt","tolerance"],"status.waiver");
  }
  if(lifecycle.tracker!==null) shape(lifecycle.tracker,["adapterId","externalId","nativeState","sourceVersion","observation"],["semanticCategory"],"status.tracker");
  if(lifecycle.businessCompletion!==null) exact(lifecycle.businessCompletion,["state","evidenceIds","observation"],"status.businessCompletion");
  for(const d of deploymentInputs) exact(d,["environment","state","artifactVersion","evidenceIds","observation"],"status.deployment");
  for(const e of effectInputs) exact(e,["effectId","state"],"status.effect");
  // Reuse lifecycle syntax checks with validation-only defaults. Those defaults
  // never escape: missing observations remain explicit null in the status DTO.
  const parsed=parseLifecycleVector({ mission:state==="complete_for_scope"
    ? { state,completionContract:{ id:completionContractId,version:completionContractVersion },completionEvaluationId:appliedEvaluationId }
    : { state },...(lifecycle.candidate===null ? {} : { candidate:lifecycle.candidate }),deployments:deploymentInputs,
    acceptance:lifecycle.acceptance===null ? { state:"pending" } : lifecycle.acceptance,
    ...(lifecycle.tracker===null ? {} : { tracker:lifecycle.tracker }),effects:effectInputs,
    businessCompletion:lifecycle.businessCompletion===null ? { state:"not_evaluated" } : lifecycle.businessCompletion });
  assertLifecyclePacketVersion(parsed,"1.1.0");
  for(const item of [parsed.candidate,...parsed.deployments,lifecycle.acceptance===null ? undefined : parsed.acceptance,
    parsed.tracker,lifecycle.businessCompletion===null ? undefined : parsed.businessCompletion]) {
    if(item && !item.observation) throw new TypeError("recorded status dimension requires exact observation identity");
  }
  const deployments=parsed.deployments.map((item,index)=>({ ...item,evidenceIds:evidenceIds(expectRecord(deploymentInputs[index],"deployment").evidenceIds) }));
  const selectedIds=new Set([
    ...evidenceIds(parsed.candidate?.revision.evidenceIds??[]),...evidenceIds(parsed.acceptance.evidenceIds??[]),
    ...evidenceIds(parsed.businessCompletion.evidenceIds??[]),...deployments.flatMap((d)=>d.evidenceIds),
  ]);
  const evidence=array(input.evidence).map((value):CounterpartStatusEvidence=>{
    const row=exact(value,["evidenceId","observedAt","freshness","accessibility"],"status.evidence");
    return { evidenceId:parseStableId(row.evidenceId,"evidence"),observedAt:expectIsoTimestamp(row.observedAt,"evidence.observedAt"),
      freshness:expectEnum(row.freshness,["current","stale","unknown"],"evidence.freshness"),
      accessibility:expectEnum(row.accessibility,["available","inaccessible","missing","malformed","unknown"],"evidence.accessibility") };
  });
  const evidenceSet=new Set(evidence.map((e)=>e.evidenceId));
  if(evidenceSet.size!==evidence.length || evidenceSet.size!==selectedIds.size || [...selectedIds].some((id)=>!evidenceSet.has(id))) {
    throw new TypeError("status requires exactly its selected evidence metadata");
  }
  if(new Set(parsed.effects.map((e)=>e.effectId)).size!==parsed.effects.length) {
    throw new TypeError("status collections require unique identities");
  }
  const assessment=exact(input.assessment,["kind","freshness","conflicts"],"status.assessment");
  return { ...summary,nodes,
    statusSchemaVersion:expectEnum(input.statusSchemaVersion,["1.0.0"],"status.schemaVersion"),asOf:expectIsoTimestamp(input.asOf,"status.asOf"),
    lifecycle:{ candidate:parsed.candidate??null,deployments,acceptance:lifecycle.acceptance===null ? null : parsed.acceptance,
      tracker:parsed.tracker??null,effects:parsed.effects,businessCompletion:lifecycle.businessCompletion===null ? null : parsed.businessCompletion },
    completion:{ appliedEvaluationId,appliedEvaluation,latestEvaluation },
    assessment:{ kind:expectEnum(assessment.kind,["recorded_only"],"assessment.kind"),
      freshness:expectEnum(assessment.freshness,["not_assessed"],"assessment.freshness"),conflicts:expectEnum(assessment.conflicts,["not_assessed"],"assessment.conflicts") },evidence };
}
function exact(value:unknown,keys:readonly string[],path:string):Record<string,unknown> {
  return shape(value,keys,[],path);
}
function shape(value:unknown,keys:readonly string[],optional:readonly string[],path:string):Record<string,unknown> {
  const row=expectRecord(value,path); expectOnlyKeys(row,[...keys,...optional],path);
  if(keys.some((key)=>!Object.hasOwn(row,key))) throw new TypeError(`${path} requires every declared field`);
  return row;
}
function microseconds(value:string):bigint {
  const fraction=/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/u.exec(value)?.[1]??"";
  if(fraction.length>6) throw new TypeError("status evaluation timestamp exceeds PostgreSQL microsecond precision");
  return BigInt(Date.parse(value))*1000n+BigInt(fraction.slice(3).padEnd(3,"0"));
}
function array(value:unknown,limit=counterpartStatusCollectionLimit):readonly unknown[] {
  const items=expectArray(value,"status collection"); if(items.length>limit) throw new TypeError("mission status collection exceeds bounded snapshot"); return items;
}
function text(value:unknown):string {
  const result=expectString(value,"status text"); if(result.length>4096) throw new TypeError("mission status text exceeds bounded snapshot"); return result;
}
function evidenceIds(value:unknown):readonly StableId<"evidence">[] { return array(value).map((id)=>parseStableId(id,"evidence")); }
function evaluation(value:unknown):CompletionEvaluation|null {
  if(value===null) return null;
  const e=exact(value,["evaluationId","missionId","contract","status","evaluatedAt","reasons","disqualifiers",
    "requiredReceiptsVerified","evidenceFreshnessVerified","lifecycleDigest","provenanceId"],"status.evaluation");
  const contract=exact(e.contract,["id","version"],"evaluation.contract");
  const result:CompletionEvaluation={ evaluationId:parseStableId(e.evaluationId,"completionEvaluation"),missionId:parseStableId(e.missionId,"mission"),
    contract:{ id:parseStableId(contract.id,"completionContract"),version:text(contract.version) },status:expectEnum(e.status,["passed","failed"],"evaluation.status"),
    evaluatedAt:expectIsoTimestamp(e.evaluatedAt,"evaluation.evaluatedAt"),reasons:array(e.reasons).map(text),disqualifiers:array(e.disqualifiers).map(text),
    requiredReceiptsVerified:expectBoolean(e.requiredReceiptsVerified,"evaluation.requiredReceiptsVerified"),
    evidenceFreshnessVerified:expectBoolean(e.evidenceFreshnessVerified,"evaluation.evidenceFreshnessVerified"),lifecycleDigest:text(e.lifecycleDigest),
    provenanceId:parseStableId(e.provenanceId,"provenance") };
  // Migration 0002 retained pre-verification evaluations verbatim except for
  // this exact marker and false flags. Report that history, never promote it.
  const legacy=result.lifecycleDigest===`legacy-unverified:${result.evaluationId}`
    && !result.requiredReceiptsVerified && !result.evidenceFreshnessVerified;
  if(result.lifecycleDigest.startsWith("legacy-unverified:") && !legacy) throw new TypeError("malformed legacy evaluation marker");
  if(!legacy && ((result.status==="passed" && (result.disqualifiers.length!==0
    || !result.requiredReceiptsVerified || !result.evidenceFreshnessVerified))
    || (result.status==="failed" && result.disqualifiers.length===0))) {
    throw new TypeError("recorded evaluation has inconsistent verification metadata");
  }
  return result;
}
