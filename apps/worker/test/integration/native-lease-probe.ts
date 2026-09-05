import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createStableId } from "@acp/domain";
import { minimalCodexEnvironment } from "../../src/codex-sdk-transport.ts";

export type Frame = Record<string, unknown>;
export async function probe(runner="nonreading-owned-runner.ts",deadlineMs=30000,onSpawn?: (pid: number,purpose: string) => void,
  identityOverrides: Partial<{ leaseId:string; runId:string; workerProcessId:string }>={}) {
  const environment=minimalCodexEnvironment();
  const { workerProcessId,leaseId,runId }={ workerProcessId:createStableId("workerProcess"),leaseId:createStableId("lease"),runId:createStableId("run"),...identityOverrides };
  const bridge=spawn("pwsh",["-NoLogo","-NoProfile","-NonInteractive","-File",
    fileURLToPath(new URL("../../native/windows-worker-host.ps1",import.meta.url))],
  { windowsHide:true,stdio:["pipe","pipe","pipe"],env:environment });
  assert.ok(bridge.pid); process.stdout.write(`Owned PID ${bridge.pid}: native lease-watchdog bridge\n`);
  onSpawn?.(bridge.pid,"native lease-watchdog bridge");
  const exited=once(bridge,"exit"); bridge.stderr.resume(); bridge.stdin.on("error",() => {});
  const frames: Frame[]=[]; let buffered="",rootPid: number | undefined;
  bridge.stdout.on("data",(chunk: Buffer) => {
    buffered+=chunk.toString("utf8"); let end: number;
    while ((end=buffered.indexOf("\n"))>=0) {
      const frame=JSON.parse(buffered.slice(0,end)) as Frame; buffered=buffered.slice(end+1); frames.push(frame);
      if (frame.type==="ready") {
        rootPid=frame.processId as number; process.stdout.write(`Owned PID ${rootPid}: leased synthetic runner\n`);
        onSpawn?.(rootPid,"leased synthetic runner");
      }
    }
  });
  const send=(frame: Frame) => bridge.stdin.write(JSON.stringify(frame)+"\n");
  send({ workerProcessId,deadlineAt:new Date(Date.now()+deadlineMs).toISOString(),executable:process.execPath,
    arguments:["--experimental-strip-types",fileURLToPath(new URL(`./${runner}`,import.meta.url))],workspace:process.cwd(),
    maximumOutputBytes:1048576,environment:Object.entries(environment).map(([key,value]) => `${key}=${value}`),
    filesystemLease:{ leaseId,runId,workerProcessId } });
  async function next(type: string | readonly string[],timeout=8000): Promise<Frame> {
    const types=typeof type==="string" ? [type] : type;
    const deadline=Date.now()+timeout;
    while (Date.now()<deadline) {
      const found=frames.findIndex((frame) => types.includes(frame.type as string));
      if (found>=0) return frames.splice(found,1)[0]!;
      if (bridge.exitCode!==null || bridge.signalCode!==null) throw new Error(`native bridge closed before ${type}: ${JSON.stringify(frames)}`);
      await new Promise((done) => setTimeout(done,10));
    }
    throw new Error(`native frame ${type} timed out`);
  }
  async function close() {
    if (bridge.exitCode===null && bridge.signalCode===null) { send({ type:"stop" }); bridge.stdin.end(); }
    const timer=setTimeout(() => bridge.kill(),6500);
    try { await exited; } finally { clearTimeout(timer); bridge.stdout.resume(); }
    if (rootPid!==undefined) await gone(rootPid,2000);
    await gone(bridge.pid!,2000);
  }
  return { bridge,exited,next,send,close,frames,identity:{ leaseId,runId,workerProcessId },get rootPid() { return rootPid; } };
}
export async function gone(pid: number,timeout=6000) {
  const deadline=Date.now()+timeout;
  while (Date.now()<deadline) {
    try { process.kill(pid,0); } catch (error) { if ((error as NodeJS.ErrnoException).code==="ESRCH") return; throw error; }
    await new Promise((done) => setTimeout(done,15));
  }
  assert.fail(`Owned PID ${pid} did not exit within ${timeout} ms`);
}

export function commit(p: Awaited<ReturnType<typeof probe>>,challenge: Frame,revision: number,durationMilliseconds: number,overrides: Frame={}) {
  p.send({ type:"lease-commit",...p.identity,nonce:challenge.nonce,epoch:challenge.epoch,revision,durationMilliseconds,...overrides });
}
export async function accept(p: Awaited<ReturnType<typeof probe>>,challenge: Frame,revision: number,durationMilliseconds: number) {
  commit(p,challenge,revision,durationMilliseconds);
  assert.deepEqual(await p.next("lease-accepted"),{ type:"lease-accepted",nonce:challenge.nonce,epoch:challenge.epoch,revision });
}
export async function challenge(p: Awaited<ReturnType<typeof probe>>) { p.send({ type:"lease-challenge" }); return p.next("lease-challenge"); }
