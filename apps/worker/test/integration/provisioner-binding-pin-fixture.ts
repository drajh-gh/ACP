import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir,mkdtemp } from "node:fs/promises";
import { isAbsolute,join } from "node:path";
import { fileURLToPath } from "node:url";
import { minimalCodexEnvironment } from "../../src/codex-sdk-transport.ts";
import { describeWindowsProvisionerFence } from "../../src/windows-launch-fence.ts";
import { gone } from "./native-lease-probe.ts";

export async function provisionerBindingPinFixture() {
  const base=process.env.ACP_TEST_NATIVE_CHANNEL_ROOT,powershell=process.env.ACP_TEST_PWSH;
  assert.ok(base && isAbsolute(base) && powershell && isAbsolute(powershell));
  const root=await mkdtemp(join(base,"binding pins ž 🚀-")),parent=join(root,"targets"),repository=join(root,"repository"),common=join(repository,".git");
  await mkdir(parent);await mkdir(common,{recursive:true});
  const pids=new Set<number>(),holders:{kill():Promise<void>}[]=[];
  const report=(pid:number,purpose:string)=>{pids.add(pid);process.stdout.write(`Owned PID ${pid}: ${purpose}\n`);};
  async function cleanup(){await Promise.allSettled(holders.map(holder=>holder.kill()));for(const pid of pids)await gone(pid,5000);}
  try {
    const parentBinding=await describeWindowsProvisionerFence(parent,new AbortController().signal,{onSpawn:report});
    const commonBinding=await describeWindowsProvisionerFence(common,new AbortController().signal,{onSpawn:report});
    assert.equal(parentBinding.scope.machineFingerprint,commonBinding.scope.machineFingerprint);
    const input={machineFingerprint:parentBinding.scope.machineFingerprint,workspacePath:join(parent,"FutureCase"),
      parent:{path:parent,identity:parentBinding.directoryIdentity},commonGitDirectory:{path:common,identity:commonBinding.directoryIdentity}};
    async function hold(value:unknown=input) {
      const encoded=JSON.stringify(value);assert.ok(encoded.length<=16384);
      const child=spawn(powershell!,["-NoProfile","-NonInteractive","-File",fileURLToPath(new URL("./synthetic-provisioner-binding-pins.ps1",import.meta.url))],
        {windowsHide:true,stdio:["pipe","pipe","pipe"],env:minimalCodexEnvironment()});
      if(child.pid)report(child.pid,"standalone provisioner binding pin helper (20-second bound)");
      const ready=Promise.withResolvers<string>(),released=Promise.withResolvers<void>(),closed=Promise.withResolvers<void>();
      void released.promise.catch(()=>{});let buffered="",bytes=0,first=true,releaseSent=false,physicallyClosed=false;
      const kill=async()=>{if(!physicallyClosed)child.kill();await closed.promise;};
      const holder={child,closed:closed.promise,kill,async release(parallel=false){
        if(!releaseSent){releaseSent=true;child.stdin.write(parallel?"parallel\n":"release\n");}await released.promise;
      }};
      holders.push(holder);const timer=setTimeout(()=>{void kill();},20000);
      child.stdout.setEncoding("utf8");child.stdin.on("error",()=>{void kill();});child.on("error",()=>{ready.resolve("rejected");});
      child.stdout.on("error",()=>{void kill();});child.stderr.on("error",()=>{void kill();});
      child.stderr.on("data",(data:Buffer)=>{bytes+=data.length;if(bytes>16384)void kill();});
      child.stdout.on("data",(data:string)=>{
        buffered+=data;bytes+=Buffer.byteLength(data);if(bytes>16384){void kill();return;}
        while(buffered.includes("\n")){
          const end=buffered.indexOf("\n"),line=buffered.slice(0,end);buffered=buffered.slice(end+1);
          try{const frame=JSON.parse(line) as {state:string};if(first){first=false;ready.resolve(frame.state);}else if(frame.state==="released")released.resolve();else released.reject(new Error("pin fixture release failed"));}
          catch{ready.resolve("rejected");void kill();}
        }
      });
      child.once("close",()=>{physicallyClosed=true;clearTimeout(timer);ready.resolve("rejected");released.reject(new Error("pin helper closed before release"));closed.resolve();});
      child.stdin.write(encoded+"\n");return {...holder,state:await ready.promise};
    }
    return {root,parent,repository,common,input,hold,cleanup};
  } catch(error){await cleanup();throw error;}
}
