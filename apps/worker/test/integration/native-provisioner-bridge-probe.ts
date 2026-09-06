import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir,mkdtemp } from "node:fs/promises";
import { isAbsolute,join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { createStableId } from "@acp/domain";
import { parseProvisionerAdmissionRequest,type ProvisionerAdmissionAcknowledgement,type ProvisionerAdmissionRequest } from "@acp/storage";
import { minimalCodexEnvironment } from "../../src/codex-sdk-transport.ts";
import { describeWindowsProvisionerFence,type WindowsProvisionerFenceDescriptor } from "../../src/windows-launch-fence.ts";
import { gone,type Frame } from "./native-lease-probe.ts";

export const pause=(ms:number)=>new Promise<void>((resolve)=>setTimeout(resolve,ms));
export const utc6=(instant:number)=>new Date(instant).toISOString().replace("Z","000Z");
interface ProvisionerBridgeFixture {
  readonly directory:string;
  readonly fence:WindowsProvisionerFenceDescriptor;
  readonly bindings:{readonly workspacePath:string;readonly reportedParent:{readonly path:string;readonly identity:string};readonly commonGitDirectory:{readonly path:string;readonly identity:string}};
}
/** Real native transport with synthetic original-plan/ACK metadata; no DB or Git. */
export async function provisionerBridgeProbe(options:{ input?:string;runner?:string;launch?:Frame;fixture?:ProvisionerBridgeFixture;
  beforeLaunch?:(fixture:ProvisionerBridgeFixture)=>Promise<void>;transformLaunch?:(launch:Frame)=>Frame;hostScript?:string }={}) {
  const owner=process.env.ACP_TEST_NATIVE_CHANNEL_ROOT; assert.ok(owner && isAbsolute(owner),"outer owned fixture required");
  const pids=new Set<number>(),report=(pid:number,purpose:string)=>{pids.add(pid);process.stdout.write(`Owned PID ${pid}: ${purpose}\n`);};
  let fixture=options.fixture;
  if(!fixture){
    const directory=await mkdtemp(join(owner,"provisioner ž 🚀-")),fenceDirectory=join(directory,"fence"),commonPath=join(directory,"repository",".git");
    await mkdir(fenceDirectory);await mkdir(commonPath,{recursive:true});
    const fence=await describeWindowsProvisionerFence(fenceDirectory,new AbortController().signal,{onSpawn:report});
    const parent=await describeWindowsProvisionerFence(directory,new AbortController().signal,{onSpawn:report});
    const common=await describeWindowsProvisionerFence(commonPath,new AbortController().signal,{onSpawn:report});
    assert.deepEqual(parent.scope,fence.scope);assert.deepEqual(common.scope,fence.scope);
    fixture={directory,fence,bindings:{workspacePath:join(directory,"FutureCase"),reportedParent:{path:directory,identity:parent.directoryIdentity},
      commonGitDirectory:{path:commonPath,identity:common.directoryIdentity}}};
  }
  const {directory,fence,bindings}=fixture;
  await options.beforeLaunch?.(fixture);
  const attemptId=createStableId("worktreeProvisionerAttempt"),environment=minimalCodexEnvironment();
  const expectedPlan={reservationId:createStableId("worktreeReservation"),reservationRevision:7,deadlineAt:utc6(Date.now()+20000),provenanceId:createStableId("provenance")};
  const authority={hostIdentifier:"host:native-provisioner-fixture",sessionId:createStableId("workerHostSession"),applicationVersion:"fixture"};
  const initial={attemptId,expectedPlan,owner:authority,machineFingerprint:fence.scope.machineFingerprint,bindings,
    fencePlan:{namespace:fence.namespace,directory:fence.directory},command:{executable:process.execPath,
      arguments:["--experimental-strip-types",fileURLToPath(new URL(options.runner??"./synthetic-owned-runner.ts",import.meta.url))],
      workspace:directory,environment:Object.entries(environment).map(([key,value])=>`${key}=${value}`),
      input:options.input??JSON.stringify({text:"native ž 🚀"}),maximumOutputBytes:65536},...options.launch};
  const launch=options.transformLaunch?.(structuredClone(initial))??initial;
  const bridge=spawn("pwsh",["-NoLogo","-NoProfile","-NonInteractive","-File",fileURLToPath(new URL(options.hostScript??"../../native/windows-provisioner-host.ps1",import.meta.url))],
    {windowsHide:true,stdio:["pipe","pipe","pipe"],env:environment});
  assert.ok(bridge.pid); report(bridge.pid,"private provisioner bridge");
  const closed=once(bridge,"close"),exited=once(bridge,"exit"); void closed.catch(()=>{}); void exited.catch(()=>{});
  bridge.stdin.on("error",()=>{}); bridge.stderr.resume();
  const frames:Frame[]=[],decoder=new StringDecoder("utf8"); let buffered="",parseError:unknown,request:ProvisionerAdmissionRequest|undefined;
  bridge.stdout.on("data",(chunk:Buffer)=>{
    try {
      buffered+=decoder.write(chunk); let newline:number;
      while((newline=buffered.indexOf("\n"))>=0) {
        const frame=JSON.parse(buffered.slice(0,newline)) as Frame; buffered=buffered.slice(newline+1); frames.push(frame);
        if(frame.type==="ready") {request=parseProvisionerAdmissionRequest(frame.request);report(request.root.processId,"suspended native provisioner root");}
      }
    } catch(error){parseError=error;}
  });
  const send=(frame:unknown)=>bridge.stdin.write(JSON.stringify(frame)+"\n"); send(launch);
  async function next(types:string|readonly string[],timeout=9000):Promise<Frame> {
    const names=typeof types==="string"?[types]:types,until=Date.now()+timeout;
    while(Date.now()<until) {
      if(parseError) throw parseError;
      const index=frames.findIndex((frame)=>names.includes(frame.type as string));
      if(index>=0)return frames.splice(index,1)[0]!;
      if(bridge.exitCode!==null || bridge.signalCode!==null) throw new Error(`Provisioner closed before ${names.join(",")}: ${JSON.stringify(frames)}`);
      await pause(10);
    }
    throw new Error(`Provisioner frame timed out: ${names.join(",")}`);
  }
  function acknowledgement():ProvisionerAdmissionAcknowledgement {
    assert.ok(request); const admittedAt=utc6(Date.now());
    return {...structuredClone(request),fresh:true,hostIdentifier:authority.hostIdentifier,ownerSessionId:authority.sessionId,applicationVersion:authority.applicationVersion,
      treeIdentifier:`Local\\ACP.Provisioner.${attemptId}`,rootClaimOwnerId:attemptId,...expectedPlan,
      admittedAt,durationMilliseconds:Date.parse(expectedPlan.deadlineAt)-Date.parse(admittedAt)};
  }
  async function accept() {
    const ack=acknowledgement();send({type:"admit",acknowledgement:ack}); const frame=await next("accepted");
    assert.deepEqual(frame.acceptance,{...request,reservationRevision:expectedPlan.reservationRevision});
    return ack;
  }
  async function cleanup() {
    bridge.stdout.resume();
    if(bridge.exitCode===null && bridge.signalCode===null) {try{send({type:"stop"});bridge.stdin.end();}catch{bridge.stdin.destroy();}}
    const timer=setTimeout(()=>{if(bridge.exitCode===null && bridge.signalCode===null)bridge.kill();},6500);
    try{await closed;}finally{clearTimeout(timer);}
    for(const pid of pids) await gone(pid,5000);
  }
  return {bridge,closed,exited,frames,next,send,cleanup,accept,acknowledgement,launch,expectedPlan,authority,fence,attemptId,directory,report,fixture,bindings,
    fenceFile:join(fence.directory,attemptId+".provision"),get request(){assert.ok(request);return request;}};
}
