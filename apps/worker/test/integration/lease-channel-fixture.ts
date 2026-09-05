import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createStableId } from "@acp/domain";
import type { FilesystemWriterLease } from "@acp/storage";
import { WindowsWorkerLauncher, type OwnedWorker } from "../../src/windows-worker-launcher.ts";
import { NativeFilesystemWriterController } from "../../src/native-filesystem-writer-controller.ts";
import { gone } from "./native-lease-probe.ts";
import { describeWindowsLaunchFence } from "../../src/windows-launch-fence.ts";

/** Real native processes, synthetic database responses; no model credentials. */
export async function leaseChannelFixture(renewalIntervalMs=1000) {
  const caller=new AbortController(),pids=new Set<number>();
  const directory=await mkdtemp(join(tmpdir(),"acp-lease-channel-"));
  const onSpawn=({ processId,purpose }: { processId:number; purpose:string }) => {
    pids.add(processId); process.stdout.write(`Owned PID ${processId}: ${purpose}\n`);
  };
  async function cleanup(worker?: OwnedWorker) {
    await worker?.terminate().catch(() => {});
    const until=Date.now()+6000;
    for (const pid of pids) await gone(pid,Math.max(1,until-Date.now()));
    const target=resolve(directory);
    if (dirname(target)!==resolve(tmpdir()) || !target.startsWith(join(resolve(tmpdir()),"acp-lease-channel-"))) throw new Error("unsafe fixture cleanup");
    await rm(target,{ recursive:true,force:true });
  }
  let fence;
  try { fence=await describeWindowsLaunchFence(directory,caller.signal,{ onSpawn:(processId,purpose) => onSpawn({ processId,purpose }) }); }
  catch (error) { await cleanup(); throw error; }
  const authority={ hostIdentifier:"host:native-channel-test",sessionId:createStableId("workerHostSession"),applicationVersion:"channel-test" };
  let lease: FilesystemWriterLease={ leaseId:createStableId("lease"),runId:createStableId("run"),workerProcessId:createStableId("workerProcess"),
    worktreeBindingId:createStableId("worktreeBinding"),repositoryBindingId:createStableId("repositoryBinding"),provenanceId:createStableId("provenance"),
    hostIdentifier:authority.hostIdentifier,ownerSessionId:authority.sessionId,applicationVersion:authority.applicationVersion,
    workspaceKey:"logical-workspace",physicalWorkspaceKey:"physical-workspace",physicalRepositoryKey:"physical-repository",branchKey:"logical-branch",
    acquiredAt:"2000-01-01T00:00:00.000Z",heartbeatAt:"2000-01-01T00:00:00.000Z",expiresAt:"2000-01-01T00:00:20.000Z",
    revision:1,releasedAt:null,state:"active" };
  let loads=0,renewals=0,bindingReads=0;
  const deadlineAt=new Date(Date.now()+30000).toISOString(),workspace=process.cwd();
  const writers={ authority,async load(): Promise<FilesystemWriterLease | undefined> { loads++; return { ...lease }; },
    async loadLaunchBinding() { bindingReads++; return { lease:{ ...lease },intent:{ workerProcessId:lease.workerProcessId,fence:structuredClone(fence) },workspace,deadlineAt }; },
    async heartbeat(): Promise<FilesystemWriterLease> { renewals++; lease={ ...lease,revision:lease.revision+1 }; return { ...lease }; } };
  const options={ runnerPath:fileURLToPath(new URL("./synthetic-owned-runner.ts",import.meta.url)),
    filesystemWriterController:new NativeFilesystemWriterController(writers,{ renewalIntervalMs }),
    onSpawn };
  const request={ workerProcessId:lease.workerProcessId,deadlineAt,workspace,launchFence:fence,
    maximumOutputBytes:4096,signal:caller.signal,filesystemLease:{ leaseId:lease.leaseId,runId:lease.runId,workerProcessId:lease.workerProcessId } };
  return { caller,pids,writers,options,request,launcher:new WindowsWorkerLauncher(options),cleanup,
    get lease() { return lease; },set lease(value) { lease=value; },get bindingReads() { return bindingReads; },get counts() { return { loads,renewals }; } };
}
