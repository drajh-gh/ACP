import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { it } from "node:test";
import type { QueryResult,QueryResultRow } from "pg";
import { canonicalJsonDigest,createStableId } from "@acp/domain";
import { PostgresCounterpartMissionStore } from "../src/counterpart-store.ts";

type Phase="BEGIN"|"lock"|"replay"|"mission"|"event"|"request"|"nodes"|"COMMIT";
class CounterpartSession extends EventEmitter {
  readonly input={clientRequestId:"request:session",projectId:createStableId("project"),objective:"Diagnose this synthetic request.",requestedScope:"Verified diagnosis only."};
  readonly provenanceId=createStableId("provenance");readonly workflowId=createStableId("workflow");readonly contractId=createStableId("completionContract");
  readonly failure=new Error("original counterpart session failure");readonly rollbackFailure=new Error("rollback must not mask original failure");
  readonly queries:string[]=[];readonly releases:(Error|boolean|undefined)[]=[];readonly historical:boolean;
  connections=0;listenerAtRelease=0;events=0;requests=0;row:QueryResultRow|undefined;
  failAt?:Phase;emitAt?:Phase;rollbackFails=false;
  private before:{row:QueryResultRow|undefined;events:number;requests:number}|undefined;
  private transaction=false;
  constructor(historical=false) {
    super();this.historical=historical;if(historical){this.row=this.mission(createStableId("mission"));this.events=1;this.requests=1;}
  }
  private mission(id:string):QueryResultRow {
    return {mission_id:id,project_id:this.input.projectId,state:"received",requested_scope:this.input.requestedScope,
      workflow_id:this.workflowId,workflow_version:"1.0.0",completion_contract_id:this.contractId,completion_contract_version:"1.0.0",
      created_at:new Date("2026-09-06T10:00:00.000Z"),updated_at:new Date("2026-09-06T10:00:00.000Z"),request_digest:canonicalJsonDigest(this.input)};
  }
  async connect(){this.connections++;return this;}
  release(discard?:Error|boolean){
    this.listenerAtRelease=this.listenerCount("error");this.releases.push(discard);
    if(discard && this.transaction)this.rollback();
    if(this.listenerAtRelease)this.emit("error",new Error("physical close notification"));
  }
  private rollback(){assert.ok(this.before);this.row=this.before.row;this.events=this.before.events;this.requests=this.before.requests;this.transaction=false;}
  async query<R extends QueryResultRow>(sql:string,values:unknown[]=[]):Promise<QueryResult<R>> {
    this.queries.push(sql);let phase:Phase|undefined,rows:QueryResultRow[]=[];
    if(sql==="BEGIN"){phase="BEGIN";this.before={row:this.row,events:this.events,requests:this.requests};this.transaction=true;}
    else if(sql==="COMMIT"){phase="COMMIT";this.transaction=false;}
    else if(sql==="ROLLBACK"){if(this.rollbackFails)throw this.rollbackFailure;if(this.transaction)this.rollback();}
    else if(sql.includes("pg_advisory_xact_lock"))phase="lock";
    else if(sql.includes("WHERE request.client_request_id")){phase="replay";rows=this.requests && this.row?[this.row]:[];}
    else if(sql.includes("FROM acp.project_workflow_bindings"))rows=[{binding_id:createStableId("workflowBinding"),workflow_id:this.workflowId,
      workflow_version:"1.0.0",completion_contract_id:this.contractId,completion_contract_version:"1.0.0"}];
    else if(sql==="SELECT statement_timestamp() AS occurred_at")rows=[{occurred_at:new Date("2026-09-06T10:00:00.000Z")}];
    else if(sql.startsWith("INSERT INTO acp.missions")){phase="mission";this.row=this.mission(values[0] as string);rows=[this.row];}
    else if(sql.startsWith("INSERT INTO acp.mission_events")){phase="event";this.events++;}
    else if(sql.startsWith("INSERT INTO acp.counterpart_mission_requests")){phase="request";this.requests++;}
    else if(sql.includes("FROM acp.mission_nodes"))phase="nodes";
    else throw new Error(`Unexpected counterpart query: ${sql}`);
    if(phase!==undefined && phase===this.emitAt)this.emit("error",this.failure);
    if(phase!==undefined && phase===this.failAt)throw this.failure;
    return {rows:rows as R[],rowCount:rows.length,command:sql,fields:[],oid:0};
  }
  invoke(){return new PostgresCounterpartMissionStore(this,this.provenanceId).createMission(this.input);}
}
function discarded(session:CounterpartSession){
  assert.equal(session.connections,1);assert.deepEqual(session.releases,[true]);assert.equal(session.listenerAtRelease,1);assert.equal(session.listenerCount("error"),0);
  assert.equal(session.queries.filter(q=>q==="BEGIN").length,1,"no automatic replay");
}
function retained(session:CounterpartSession,committed:boolean){
  const expected=session.historical || committed?1:0;assert.equal(session.row?1:0,expected);assert.equal(session.events,expected);assert.equal(session.requests,expected);
}
for(const historical of [false,true]) {
  const name=historical?"exact historical replay":"new mission";
  it(`counterpart ${name} physically discards a successful session without duplicating history`,async()=>{
    const session=new CounterpartSession(historical),result=await session.invoke();
    assert.equal(result.replayed,historical);assert.equal(result.mission.missionId,session.row?.mission_id);
    assert.equal(session.queries.filter(q=>q.startsWith("INSERT")).length,historical?0:3);discarded(session);retained(session,true);
  });
  const phases:Phase[]=historical?["BEGIN","lock","replay","nodes","COMMIT"]:["BEGIN","lock","mission","event","request","nodes","COMMIT"];
  for(const phase of phases){
    it(`counterpart ${name} preserves uncertain ${phase} despite failed rollback without automatic replay`,async()=>{
      const session=new CounterpartSession(historical);session.failAt=phase;session.rollbackFails=true;
      await assert.rejects(session.invoke(),error=>error===session.failure);assert.equal(session.queries.at(-1),"ROLLBACK");
      discarded(session);retained(session,phase==="COMMIT");
    });
    it(`counterpart ${name} fences later SQL after a physical error during ${phase}`,async()=>{
      const session=new CounterpartSession(historical);session.emitAt=phase;
      await assert.rejects(session.invoke(),error=>error===session.failure);assert.equal(session.queries.includes("ROLLBACK"),false);
      assert.equal(session.queries.includes("COMMIT"),phase==="COMMIT");discarded(session);retained(session,phase==="COMMIT");
    });
  }
}
it("counterpart workflowKey rejects names, aliases and malformed IDs before database I/O",async()=>{
  const id=createStableId("workflow");
  for(const workflowKey of [null,42,"WF-ENG","",id.toUpperCase()," "+id,id+"\n",createStableId("project")]){
    const session=new CounterpartSession(),store=new PostgresCounterpartMissionStore(session,session.provenanceId);
    await assert.rejects(store.createMission({...session.input,workflowKey:workflowKey as string}));
    assert.equal(session.connections,0);assert.deepEqual(session.queries,[]);
  }
});
it("counterpart workflowKey is an exact workflow ID narrowing the pinned binding and version",async()=>{
  const session=new CounterpartSession(),store=new PostgresCounterpartMissionStore(session,session.provenanceId);
  const result=await store.createMission({...session.input,workflowKey:session.workflowId});
  assert.equal(result.mission.workflowId,session.workflowId);assert.equal(result.mission.workflowVersion,"1.0.0");
  const query=session.queries.find(sql=>sql.includes("FROM acp.project_workflow_bindings"));assert.ok(query);
  assert.match(query,/workflow\.workflow_id::text\s*=\s*\$2::text/u);assert.match(query,/workflow\.version\s*=\s*binding\.workflow_version/u);
  assert.match(query,/provenance\.workflow_binding_id\s*=\s*binding\.binding_id/u);discarded(session);
});
