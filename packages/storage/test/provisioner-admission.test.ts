import assert from "node:assert/strict";
import { it } from "node:test";
import { EventEmitter } from "node:events";
import type { Pool } from "pg";
import { createStableId } from "@acp/domain";
import { parseProvisionerAdmissionRequest,PostgresProvisionerAdmissionStore } from "../src/provisioner-admission-store.ts";

function sample() {
  return { attemptId:createStableId("worktreeProvisionerAttempt"),fence:{ namespace:"acp-worktree-provisioner-v1" as const,
    directory:"C:\\ACP-admission-fences",directoryIdentity:"win32-dir:12345678:1234567812345678",
    scope:{ machineFingerprint:"b".repeat(64),bootedAt:"2026-09-06T00:00:00.000Z",sessionId:1 } },
    root:{ processId:1234,processStartToken:"win32-filetime:134331300001234567",startedAt:"2026-09-06T01:00:00.1234567Z" },
    challenge:{ nonce:"c".repeat(32),epoch:1 as const } };
}
const options={ connectionTimeoutMillis:3000,statement_timeout:5000,lock_timeout:2000 };
const runtime=()=>({ hostIdentifier:"host:admission-unit",sessionId:createStableId("workerHostSession"),applicationVersion:"unit-v1",bindings:[] });
it("admission request copies only exact native evidence and the initial native challenge",()=>{
  const input=sample(),parsed=parseProvisionerAdmissionRequest(input);
  assert.deepEqual(parsed,input); assert.notEqual(parsed.challenge,input.challenge); assert.notEqual(parsed.root,input.root); assert.notEqual(parsed.fence.scope,input.fence.scope);
  for(const challenge of [{ nonce:"c".repeat(31),epoch:1 },{ nonce:"C".repeat(32),epoch:1 },{ nonce:"c".repeat(32)+"\n",epoch:1 },
    { nonce:"c".repeat(32),epoch:2 },{ nonce:"c".repeat(32),epoch:"1" },{ nonce:"c".repeat(32),epoch:1,remainingMs:20000 }]) {
    assert.throws(()=>parseProvisionerAdmissionRequest({ ...input,challenge }));
  }
  for(const extra of [{ fresh:true },{ admittedAt:"2026-09-06T01:00:00Z" },{ reservationRevision:1 },{ remainingMs:20000 }]) assert.throws(()=>parseProvisionerAdmissionRequest({ ...input,...extra }));
});
it("admission rejects malformed evidence and unbounded pools before checkout",async()=>{
  let calls=0;
  const pool={ options,async connect(){ calls++; throw new Error("unexpected checkout"); } } as unknown as Pool;
  assert.throws(()=>new PostgresProvisionerAdmissionStore({ ...pool,options:{} } as Pool,runtime()),/explicitly bounded/u);
  const store=new PostgresProvisionerAdmissionStore(pool,runtime()); assert.ok(Object.isFrozen(store.authority));
  await assert.rejects(store.admit({ ...sample(),challenge:{ nonce:"",epoch:1 } })); assert.equal(calls,0);
});
it("admission never continues on a physically failed session",async()=>{
  const events=new EventEmitter(),queries:string[]=[],discards:(boolean|undefined)[]=[],failure=new Error("original admission connection failure");
  const client={ on:events.on.bind(events),off:events.off.bind(events),async query(sql:string){ queries.push(sql); if(sql.includes("lock_provisioner_journal")) events.emit("error",failure); return { rows:[] }; },
    release(discard?:boolean){ assert.equal(events.listenerCount("error"),1); discards.push(discard); } };
  const store=new PostgresProvisionerAdmissionStore({ options,async connect(){ return client; } } as unknown as Pool,runtime());
  await assert.rejects(store.admit(sample()),(error)=>error===failure);
  assert.deepEqual(queries,["BEGIN","SELECT acp.lock_provisioner_journal($1)"]); assert.deepEqual(discards,[true]); assert.equal(events.listenerCount("error"),0);
});
it("historical admission, standalone process and stop rows cannot produce a fresh acknowledgement",async()=>{
  for(const history of ["admission","process","stop"]) {
    const queries:string[]=[],discards:(boolean|undefined)[]=[];
    const client={ async query(sql:string){ queries.push(sql); return { rows:sql.includes("AS already_recorded") ? [{ already_recorded:true,history }] : [] }; },release(discard?:boolean){ discards.push(discard); } };
    const store=new PostgresProvisionerAdmissionStore({ options,async connect(){ return client; } } as unknown as Pool,runtime());
    await assert.rejects(store.admit(sample()),/fresh unrecorded provisioner attempt/u);
    assert.ok(!queries.some((sql)=>sql.startsWith("INSERT") || sql==="COMMIT")); assert.equal(queries.at(-1),"ROLLBACK"); assert.deepEqual(discards,[true]);
  }
});
function acknowledgementRow(input:ReturnType<typeof sample>,a:ReturnType<typeof runtime>) {
  return { attempt_id:input.attemptId,challenge_nonce:input.challenge.nonce,challenge_epoch:1,host_identifier:a.hostIdentifier,
    owner_session_id:a.sessionId,application_version:a.applicationVersion,root_claim_owner_id:input.attemptId,reservation_id:createStableId("worktreeReservation"),
    reservation_revision:1,provenance_id:createStableId("provenance"),deadline_at:"2026-09-06T01:00:10.123456Z",admitted_at:"2026-09-06T01:00:01.123456Z",duration_milliseconds:9000 };
}
it("a fresh acknowledgement cannot escape before COMMIT and caller mutation cannot alter native terms",async()=>{
  const input=sample(),original=structuredClone(input),a=runtime(),row=acknowledgementRow(input,a),queries:{ sql:string;values?:unknown[] }[]=[],discards:(boolean|undefined)[]=[];
  let commitStarted!:()=>void,finishCommit!:()=>void,returned=false;
  const committed=new Promise<void>((resolve)=>{ finishCommit=resolve; }),entered=new Promise<void>((resolve)=>{ commitStarted=resolve; });
  const client={ async query(sql:string,values?:unknown[]){
    queries.push({ sql,...(values ? { values } : {}) });
    if(sql==="COMMIT") { commitStarted(); await committed; }
    return { rows:sql.includes("AS already_recorded") ? [{ already_recorded:false }] : sql.includes("RETURNING to_jsonb") ? [{ admission:row }] : [] };
  },release(discard?:boolean){ discards.push(discard); } };
  const store=new PostgresProvisionerAdmissionStore({ options,async connect(){ return client; } } as unknown as Pool,a);
  const pending=store.admit(input).then((value)=>{ returned=true; return value; });
  input.challenge.nonce="d".repeat(32); input.root.processId=9876; input.fence.scope.sessionId=2;
  await entered; assert.equal(returned,false); assert.deepEqual(discards,[]); finishCommit();
  const ack=await pending; assert.equal(ack.fresh,true); assert.deepEqual(ack.challenge,original.challenge); assert.deepEqual(ack.root,original.root); assert.deepEqual(ack.fence,original.fence);
  assert.equal(queries.find((q)=>q.sql.startsWith("INSERT INTO acp.worktree_provisioner_processes"))!.values![8],original.root.processId);
  assert.equal(queries.at(-1)!.sql,"COMMIT"); assert.deepEqual(discards,[true]);
});
it("a lost COMMIT acknowledgement is not retried or resolved through readback",async()=>{
  const input=sample(),a=runtime(),row=acknowledgementRow(input,a),queries:string[]=[],discards:(boolean|undefined)[]=[],failure=new Error("lost COMMIT response");
  const client={ async query(sql:string){ queries.push(sql); if(sql==="COMMIT") throw failure;
    return { rows:sql.includes("AS already_recorded") ? [{ already_recorded:false }] : sql.includes("RETURNING to_jsonb") ? [{ admission:row }] : [] };
  },release(discard?:boolean){ discards.push(discard); } };
  const store=new PostgresProvisionerAdmissionStore({ options,async connect(){ return client; } } as unknown as Pool,a);
  await assert.rejects(store.admit(input),(error)=>error===failure); assert.equal(queries.filter((sql)=>sql==="BEGIN").length,1);
  assert.deepEqual(queries.slice(queries.indexOf("COMMIT")),["COMMIT","ROLLBACK"]); assert.deepEqual(discards,[true]);
});
it("malformed database acknowledgement cannot be committed as a fresh receipt",async()=>{
  for(const changes of [{ duration_milliseconds:250 },{ duration_milliseconds:20001 },{ duration_milliseconds:251.5 },{ reservation_revision:0 },
    { challenge_nonce:"d".repeat(32) },{ challenge_epoch:2 },{ root_claim_owner_id:createStableId("worktreeProvisionerAttempt") },
    { owner_session_id:createStableId("workerHostSession") },{ deadline_at:"2026-09-06T01:00:00Z" },{ admitted_at:"tomorrow" }]) {
    const input=sample(),a=runtime(),row={ ...acknowledgementRow(input,a),...changes },queries:string[]=[];
    const client={ async query(sql:string){ queries.push(sql); return { rows:sql.includes("AS already_recorded") ? [{ already_recorded:false }] : sql.includes("RETURNING to_jsonb") ? [{ admission:row }] : [] }; },release(){} };
    const store=new PostgresProvisionerAdmissionStore({ options,async connect(){ return client; } } as unknown as Pool,a);
    await assert.rejects(store.admit(input)); assert.ok(!queries.includes("COMMIT")); assert.equal(queries.at(-1),"ROLLBACK");
  }
});
