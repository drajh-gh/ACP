import assert from "node:assert/strict";
import { mkdir,mkdtemp } from "node:fs/promises";
import { isAbsolute,join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProvisionerAdmissionAcknowledgement,ProvisionerAdmissionRequest,WorktreeProvisionerAttempt } from "@acp/storage";
import { WindowsProvisionerProcessRunner } from "../../src/windows-provisioner-runner.ts";
import type { OwnedProvisionerHandle } from "../../src/windows-provisioner-process.ts";
import { describeWindowsProvisionerFence } from "../../src/windows-launch-fence.ts";
import { provisionerPlanFixture,utc6 } from "../provisioner-plan-fixture.ts";
import { gone } from "./native-lease-probe.ts";

/** Real native identity and process ownership, synthetic retained metadata/ACKs. */
export async function nativeProvisionerRunnerProbe(runner="./synthetic-provisioner-plan-runner.ts") {
  const base=process.env.ACP_TEST_NATIVE_CHANNEL_ROOT,powershell=process.env.ACP_TEST_PWSH;
  assert.ok(base && isAbsolute(base) && powershell && isAbsolute(powershell),"owned fixture and exact PowerShell required");
  const directory=await mkdtemp(join(base,"runner ž 🚀-")),fenceDirectory=join(directory,"fence"),commonPath=join(directory,"synthetic-repository",".git");await mkdir(fenceDirectory);await mkdir(commonPath,{recursive:true});
  const pids=new Set<number>(),handles:OwnedProvisionerHandle[]=[],abort=new AbortController();
  const report=(pid:number,purpose:string)=>{pids.add(pid);process.stdout.write(`Owned PID ${pid}: ${purpose}\n`);};
  const parent=await describeWindowsProvisionerFence(directory,new AbortController().signal,{onSpawn:report});
  const common=await describeWindowsProvisionerFence(commonPath,new AbortController().signal,{onSpawn:report});assert.deepEqual(common.scope,parent.scope);
  const plan=provisionerPlanFixture({reportedParent:{path:directory,identity:parent.directoryIdentity,observedAt:utc6(Date.now()-1000)},
    fencePlan:{namespace:"acp-worktree-provisioner-v1",directory:fenceDirectory},workspacePath:join(directory,"future"),machineFingerprint:parent.scope.machineFingerprint,
    commonGitDirectory:{path:commonPath,identity:common.directoryIdentity}});
  const authority={hostIdentifier:plan.hostIdentifier,sessionId:plan.ownerSessionId,applicationVersion:plan.applicationVersion};
  const options={runnerPath:fileURLToPath(new URL(runner,import.meta.url)),powershellExecutable:powershell,onSpawn:report};
  const owner=new WindowsProvisionerProcessRunner(authority,options);
  async function start(input=plan){const handle=await owner.start(input,abort.signal);handles.push(handle);return handle;}
  async function cleanup(){abort.abort();await Promise.allSettled(handles.map(handle=>handle.terminate()));for(const pid of pids)await gone(pid,5000);}
  return {plan,authority,options,owner,start,cleanup,abort,pids,directory,fenceFile:join(fenceDirectory,plan.attemptId+".provision")};
}
export function syntheticProvisionerAck(request:ProvisionerAdmissionRequest,plan:WorktreeProvisionerAttempt):ProvisionerAdmissionAcknowledgement {
  const admittedAt=utc6(Date.now());
  return {...request,reservationId:plan.reservationId,reservationRevision:plan.reservationRevision,deadlineAt:plan.deadlineAt,provenanceId:plan.provenanceId,
    fresh:true,hostIdentifier:plan.hostIdentifier,ownerSessionId:plan.ownerSessionId,applicationVersion:plan.applicationVersion,
    treeIdentifier:`Local\\ACP.Provisioner.${plan.attemptId}`,rootClaimOwnerId:plan.attemptId,admittedAt,durationMilliseconds:Date.parse(plan.deadlineAt)-Date.parse(admittedAt)};
}
