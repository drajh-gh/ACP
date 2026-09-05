import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStableId } from "@acp/domain";
import { observeWindowsRepository, observeWindowsWorktree } from "../../src/windows-repository-observer.ts";
import { minimalCodexEnvironment } from "../../src/codex-sdk-transport.ts";
import { gone } from "./native-lease-probe.ts";

export async function linkedPinFixture() {
  const owner=process.env.ACP_TEST_NATIVE_CHANNEL_ROOT,gitExecutable=process.env.ACP_TEST_GIT;
  assert.ok(owner && isAbsolute(owner) && gitExecutable && isAbsolute(gitExecutable));
  const root=await mkdtemp(join(owner,"case-")),checkout=join(root,"checkout ž 🚀"),workspace=join(root,"workspace ž 🚀");
  const pids=new Set<number>(),report=(pid:number,purpose:string) => { pids.add(pid); process.stdout.write(`Owned PID ${pid}: ${purpose}\n`); };
  async function git(cwd:string,...args:string[]) {
    const env=Object.fromEntries(["SystemRoot","WINDIR","TEMP","TMP"].flatMap((key) => process.env[key] ? [[key,process.env[key]!]] : []));
    Object.assign(env,{ GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"NUL",GIT_CONFIG_SYSTEM:"NUL",GIT_TERMINAL_PROMPT:"0" });
    const child=spawn(gitExecutable!,["-c","core.hooksPath=NUL","-c","commit.gpgsign=false","-C",cwd,...args],{ windowsHide:true,stdio:["ignore","pipe","pipe"],env });
    if(child.pid) report(child.pid,"linked pin disposable Git setup (8-second bound)");
    return new Promise<string>((done,reject) => {
      let output="",bytes=0,failed=false; const timer=setTimeout(() => { failed=true; child.kill(); },8000);
      child.stdout.setEncoding("utf8"); child.stdout.on("data",(data:string) => { output+=data; bytes+=Buffer.byteLength(data); if(bytes>16384) { failed=true; child.kill(); } });
      child.stderr.on("data",(data:Buffer) => { bytes+=data.length; if(bytes>16384) { failed=true; child.kill(); } });
      child.on("error",() => { failed=true; });
      child.on("close",(code) => { clearTimeout(timer); if(code===0 && !failed) done(output.trim()); else reject(new Error("owned linked pin Git setup failed")); });
    });
  }
  async function dispose() { const until=Date.now()+5000; for(const pid of pids) await gone(pid,Math.max(1,until-Date.now())); }
  try {
    await mkdir(checkout); await git(root,"init","--initial-branch=main",checkout);
    await git(checkout,"-c","user.name=ACP synthetic test","-c","user.email=acp@example.invalid","commit","--allow-empty","-m","Linked pin fixture");
    await git(checkout,"worktree","add","-b","Feature/PinnedCase",workspace);
    const options={ gitExecutable:gitExecutable!,onSpawn:report },signal=() => new AbortController().signal;
    const repo=await observeWindowsRepository(checkout,signal(),options);
    assert.equal(repo.state,"confirmed"); if(repo.state!=="confirmed") throw new Error("repository unavailable");
    const { state:_repoState,kind:_repoKind,...repositoryFields }=repo;
    const tree=await observeWindowsWorktree({ ...repositoryFields,repositoryBindingId:createStableId("repositoryBinding"),repositoryId:createStableId("repository"),
      projectId:createStableId("project"),provenanceId:createStableId("provenance") },workspace,signal(),options);
    assert.equal(tree.state,"confirmed"); if(tree.state!=="confirmed") throw new Error("worktree unavailable");
    const input={ machineFingerprint:repo.machineFingerprint,checkout:repo.checkout,commonGitDirectory:repo.commonGitDirectory,
      workspace:tree.workspace,gitDirectory:tree.gitDirectory };
    async function hold(value:unknown=input) {
      const child=spawn("pwsh",["-NoProfile","-NonInteractive","-File",fileURLToPath(new URL("./synthetic-linked-worktree-pins.ps1",import.meta.url))],
        { windowsHide:true,stdio:["pipe","pipe","pipe"],env:minimalCodexEnvironment() });
      assert.ok(child.pid); report(child.pid,"standalone linked-worktree pin helper (15-second bound)");
      const ready=Promise.withResolvers<string>(),closed=Promise.withResolvers<void>();
      let pending="",bytes=0,first=true;
      const timer=setTimeout(() => child.kill(),15000);
      child.stdout.setEncoding("utf8"); child.stdin.on("error",() => {}); child.on("error",() => { ready.resolve("rejected"); });
      child.stderr.on("data",(data:Buffer) => { bytes+=data.length; if(bytes>16384) child.kill(); });
      child.stdout.on("data",(data:string) => {
        pending+=data; bytes+=Buffer.byteLength(data); if(bytes>16384) { child.kill(); return; }
        while(pending.includes("\n")) {
          const end=pending.indexOf("\n"),line=pending.slice(0,end); pending=pending.slice(end+1);
          try { const frame=JSON.parse(line) as { state:string }; if(first) { first=false; ready.resolve(frame.state); } }
          catch { ready.resolve("rejected"); child.kill(); }
        }
      });
      child.on("close",() => { clearTimeout(timer); ready.resolve("rejected"); closed.resolve(); });
      child.stdin.write(JSON.stringify(value)+"\n");
      return { child,state:await ready.promise,closed:closed.promise,
        async release() { child.stdin.end("release\n"); await closed.promise; },async kill() { child.kill(); await closed.promise; } };
    }
    return { root,checkout,workspace,input,git,hold,dispose };
  } catch(error) { await dispose(); throw error; }
}
