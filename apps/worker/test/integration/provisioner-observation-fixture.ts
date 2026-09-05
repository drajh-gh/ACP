import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createStableId } from "@acp/domain";
import { observeWindowsRepository, observeWindowsProvisionerTarget, parseWindowsProvisionerTargetObservation,
  type WindowsProvisionerTargetInput } from "../../src/windows-repository-observer.ts";
import { minimalCodexEnvironment } from "../../src/codex-sdk-transport.ts";
import { gone } from "./native-lease-probe.ts";

/** Every case lives beneath a UUID root created/removed by the outer owned job
 * gate, including hard timeouts. No case uses recursive cleanup or PID kills. */
export async function provisionerFixture(objectFormat:"sha1"|"sha256"="sha1") {
  const owner=process.env.ACP_TEST_NATIVE_CHANNEL_ROOT,gitExecutable=process.env.ACP_TEST_GIT;
  assert.ok(owner && isAbsolute(owner) && gitExecutable && isAbsolute(gitExecutable));
  const root=await mkdtemp(join(owner,"case-")),checkout=join(root,"checkout ž 🚀"),parent=join(root,"workspaces ž 🚀"),workspacePath=join(parent,"FutureCase");
  const pids=new Set<number>(),report=(pid:number,purpose:string)=>{ pids.add(pid); process.stdout.write(`Owned PID ${pid}: ${purpose}\n`); };
  async function git(cwd:string,...args:string[]) {
    const env=Object.fromEntries(["SystemRoot","WINDIR","TEMP","TMP"].flatMap((key)=>process.env[key] ? [[key,process.env[key]!]] : []));
    Object.assign(env,{ GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"NUL",GIT_CONFIG_SYSTEM:"NUL",GIT_TERMINAL_PROMPT:"0" });
    const child=spawn(gitExecutable!,["-c","core.hooksPath=NUL","-c","commit.gpgsign=false","-C",cwd,...args],{ windowsHide:true,stdio:["ignore","pipe","pipe"],env });
    if(child.pid) report(child.pid,"provisioner disposable Git setup (8-second bound)");
    return new Promise<string>((done,reject)=>{
      let output="",bytes=0,failed=false; const timer=setTimeout(()=>{ failed=true; child.kill(); },8000);
      child.stdout.setEncoding("utf8"); child.stdout.on("data",(data:string)=>{ output+=data; bytes+=Buffer.byteLength(data); if(bytes>16384) { failed=true; child.kill(); } });
      child.stderr.on("data",(data:Buffer)=>{ bytes+=data.length; if(bytes>16384) { failed=true; child.kill(); } });
      child.on("error",()=>{ failed=true; });
      child.on("close",(code)=>{ clearTimeout(timer); if(code===0 && !failed) done(output.trim()); else reject(new Error("owned provisioner Git setup failed")); });
    });
  }
  async function dispose() { const until=Date.now()+5000; for(const pid of pids) await gone(pid,Math.max(1,until-Date.now())); }
  try {
    await mkdir(checkout); await mkdir(parent); await git(root,"init","--initial-branch=main","--object-format="+objectFormat,checkout);
    await git(checkout,"-c","user.name=ACP synthetic test","-c","user.email=acp@example.invalid","commit","--allow-empty","-m","Provisioner observation fixture");
    const options={ gitExecutable:gitExecutable!,onSpawn:report },signal=()=>new AbortController().signal;
    const observed=await observeWindowsRepository(checkout,signal(),options); assert.equal(observed.state,"confirmed");
    if(observed.state!=="confirmed") throw new Error("repository unavailable");
    const { state:_state,kind:_kind,...fields }=observed;
    const repository={ ...fields,repositoryBindingId:createStableId("repositoryBinding"),repositoryId:createStableId("repository"),
      projectId:createStableId("project"),provenanceId:createStableId("provenance") };
    const input={ workspacePath,branchRef:"refs/heads/Feature/ExactCase",baseRevision:await git(checkout,"rev-parse","HEAD") };
    const observe=(change:Partial<WindowsProvisionerTargetInput>={})=>observeWindowsProvisionerTarget(repository,{ ...input,...change },signal(),options);
    /** Deterministic native interleaving while the fifth Git child is still
     * suspended; the production onSpawn callback runs before Resume. */
    async function probe(action:"target"|"branch"|"packed"|"pins"|"directory-pins") {
      const child=spawn("pwsh",["-NoProfile","-NonInteractive","-File",fileURLToPath(new URL("./synthetic-provisioner-observation.ps1",import.meta.url))],
        { windowsHide:true,stdio:["pipe","pipe","pipe"],env:minimalCodexEnvironment() });
      assert.ok(child.pid); report(child.pid,"provisioner deterministic native fault probe (18-second bound)");
      return new Promise<{ observation:ReturnType<typeof parseWindowsProvisionerTargetObservation>; applied:boolean; pinsDenied:boolean }>((done,reject)=>{
        let pending="",bytes=0,invalid=false,result:Record<string,unknown>|undefined;
        const timer=setTimeout(()=>{ invalid=true; child.kill(); },18000);
        child.stdin.on("error",()=>{}); child.on("error",()=>{ invalid=true; }); child.stdout.setEncoding("utf8");
        child.stderr.on("data",(data:Buffer)=>{ bytes+=data.length; if(bytes>32768) { invalid=true; child.kill(); } });
        child.stdout.on("data",(data:string)=>{
          pending+=data; bytes+=Buffer.byteLength(data); if(bytes>32768) { invalid=true; child.kill(); return; }
          while(pending.includes("\n")) {
            const end=pending.indexOf("\n"),line=pending.slice(0,end); pending=pending.slice(end+1);
            try { const frame=JSON.parse(line) as Record<string,unknown>;
              if(frame.type==="process" && Number.isSafeInteger(frame.pid) && (frame.pid as number)>0) report(frame.pid as number,"fault probe owned Git child (16-second bound)");
              else if(frame.type==="result" && !result) result=frame; else invalid=true;
            } catch { invalid=true; }
          }
        });
        child.on("close",(code)=>{ clearTimeout(timer);
          if(code!==0 || invalid || !result || pending.trim()) reject(new Error("provisioner fault probe unavailable"));
          else {
            if(action==="pins") process.stdout.write(`Pin probe denial details: parent=${String(result.parentDenied)}, packed=${String(result.packedDenied)}\n`);
            done({ observation:parseWindowsProvisionerTargetObservation(result.observation),applied:result.applied===true,pinsDenied:result.pinsDenied===true });
          }
        });
        child.stdin.end(JSON.stringify({ repository,input,gitExecutable,action,deadlineAt:new Date(Date.now()+16000).toISOString() })+"\n");
      });
    }
    return { root,checkout,parent,repository,input,options,signal,observe,git,probe,dispose };
  } catch(error) { await dispose(); throw error; }
}

export async function metadataSnapshot(root:string) {
  const result:Record<string,string>={};
  for(const entry of await readdir(root,{ recursive:true,withFileTypes:true })) {
    if(entry.isFile()) { const path=join(entry.parentPath,entry.name); result[relative(root,path)]=createHash("sha256").update(await readFile(path)).digest("hex"); }
    assert.ok(Object.keys(result).length<100,"fixture snapshot bound");
  }
  return result;
}
