import assert from "node:assert/strict";
import { Pool,type QueryResult,type QueryResultRow } from "pg";
import { createStableId,type StableId } from "@acp/domain";
import { PostgresCounterpartMissionStore } from "../../src/counterpart-store.ts";
import type { ConnectionPool } from "../../src/database.ts";

const port=Number(process.argv[2]),phase=process.argv[3];
if(!Number.isInteger(port) || port<1024 || port>65535 || !["core","races"].includes(phase??""))throw new Error("owned database port and exact counterpart session phase required");
const pool=new Pool({connectionString:`postgresql://postgres:acp_test_password@127.0.0.1:${port}/acp_test`,max:4,
  connectionTimeoutMillis:3000,statement_timeout:5000,lock_timeout:2000});
const projectId="prj_00000000-0000-4000-8000-000000000001" as StableId<"project">;
const provenanceId="prv_00000000-0000-4000-8000-000000000001" as StableId<"provenance">;
const store=new PostgresCounterpartMissionStore(pool,provenanceId);
const workflowId="wfl_00000000-0000-4000-8000-000000000001" as StableId<"workflow">;
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
let checks=0;
async function check(name:string,action:()=>Promise<void>) {await action();checks++;process.stdout.write(`PASS counterpart session: ${name}\n`);}
function request(){return {clientRequestId:createStableId("event"),projectId,objective:"Inspect the synthetic ž 🚀 request.",requestedScope:"Return a verified diagnosis only."};}
async function counts(){return (await pool.query(`SELECT (SELECT count(*)::int FROM acp.missions) AS missions,
  (SELECT count(*)::int FROM acp.mission_events) AS events,(SELECT count(*)::int FROM acp.counterpart_mission_requests) AS requests`)).rows[0] as {missions:number;events:number;requests:number};}
