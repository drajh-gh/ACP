import assert from "node:assert/strict";
import { it } from "node:test";
import { EventEmitter } from "node:events";
import { createStableId } from "@acp/domain";
import type { Pool } from "pg";
import type { HostRuntimeRegistration } from "../src/dispatch-store.ts";
import { PostgresWorktreeProvisionerStore } from "../src/worktree-provisioner-store.ts";
import { parseWorktreeProvisionerAttempt,type WorktreeProvisionerAttemptInput } from "../src/worktree-provisioner-attempt.ts";

function plan():WorktreeProvisionerAttemptInput {
  return { attemptId:createStableId("worktreeProvisionerAttempt"),reservationId:createStableId("worktreeReservation"),reservationRevision:3,
    baseRevision:"a".repeat(40),reportedParent:{ path:"C:\\ACP-plans\\Železniki",identity:"win32-dir:12345678:1234567812345678",
      observedAt:"2026-09-06T00:00:00.123456+00:00" },fencePlan:{ namespace:"acp-worktree-provisioner-v1",directory:"C:\\ACP-provisioner-fences" },
    deadlineAt:"2026-09-06T00:00:15.123456+00:00" };
}
it("provisioner plan preserves reported identity and exact microseconds without a worker or native claim",()=>{
  const input=plan(),parsed=parseWorktreeProvisionerAttempt(input);
  assert.deepEqual(parsed,input); assert.notEqual(parsed,input); assert.notEqual(parsed.reportedParent,input.reportedParent);
  assert.equal(parseWorktreeProvisionerAttempt({ ...input,baseRevision:"b".repeat(64) }).baseRevision.length,64);
});
it("provisioner plan rejects caller-selected target, owner, provenance, permission and unknown nested fields",()=>{
  const input=plan();
  for(const extra of ["runId","workerProcessId","workspacePath","branchRef","provenanceId","hostIdentifier","state","launchAllowed"]) {
    assert.throws(()=>parseWorktreeProvisionerAttempt({ ...input,[extra]:"injected" }));
  }
  assert.throws(()=>parseWorktreeProvisionerAttempt({ ...input,reportedParent:{ ...input.reportedParent,pinned:true } }));
  assert.throws(()=>parseWorktreeProvisionerAttempt({ ...input,fencePlan:{ ...input.fencePlan,sealed:true } }));
  for(const key of Object.keys(input)) { const missing={ ...input } as Record<string,unknown>; delete missing[key]; assert.throws(()=>parseWorktreeProvisionerAttempt(missing)); }
});
it("provisioner identity cannot reuse worker or hold IDs and revision must be a positive bounded integer",()=>{
  const input=plan();
  for(const attemptId of [createStableId("workerProcess"),createStableId("run"),createStableId("worktreeReservation")]) assert.throws(()=>parseWorktreeProvisionerAttempt({ ...input,attemptId }));
  assert.throws(()=>parseWorktreeProvisionerAttempt({ ...input,reservationId:input.attemptId }));
  for(const reservationRevision of [0,-1,1.1,2**31,NaN,"1"]) assert.throws(()=>parseWorktreeProvisionerAttempt({ ...input,reservationRevision }));
});
it("provisioner base must be a full exact Git object ID rather than a ref or command",()=>{
  const input=plan();
  for(const baseRevision of ["main","HEAD~1","-b injected","a".repeat(39),"a".repeat(41),"A".repeat(40),"a".repeat(40)+"\n"]) {
    assert.throws(()=>parseWorktreeProvisionerAttempt({ ...input,baseRevision }));
  }
});
it("provisioner parent and fence intent reject lexical aliases and worker fence namespaces",()=>{
  const input=plan();
  for(const path of ["C:\\","C:\\ACP\\..\\target","\\\\server\\share","C:\\ACP\\nul","C:\\ACP\\trailing "]) {
    assert.throws(()=>parseWorktreeProvisionerAttempt({ ...input,reportedParent:{ ...input.reportedParent,path } }));
    assert.throws(()=>parseWorktreeProvisionerAttempt({ ...input,fencePlan:{ ...input.fencePlan,directory:path } }));
  }
  assert.throws(()=>parseWorktreeProvisionerAttempt({ ...input,reportedParent:{ ...input.reportedParent,identity:"path-is-identity" } }));
  assert.throws(()=>parseWorktreeProvisionerAttempt({ ...input,fencePlan:{ ...input.fencePlan,namespace:"acp-worker" } }));
});
it("provisioner recorded times are exact finite PostgreSQL-precision timestamps with a later deadline",()=>{
  const input=plan();
  for(const at of ["infinity","tomorrow","2026-09-06","2026-09-06T00:00:00.1234567Z"]) {
    assert.throws(()=>parseWorktreeProvisionerAttempt({ ...input,deadlineAt:at }));
    assert.throws(()=>parseWorktreeProvisionerAttempt({ ...input,reportedParent:{ ...input.reportedParent,observedAt:at } }));
  }
  assert.throws(()=>parseWorktreeProvisionerAttempt({ ...input,deadlineAt:input.reportedParent.observedAt }));
  assert.throws(()=>parseWorktreeProvisionerAttempt({ ...input,deadlineAt:"2026-09-06T00:00:00.123455+00:00" }));
});
it("provisioner stores require bounded database access and reject malformed write/read identity before querying",async()=>{
  let calls=0;
  const runtime={ hostIdentifier:"host:unit-plan",sessionId:createStableId("workerHostSession"),applicationVersion:"unit-v1",bindings:[] };
  const pool={ options:{ connectionTimeoutMillis:3000,statement_timeout:5000,lock_timeout:2000 },
    async query(){ calls++; return { rows:[] }; },async connect(){ calls++; throw new Error("unexpected connection"); } } as unknown as Pool;
  assert.throws(()=>new PostgresWorktreeProvisionerStore({ ...pool,options:{} } as unknown as Pool,runtime),/explicitly bounded/u);
  assert.throws(()=>new PostgresWorktreeProvisionerStore(pool,{ ...runtime,sessionId:createStableId("run") } as unknown as HostRuntimeRegistration));
  const store=new PostgresWorktreeProvisionerStore(pool,runtime);
  await assert.rejects(store.plan({ ...plan(),baseRevision:"HEAD" }));
  await assert.rejects(store.load(createStableId("run") as unknown as ReturnType<typeof plan>["attemptId"]));
  for(const limit of [0,101,1.5,NaN]) await assert.rejects(store.listRecovery({ limit }),/limit/u);
  await assert.rejects(store.listRecovery({ afterAttemptId:createStableId("run") as unknown as ReturnType<typeof plan>["attemptId"] }));
  assert.equal(calls,0);
});
it("provisioner history reads use the configured host and a bounded keyset query without opening a transaction",async()=>{
  const queries:{ sql:string;values:unknown[] }[]=[],runtime={ hostIdentifier:"host:unit-plan",sessionId:createStableId("workerHostSession"),applicationVersion:"unit-v1",bindings:[] };
  const pool={ options:{ connectionTimeoutMillis:3000,statement_timeout:5000,lock_timeout:2000 },
    async query(sql:string,values:unknown[]){ queries.push({ sql,values }); return { rows:[] }; },async connect(){ throw new Error("history must not transact"); } } as unknown as Pool;
  const store=new PostgresWorktreeProvisionerStore(pool,runtime),id=createStableId("worktreeProvisionerAttempt");
  assert.equal(await store.load(id),undefined); assert.deepEqual(queries[0]?.values,[id,runtime.hostIdentifier]);
  assert.deepEqual(await store.listRecovery({ limit:2,afterAttemptId:id }),{ items:[] });
  assert.deepEqual(queries[1]?.values,[runtime.hostIdentifier,id,3]);
  assert.match(queries[1]!.sql,/attempt_id::text>\$2.*ORDER BY attempt_id LIMIT \$3/su);
  assert.ok(queries.every((q)=>q.sql.startsWith("SELECT to_jsonb(p)")));
});
it("provisioner plan uses the physical-session guard before issuing any post-loss statement",async()=>{
  const events=new EventEmitter(),queries:string[]=[],releases:(boolean|undefined)[]=[],failure=new Error("exact plan socket failure");
  const runtime={ hostIdentifier:"host:unit-plan",sessionId:createStableId("workerHostSession"),applicationVersion:"unit-v1",bindings:[] };
  const client={ on:events.on.bind(events),off:events.off.bind(events),
    async query(sql:string) { queries.push(sql); if(sql.includes("lock_worktree_provisioner_plan")) events.emit("error",failure); return { rows:[] }; },
    release(discard?:boolean) { assert.equal(events.listenerCount("error"),1); releases.push(discard); } };
  const pool={ options:{ connectionTimeoutMillis:3000,statement_timeout:5000,lock_timeout:2000 },async connect(){ return client; } } as unknown as Pool;
  await assert.rejects(new PostgresWorktreeProvisionerStore(pool,runtime).plan(plan()),(error)=>error===failure);
  assert.equal(queries.length,2); assert.equal(queries[0],"BEGIN"); assert.match(queries[1]!,/lock_worktree_provisioner_plan/u);
  assert.deepEqual(releases,[true]); assert.equal(events.listenerCount("error"),0);
});
