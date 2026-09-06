import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { describe,it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { buildProfileConfirmationRequest,buildProjectProfileProposal,canonicalJsonDigest,createStableId,profileFieldIds } from "@acp/domain";
import type { CounterpartMissionPersistence } from "@acp/storage";
import { createControlApiServer } from "../src/http-server.ts";

const bearerToken="synthetic-profile-http-token-not-a-real-secret";
const tools=["get_project_profile_proposal","get_profile_confirmation_request"] as const;
const unavailable="ACP profile review is unavailable; no partial document returned.";
function fixture() {
  const query={ projectId:createStableId("project"),proposalId:createStableId("projectProfileProposal") };
  const metadata={ ...query,candidateProfile:{ profileId:createStableId("projectProfile"),profileVersion:"1.0.0" },baseProfile:null,supersedesProposalId:null,
    producer:{ component:"synthetic-http",version:"1",artifactDigest:canonicalJsonDigest({ synthetic:true }) },proposedAt:"2026-09-06T00:00:00Z" };
  const proposal=buildProjectProfileProposal(metadata,Object.fromEntries(profileFieldIds.map(id=>[id,{ status:"not_applicable",rationale:"Synthetic applicability for review.",evidenceIds:[] }])),[]);
  const draft=buildProjectProfileProposal(metadata,{},[]);
  const request=buildProfileConfirmationRequest(proposal,{ currentProposalId:query.proposalId,candidateProfileExists:false,baseProfileMatches:true,asOf:"2026-09-06T00:01:00Z",evidence:[] });
  let reads=0,proposalReads=0,requestReads=0,mutations=0;
  const persistence={
    async getProjectProfileProposal(input:unknown) { reads++; proposalReads++; assert.deepEqual(input,query); return proposal; },
    async getProfileConfirmationRequest(input:unknown) { reads++; requestReads++; assert.deepEqual(input,query); return request; },
    async getProjectReadiness() { throw new Error("unexpected readiness read"); },
    async createMission() { mutations++; throw new Error("unexpected mutation"); },
    async getMission() { throw new Error("unexpected mission read"); },async getMissionStatus() { throw new Error("unexpected status read"); },
    async listActiveMissions() { throw new Error("unexpected inventory"); },
  } as unknown as CounterpartMissionPersistence;
  return { query,proposal,draft,request,persistence,reads:()=>reads,proposalReads:()=>proposalReads,requestReads:()=>requestReads,mutations:()=>mutations };
}
async function withClient(action:(client:Client,data:ReturnType<typeof fixture>)=>Promise<void>,version="0.3.0",allowedPluginVersions?:readonly string[]) {
  const data=fixture(),server=createControlApiServer({ persistence:data.persistence,bearerToken,...(allowedPluginVersions===undefined?{}:{ allowedPluginVersions }) });
  const client=new Client({ name:"acp-profile-review-test",version:"1.0.0" });
  try {
    await new Promise<void>((resolve,reject)=>{ server.once("error",reject); server.listen(0,"127.0.0.1",resolve); });
    const transport=new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`),{ requestInit:{ headers:{ Authorization:`Bearer ${bearerToken}`,"X-ACP-Plugin-Version":version } } });
    await client.connect(transport as unknown as Transport); await action(client,data);
  } finally { await client.close(); if(server.listening) await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
}
function denied(result:Awaited<ReturnType<Client["callTool"]>>) {
  assert.equal(result.isError,true); assert.equal(result.structuredContent,undefined);
  assert.deepEqual(result.content,[{ type:"text",text:unavailable }]);
}

describe("inert profile review MCP",()=>{
  for(const version of ["0.1.0","0.2.0","0.3.0","0.4.0"]) it(`exposes two read-only exact document tools to compatible plugin ${version}`,async()=>{
    await withClient(async(client,data)=>{
      assert.deepEqual(client.getServerVersion(),{ name:"acp-control",version:"0.4.0" });
      const listed=(await client.listTools()).tools;
      for(const name of tools) {
        const tool=listed.find(tool=>tool.name===name); assert.ok(tool);
        assert.deepEqual(tool.annotations,{ readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false });
        assert.equal(tool.inputSchema.additionalProperties,false); assert.ok(tool.outputSchema);
      }
      const draft=await client.callTool({ name:tools[0],arguments:data.query });
      assert.deepEqual(draft.structuredContent,{ proposal:data.proposal });
      assert.equal(data.proposalReads(),1); assert.equal(data.requestReads(),0);
      const request=await client.callTool({ name:tools[1],arguments:data.query });
      assert.deepEqual(request.structuredContent,{ request:data.request });
      assert.equal(data.proposalReads(),1); assert.equal(data.requestReads(),1);
      assert.match(JSON.stringify(request.content),/not confirmation|not an approval/u);
      assert.equal(data.reads(),2); assert.equal(data.mutations(),0);
    },version);
  });
  it("preserves explicit version admission and aligns the source package with seven tools",async()=>{
    await assert.rejects(withClient(async()=>assert.fail("unexpected dispatch"),"0.3.0",["0.2.0"]),error=>error instanceof Error&&"code" in error&&error.code===426);
    await assert.rejects(withClient(async()=>assert.fail("unexpected dispatch"),"0.2.0",["0.3.0"]),error=>error instanceof Error&&"code" in error&&error.code===426);
    const manifest=JSON.parse(await readFile(new URL("../../../plugins/codex-counterpart/.codex-plugin/plugin.json",import.meta.url),"utf8"));
    const mcp=JSON.parse(await readFile(new URL("../../../plugins/codex-counterpart/.mcp.json",import.meta.url),"utf8"));
    assert.equal(manifest.version,"0.4.0"); assert.equal(mcp.mcpServers["acp-control"].http_headers["X-ACP-Plugin-Version"],manifest.version);
    assert.deepEqual(mcp.mcpServers["acp-control"].enabled_tools.slice().sort(),["create_mission","get_mission_attention","get_mission_status","get_profile_confirmation_request","get_project_profile_proposal","get_project_readiness","list_active_missions"]);
  });
  it("rejects invented selectors and action fields before either persistence call",async()=>{
    await withClient(async(client,data)=>{
      for(const name of tools) for(const input of [{ ...data.query,confirm:true },{ ...data.query,latest:true },{ ...data.query,profileVersion:"1.0.0" },
        { ...data.query,proposalId:"pfp_123" },{ ...data.query,projectId:` ${data.query.projectId}` },{ ...data.query,proposalId:createStableId("mission") }]) {
        const result=await client.callTool({ name,arguments:input }); assert.equal(result.isError,true); assert.equal(result.structuredContent,undefined);
      }
      assert.equal(data.reads(),0); assert.equal(data.mutations(),0);
    });
  });
  it("returns incomplete historical proposals without inventing completion or current evidence",async()=>{
    await withClient(async(client,data)=>{
      data.persistence.getProjectProfileProposal=async()=>data.draft;
      data.persistence.getProfileConfirmationRequest=async()=>undefined;
      const result=await client.callTool({ name:tools[0],arguments:data.query }); assert.deepEqual(result.structuredContent,{ proposal:data.draft });
      denied(await client.callTool({ name:tools[1],arguments:data.query })); assert.equal(data.mutations(),0);
    });
  });
  it("masks private failures, response substitutions and forged authority as whole-document denial",async()=>{
    await withClient(async(client,data)=>{
      const sentinel="synthetic-private-profile-must-never-escape";
      for(const invalid of [undefined,{ ...data.proposal,proposalId:createStableId("projectProfileProposal") },{ ...data.proposal,projectId:createStableId("project") },
        { ...data.proposal,fields:{ ...data.proposal.fields,"context.product":{ status:"missing",reason:sentinel.repeat(3000),question:"Synthetic?" } } },
        { ...data.proposal,authority:{ ...data.proposal.authority,activation:"authorized" } }]) {
        data.persistence.getProjectProfileProposal=async()=>invalid as typeof data.proposal;
        const result=await client.callTool({ name:tools[0],arguments:data.query }); denied(result); assert.equal(JSON.stringify(result).includes(sentinel),false);
      }
      for(const invalid of [undefined,{ ...data.request,proposalId:createStableId("projectProfileProposal") },{ ...data.request,projectId:createStableId("project") },
        { ...data.request,operatorId:sentinel },{ ...data.request,kind:"confirmed" },{ ...data.request,activation:"authorized" },
        { ...data.request,asOf:"2026-09-06T00:02:00.000000Z" },{ ...data.request,evidenceSnapshotDigest:canonicalJsonDigest({ changed:true }) },
        { ...data.request,evidence:[{ rawSource:sentinel }] },{ ...data.request,proposal:data.draft }]) {
        data.persistence.getProfileConfirmationRequest=async()=>invalid as typeof data.request;
        const result=await client.callTool({ name:tools[1],arguments:data.query }); denied(result); assert.equal(JSON.stringify(result).includes(sentinel),false);
      }
      data.persistence.getProjectProfileProposal=async()=>{ throw new Error(sentinel); };
      data.persistence.getProfileConfirmationRequest=async()=>{ throw new Error(sentinel); };
      for(const name of tools) denied(await client.callTool({ name,arguments:data.query })); assert.equal(data.mutations(),0);
    });
  });
  it("rejects unauthenticated review calls before database dispatch",async()=>{
    const data=fixture(),server=createControlApiServer({ persistence:data.persistence,bearerToken });
    try {
      await new Promise<void>((resolve,reject)=>{ server.once("error",reject); server.listen(0,"127.0.0.1",resolve); });
      const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      assert.deepEqual(await (await fetch(`${base}/healthz`)).json(),{ status:"ok",version:"0.4.0" });
      for(const name of tools) {
        const result=await fetch(`${base}/mcp`,{ method:"POST",headers:{ "Content-Type":"application/json","X-ACP-Plugin-Version":"0.3.0" },
          body:JSON.stringify({ jsonrpc:"2.0",id:1,method:"tools/call",params:{ name,arguments:data.query } }) });
        assert.equal(result.status,401); assert.equal((await result.text()).includes(bearerToken),false);
      }
      assert.equal(data.reads(),0); assert.equal(data.mutations(),0);
    } finally { if(server.listening) await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
  });
});