type Fault="BEGIN"|"COMMIT"|"connection"|undefined;
function intercepted(input:ReturnType<typeof request>,fault?:Fault){
  let pid=0,connections=0,ended:Promise<void>|undefined;
  const queries:string[]=[],releases:(boolean|Error|undefined)[]=[],socketErrors:Error[]=[];
  const failure=new Error(`synthetic lost counterpart ${fault} response`),rollbackFailure=new Error("synthetic failed rollback response");
  const connection:ConnectionPool={query:pool.query.bind(pool),async connect(){
    connections++;const client=await pool.connect();
    ended=new Promise<void>(resolve=>client.once("end",()=>resolve()));
    // Passive fixture witness is independent of the store's sticky error guard.
    client.on("error",error=>socketErrors.push(error));
    try {
    pid=Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    process.stdout.write(`Owned database backend ${pid}: counterpart ${fault??"success"}\n`);
    return {on:client.on.bind(client),off:client.off.bind(client),release(discard?:boolean|Error){releases.push(discard);client.release(discard);},
      async query<R extends QueryResultRow>(sql:string,values?:unknown[]):Promise<QueryResult<R>>{
        queries.push(sql);
        if(fault==="BEGIN" && sql==="ROLLBACK")throw rollbackFailure;
        const result=await client.query<R>(sql,values);
        if(fault==="BEGIN" && sql==="BEGIN"){
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`acp:counterpart:${input.clientRequestId}`]);
          throw failure;
        }
        if(fault==="COMMIT" && sql==="COMMIT")throw failure;
        if(fault==="connection" && sql.startsWith("INSERT INTO acp.missions")){
          assert.equal((await pool.query("SELECT pg_terminate_backend($1) AS stopped",[pid])).rows[0].stopped,true);
          await ended; // Return an old successful query result only after actual socket loss.
        }
        return result;
      }};
    }catch(error){
      // A failed fixture identity read has not transferred this client to the
      // production helper yet, so the fixture still owns physical cleanup.
      try{client.release(true);}catch{/* Preserve the original fixture failure. */}
      await ended;throw error;
    }
  }};
  return {connection,queries,releases,socketErrors,failure,get pid(){return pid;},get connections(){return connections;},get ended(){return ended;}};
}
async function until(condition:()=>Promise<boolean>,message:string){
  const deadline=Date.now()+2000;while(Date.now()<deadline){if(await condition())return;await pause(10);}assert.fail(message);
}
async function closed(probe:ReturnType<typeof intercepted>,input:ReturnType<typeof request>){
  assert.deepEqual(probe.releases,[true]);assert.equal(probe.connections,1);assert.ok(probe.ended);
  await until(async()=>!(await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1) AS remains",[probe.pid])).rows[0].remains,"exact counterpart backend did not close");
  await probe.ended;
  assert.equal((await pool.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired",[`acp:counterpart:${input.clientRequestId}`])).rows[0].acquired,true);
  assert.equal(probe.queries.filter(q=>q==="BEGIN").length,1,"no automatic callback replay");
}
try {
  if(phase==="core") {
    await check("actual creation and identical replay preserve one mission, event and request",async()=>{
      const input=request(),before=await counts(),created=await store.createMission(input);
      assert.equal(created.replayed,false);assert.equal(created.mission.state,"received");assert.deepEqual(created.mission.nodes,[]);
      const replay=await store.createMission(input);assert.equal(replay.replayed,true);assert.deepEqual(replay.mission,created.mission);
      await assert.rejects(store.createMission({...input,objective:"A divergent objective."}),/aliases different mission terms/u);
      assert.deepEqual(await counts(),{missions:before.missions+1,events:before.events+1,requests:before.requests+1});
    });
    await check("exact workflow ID narrows the authoritative version; unavailable IDs create no rows",async()=>{
      await pool.query(`INSERT INTO acp.workflow_definitions SELECT (jsonb_populate_record(NULL::acp.workflow_definitions,to_jsonb(source)||'{"version":"2.0.0"}'::jsonb)).*
        FROM acp.workflow_definitions source WHERE workflow_id=$1 AND version='1.0.0'`,[workflowId]);
      const input={...request(),workflowKey:workflowId},created=await store.createMission(input);
      assert.equal(created.mission.workflowId,workflowId);assert.equal(created.mission.workflowVersion,"1.0.0");
      assert.equal((await store.createMission(input)).replayed,true);
      const other=createStableId("workflow");
      assert.equal((await pool.query(`INSERT INTO acp.workflow_definitions SELECT (jsonb_populate_record(NULL::acp.workflow_definitions,to_jsonb(source)||$2::jsonb)).*
        FROM acp.workflow_definitions source WHERE workflow_id=$1 AND version='1.0.0'`,[workflowId,JSON.stringify({workflow_id:other})])).rowCount,1);
      const before=await counts();
      for(const selected of [other,createStableId("workflow")])await assert.rejects(store.createMission({...request(),workflowKey:selected}),/no active workflow binding/u);
      await assert.rejects(store.createMission({...request(),projectId:"prj_00000000-0000-4000-8000-000000000002",workflowKey:workflowId}),/no active workflow binding/u);
      assert.deepEqual(await counts(),before);
    });
    await check("successful new and historical sessions close their actual backends",async()=>{
      const input=request(),first=intercepted(input),second=intercepted(input),before=await counts();
      const created=await new PostgresCounterpartMissionStore(first.connection,provenanceId).createMission(input);await closed(first,input);
      const replay=await new PostgresCounterpartMissionStore(second.connection,provenanceId).createMission(input);await closed(second,input);
      assert.equal(created.replayed,false);assert.equal(replay.replayed,true);assert.equal(created.mission.missionId,replay.mission.missionId);
      assert.deepEqual(await counts(),{missions:before.missions+1,events:before.events+1,requests:before.requests+1});
    });
    await check("lost BEGIN plus failed rollback preserves the original error and releases the physical lock",async()=>{
      const input=request(),probe=intercepted(input,"BEGIN"),before=await counts();
      await assert.rejects(new PostgresCounterpartMissionStore(probe.connection,provenanceId).createMission(input),error=>error===probe.failure);
      await closed(probe,input);assert.deepEqual(probe.queries,["BEGIN","ROLLBACK"]);assert.deepEqual(await counts(),before);
    });
    await check("actual backend death after mission INSERT rolls back all history and fences later SQL",async()=>{
      const input=request(),probe=intercepted(input,"connection"),before=await counts();
      await assert.rejects(new PostgresCounterpartMissionStore(probe.connection,provenanceId).createMission(input));
      await closed(probe,input);assert.ok(probe.socketErrors.length>0);assert.ok(probe.queries.at(-1)?.startsWith("INSERT INTO acp.missions"));
      assert.equal(probe.queries.includes("COMMIT"),false);assert.deepEqual(await counts(),before);
    });
    await check("lost actual COMMIT reply rejects once; explicit exact replay returns retained history",async()=>{
      const input=request(),probe=intercepted(input,"COMMIT"),before=await counts();
      await assert.rejects(new PostgresCounterpartMissionStore(probe.connection,provenanceId).createMission(input),error=>error===probe.failure);
      await closed(probe,input);assert.equal(probe.queries.filter(q=>q==="COMMIT").length,1);
      const retained=await counts();assert.deepEqual(retained,{missions:before.missions+1,events:before.events+1,requests:before.requests+1});
      const replay=await store.createMission(input);assert.equal(replay.replayed,true);
      const row=(await pool.query("SELECT mission_id FROM acp.counterpart_mission_requests WHERE client_request_id=$1",[input.clientRequestId])).rows[0];
      assert.equal(replay.mission.missionId,row?.mission_id);assert.deepEqual(await counts(),retained);
    });
  }
  if(phase==="races")for(const divergent of [false,true]){
    await check(`concurrent ${divergent?"divergent":"identical"} requests share one lock and create one history`,async()=>{
      const input=request(),rightInput=divergent?{...input,objective:"A divergent concurrent objective."}:input;
      const first=intercepted(input),second=intercepted(rightInput),before=await counts(),incumbent=await pool.connect();
      const ended=new Promise<void>(resolve=>incumbent.once("end",()=>resolve()));
      incumbent.on("error",()=>{}); // The fixture owns acquisition failures too.
      let released=false,bodyFailed=false;const pending:Promise<unknown>[]=[];
      try{
        const pid=Number((await incumbent.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);process.stdout.write(`Owned database backend ${pid}: counterpart incumbent lock\n`);
        await incumbent.query("BEGIN");await incumbent.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`acp:counterpart:${input.clientRequestId}`]);
        pending.push(new PostgresCounterpartMissionStore(first.connection,provenanceId).createMission(input),new PostgresCounterpartMissionStore(second.connection,provenanceId).createMission(rightInput));
        for(const result of pending)void result.catch(()=>{});
        await until(async()=>(await pool.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted AND pid=ANY($1)",[[first.pid,second.pid]])).rows[0].n===2,"both exact requests must be blocked on the incumbent request lock");
        await incumbent.query("COMMIT");released=true;incumbent.release(true);await ended;
        const results=await Promise.allSettled(pending);
        if(divergent){
          assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
          const rejected=results.find(r=>r.status==="rejected");assert.ok(rejected?.status==="rejected");assert.match(String(rejected.reason),/aliases different mission terms/u);
        }else{
          const values=results.map(result=>{assert.equal(result.status,"fulfilled");assert.ok(result.status==="fulfilled");return result.value as {replayed:boolean;mission:{missionId:string}};});
          assert.deepEqual(values.map(v=>v.replayed).sort(),[false,true]);assert.equal(values[0]?.mission.missionId,values[1]?.mission.missionId);
        }
        await closed(first,input);await closed(second,input);
        assert.deepEqual(await counts(),{missions:before.missions+1,events:before.events+1,requests:before.requests+1});
      }catch(error){bodyFailed=true;throw error;}finally{
        let cleanupFailure:unknown;
        if(!released){
          try{await incumbent.query("ROLLBACK");}catch(error){cleanupFailure=error;}
          try{released=true;incumbent.release(true);}catch(error){cleanupFailure??=error;}
        }
        await ended;await Promise.allSettled(pending);
        if(cleanupFailure!==undefined && !bodyFailed)throw cleanupFailure;
      }
    });
  }
  assert.ok(checks>0,"exact phase must execute a real scenario");
  process.stdout.write(`Counterpart session integration: ${checks} checks passed.\n`);
} finally {await pool.end();}
