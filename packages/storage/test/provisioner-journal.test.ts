import assert from "node:assert/strict";
import { it } from "node:test";
import { EventEmitter } from "node:events";
import type { Pool } from "pg";
import { createStableId } from "@acp/domain";
import { parseProvisionerProcessRecord,parseProvisionerStopRecord,parseProvisionerNativeRoot } from "../src/provisioner-journal.ts";
import { PostgresProvisionerJournalStore } from "../src/provisioner-journal-store.ts";

function sample() {
  return { attemptId:createStableId("worktreeProvisionerAttempt"),fence:{ namespace:"acp-worktree-provisioner-v1" as const,
    directory:"C:\\ACP-journal-fences",directoryIdentity:"win32-dir:12345678:1234567812345678",
    scope:{ machineFingerprint:"b".repeat(64),bootedAt:"2026-09-06T00:00:00.000Z",sessionId:1 } },
    root:{ processId:1234,processStartToken:"win32-filetime:134331300001234567",startedAt:"2026-09-06T01:00:00.1234567Z" } };
}
it("provisioner process record retains exact 100ns native identity without inferring execution",()=>{
  const input=sample(),parsed=parseProvisionerProcessRecord(input);
  assert.deepEqual(parsed,input); assert.notEqual(parsed,input); assert.notEqual(parsed.root,input.root); assert.notEqual(parsed.fence.scope,input.fence.scope);
  assert.deepEqual(Object.keys(parsed).sort(),["attemptId","fence","root"]);
});
it("native identity requires canonical UTC7 without rounding the FILETIME seventh digit",()=>{
  const root=sample().root;
  for(const startedAt of ["2026-09-06T03:00:00.1234567+02:00","2026-09-06T01:00:00.123456Z","2026-09-06T01:00:00.1234568Z","2026-09-06T01:00:00.12345670Z"]) {
    assert.throws(()=>parseProvisionerNativeRoot({ ...root,startedAt }));
  }
  assert.deepEqual(parseProvisionerNativeRoot({ ...root,processStartToken:"win32-filetime:134331300001230000",startedAt:"2026-09-06T01:00:00.1230000Z" }),
    { ...root,processStartToken:"win32-filetime:134331300001230000",startedAt:"2026-09-06T01:00:00.1230000Z" });
});
it("native journal rejects invalid PID, token, time and unknown root fields",()=>{
  const root=sample().root;
  for(const processId of [0,-1,1.5,2**31,"1234",NaN]) assert.throws(()=>parseProvisionerNativeRoot({ ...root,processId }));
  for(const processStartToken of ["1234","win32-filetime:0134331300001234567","win32-filetime:134331300001234568","win32-filetime:134331300001234567\n","win32-filetime:99999999999999999999"]) {
    assert.throws(()=>parseProvisionerNativeRoot({ ...root,processStartToken }));
  }
  for(const startedAt of ["tomorrow","2026-09-06","infinity","2026-02-30T00:00:00Z"]) assert.throws(()=>parseProvisionerNativeRoot({ ...root,startedAt }));
  assert.throws(()=>parseProvisionerNativeRoot({ ...root,treeEmpty:true }));
});
it("native FILETIME arithmetic matches independent .NET Gregorian boundary observations",()=>{
  // Constants independently obtained from DateTime.ToFileTimeUtc, not this parser.
  for(const [startedAt,token] of [["2000-02-29T12:34:56.1234567Z","125963012961234567"],["1900-03-01T00:00:00.0000000Z","94405824000000000"],
    ["1970-01-01T00:00:00.0000000Z","116444736000000000"],["9999-12-31T23:59:59.9999999Z","2650467743999999999"]]) {
    assert.equal(parseProvisionerNativeRoot({ processId:1,processStartToken:`win32-filetime:${token}`,startedAt }).startedAt,startedAt);
  }
});
it("provisioner journal denies worker identities, noncanonical fences and caller-owned authority",()=>{
  const input=sample();
  for(const attemptId of [createStableId("workerProcess"),createStableId("run"),createStableId("worktreeReservation")]) assert.throws(()=>parseProvisionerProcessRecord({ ...input,attemptId }));
  for(const key of ["hostIdentifier","provenanceId","deadlineAt","state","treeIdentifier","permission","recordedAt"]) assert.throws(()=>parseProvisionerProcessRecord({ ...input,[key]:"injected" }));
  for(const directory of ["C:\\","C:\\ACP\\..\\fence","\\\\server\\share","C:\\ACP\\NUL","C:\\ACP\\trailing "]) assert.throws(()=>parseProvisionerProcessRecord({ ...input,fence:{ ...input.fence,directory } }));
  assert.throws(()=>parseProvisionerProcessRecord({ ...input,fence:{ ...input.fence,namespace:"acp-worker" } }));
  assert.throws(()=>parseProvisionerProcessRecord({ ...input,fence:{ ...input.fence,sealed:true } }));
  for(const sessionId of [-1,1.5,2**31,"1"]) assert.throws(()=>parseProvisionerProcessRecord({ ...input,fence:{ ...input.fence,scope:{ ...input.fence.scope,sessionId } } }));
  assert.throws(()=>parseProvisionerProcessRecord({ ...input,fence:{ ...input.fence,scope:{ ...input.fence.scope,bootedAt:"2026-09-06T01:00:00.1234568Z" } } }));
  assert.throws(()=>parseProvisionerProcessRecord({ ...input,fence:{ ...input.fence,scope:{ ...input.fence.scope,bootedAt:"2026-09-06T01:00:00.124Z" } } }));
  for(const key of Object.keys(input)) { const missing={ ...input } as Record<string,unknown>; delete missing[key]; assert.throws(()=>parseProvisionerProcessRecord(missing)); }
});
it("sealed provisioner absence preserves absence without fabricating a process",()=>{
  const { root:_,...input }=sample();
  for(const reason of ["sealed_launch_job_absent","sealed_launch_job_empty"]) {
    const value={ ...input,observation:{ state:"lost",sealed:true,reason } };
    assert.deepEqual(parseProvisionerStopRecord(value),value);
    assert.throws(()=>parseProvisionerStopRecord({ ...value,observation:{ ...value.observation,root:sample().root } }));
  }
});
it("sealed owned observations require the exact native root and state-specific exit code",()=>{
  const { root,...input }=sample();
  for(const reason of ["owned_job_and_original_root_absent","owned_job_empty","exact_owned_tree_terminated"]) {
    const observation={ state:reason==="exact_owned_tree_terminated" ? "terminated" : "lost",sealed:true,reason,root,
      ...(reason==="exact_owned_tree_terminated" ? { exitCode:-1 } : {}) };
    assert.deepEqual(parseProvisionerStopRecord({ ...input,observation }),{ ...input,observation });
    const { root:_,...missing }=observation; assert.throws(()=>parseProvisionerStopRecord({ ...input,observation:missing }));
  }
});
it("stop journal rejects uncertainty, invented success, unsupported reasons and contradictory evidence",()=>{
  const { root,...input }=sample();
  const valid={ state:"terminated",sealed:true,reason:"exact_owned_tree_terminated",root,exitCode:0 };
  for(const observation of [{ state:"unconfirmed" },{ ...valid,state:"success" },{ ...valid,sealed:false },{ ...valid,reason:"owner_tree_closed_and_launch_sealed" },
    { ...valid,exitCode:undefined },{ ...valid,exitCode:2**31 },{ ...valid,exitCode:1.5 },{ ...valid,exitCode:null },
    { ...valid,state:"lost" },{ ...valid,root:{ ...root,processStartToken:"win32-filetime:134331300001234568" } },
    { state:"lost",sealed:true,reason:"sealed_launch_job_absent",exitCode:0 },{ ...valid,success:true }]) {
    assert.throws(()=>parseProvisionerStopRecord({ ...input,observation }));
  }
  assert.throws(()=>parseProvisionerStopRecord({ ...input,observation:valid,observedAt:"2026-09-06T01:00:01Z" }));
});
const bounded={ connectionTimeoutMillis:3000,statement_timeout:5000,lock_timeout:2000 };
const runtime=()=>({ hostIdentifier:"host:journal-unit",sessionId:createStableId("workerHostSession"),applicationVersion:"unit-v1",bindings:[] });
it("journal rejects malformed input and unbounded database configuration before I/O",async()=>{
  let calls=0;
  const pool={ options:bounded,async query(){ calls++; return { rows:[] }; },async connect(){ calls++; throw new Error("unexpected checkout"); } } as unknown as Pool;
  assert.throws(()=>new PostgresProvisionerJournalStore({ ...pool,options:{} } as unknown as Pool,runtime()),/explicitly bounded/u);
  const store=new PostgresProvisionerJournalStore(pool,runtime()); assert.ok(Object.isFrozen(store.authority));
  await assert.rejects(store.recordProcess({ ...sample(),state:"running" } as unknown as ReturnType<typeof sample>));
  await assert.rejects(store.recordStop({ ...sample(),observation:{ state:"unconfirmed" } } as never));
  await assert.rejects(store.load(createStableId("run") as never)); assert.equal(calls,0);
});
it("journal load is a host-scoped single snapshot with explicit unrecorded or missing history",async()=>{
  const input=sample(),queries:{ sql:string;values:unknown[] }[]=[],a=runtime(); let missing=false;
  const pool={ options:bounded,async query(sql:string,values:unknown[]){ queries.push({ sql,values }); return { rows:missing ? [] : [{ attempt_id:input.attemptId,process:null,stop:null }] }; },async connect(){ throw new Error("read must not transact"); } } as unknown as Pool;
  const store=new PostgresProvisionerJournalStore(pool,a);
  assert.deepEqual(await store.load(input.attemptId),{ attemptId:input.attemptId,state:"unrecorded" });
  assert.deepEqual(queries[0]!.values,[input.attemptId,a.hostIdentifier]); assert.match(queries[0]!.sql,/LEFT JOIN acp.worktree_provisioner_processes.*LEFT JOIN acp.worktree_provisioner_stops/su);
  missing=true; assert.equal(await store.load(input.attemptId),undefined); assert.equal(queries.length,2);
});
for(const stopping of [false,true]) {
  it(`journal ${stopping ? "stop" : "process"} callback fences physical errors before any post-lock statement`,async()=>{
    const events=new EventEmitter(),queries:string[]=[],discards:(boolean|undefined)[]=[],failure=new Error("original physical journal error"),input=sample();
    const client={ on:events.on.bind(events),off:events.off.bind(events),async query(sql:string){ queries.push(sql); if(sql.includes("lock_provisioner_journal")) events.emit("error",failure); return { rows:[] }; },
      release(discard?:boolean){ assert.equal(events.listenerCount("error"),1); discards.push(discard); } };
    const store=new PostgresProvisionerJournalStore({ options:bounded,async connect(){ return client; } } as unknown as Pool,runtime());
    const call=stopping ? store.recordStop({ attemptId:input.attemptId,fence:input.fence,observation:{ state:"lost",sealed:true,reason:"sealed_launch_job_absent" } }) : store.recordProcess(input);
    await assert.rejects(call,(error)=>error===failure); assert.deepEqual(queries,["BEGIN","SELECT acp.lock_provisioner_journal($1)"]);
    assert.deepEqual(discards,[true]); assert.equal(events.listenerCount("error"),0);
  });
}
