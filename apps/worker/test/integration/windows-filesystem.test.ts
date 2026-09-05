import assert from "node:assert/strict";
import { it } from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile, symlink, link, open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { createStableId } from "@acp/domain";
import type { RepositoryBindingInput } from "@acp/storage";
import { observeWindowsRepository, observeWindowsWorktree } from "../../src/windows-repository-observer.ts";

const native = process.platform === "win32", gitExecutable = process.env.ACP_TEST_GIT!;
const signal = () => new AbortController().signal;
const pids = new Set<number>();
const report = (pid: number,purpose: string) => { pids.add(pid); process.stdout.write(`Owned PID ${pid}: ${purpose}\n`); };
const options = { gitExecutable,onSpawn:report };
async function git(cwd: string,...args: string[]): Promise<string> {
  const env = Object.fromEntries(["SystemRoot","WINDIR","TEMP","TMP"].flatMap((key) => process.env[key] ? [[key,process.env[key]!]] : []));
  Object.assign(env,{ GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"NUL",GIT_CONFIG_SYSTEM:"NUL",GIT_TERMINAL_PROMPT:"0" });
  const child = spawn(gitExecutable,["-c","core.hooksPath=NUL","-c","commit.gpgsign=false","-C",cwd,...args],{ windowsHide:true,stdio:["ignore","pipe","pipe"],env });
  if (child.pid) report(child.pid,"disposable Git fixture setup (10-second bound)");
  return new Promise((done,reject) => {
    let stdout="",stderr="",overflow=false;
    const timer=setTimeout(() => { overflow=true; child.kill(); },10000);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data",(data: string) => { stdout+=data; if (stdout.length+stderr.length>16384) { overflow=true; child.kill(); } });
    child.stderr.on("data",(data: string) => { stderr+=data; if (stdout.length+stderr.length>16384) { overflow=true; child.kill(); } });
    child.on("error",reject); child.on("close",(code) => { clearTimeout(timer); if (code!==0 || overflow) reject(new Error(`fixture Git failed: ${stderr}`)); else done(stdout.trim()); });
  });
}
async function gone() {
  const until=Date.now()+5000;
  while (Date.now()<until) {
    for (const pid of pids) { try { process.kill(pid,0); } catch (error) { if ((error as NodeJS.ErrnoException).code==="ESRCH") pids.delete(pid); else throw error; } }
    if (!pids.size) return;
    await new Promise((done) => setTimeout(done,20));
  }
  assert.fail(`owned observer processes remain: ${[...pids].join(",")}`);
}
async function fixture() {
  assert.ok(gitExecutable && isAbsolute(gitExecutable),"gate must select an absolute trusted Git executable");
  const root=await mkdtemp(join(tmpdir(),"acp-filesystem-test-")),checkout=join(root,"repository ž 🚀"),workspace=join(root,"workspace ž 🚀");
  const dispose=async () => {
    await gone(); const location=resolve(root), local=relative(resolve(tmpdir()),location);
    assert.ok(local.startsWith("acp-filesystem-test-") && !local.includes("..") && !isAbsolute(local));
    await rm(location,{ recursive:true,force:true });
  };
  try {
    await mkdir(checkout); await git(root,"init","--initial-branch=main",checkout);
    await git(checkout,"-c","user.name=ACP synthetic test","-c","user.email=acp@example.invalid","commit","--allow-empty","-m","Synthetic observation fixture");
    await git(checkout,"worktree","add","-b","Feature/CaseSensitive",workspace);
    const observed=await observeWindowsRepository(checkout,signal(),options); assert.equal(observed.state,"confirmed");
    if (observed.state!=="confirmed") throw new Error("repository observation unavailable");
    const { state:_state,kind:_kind,...observation }=observed;
    const repository: RepositoryBindingInput={ ...observation,repositoryBindingId:createStableId("repositoryBinding"),repositoryId:createStableId("repository"),
      projectId:createStableId("project"),provenanceId:createStableId("provenance") };
    return { root,checkout,workspace,repository,dispose };
  } catch (error) { await dispose(); throw error; }
}
async function metadataSnapshot(root: string): Promise<Record<string,string>> {
  const output: Record<string,string>={};
  for (const entry of await readdir(root,{ recursive:true,withFileTypes:true })) {
    if (entry.isFile()) { const path=join(entry.parentPath,entry.name); output[relative(root,path)]=createHash("sha256").update(await readFile(path)).digest("hex"); }
    assert.ok(Object.keys(output).length<100,"fixture snapshot must remain bounded");
  }
  return output;
}
it("observes real Unicode checkout/worktree identities without changing Git metadata or invoking configured hooks",{ skip:!native,timeout:25000 },async () => {
  const f=await fixture();
  try {
    const sentinel=join(f.root,"must-not-exist");
    await git(f.checkout,"config","core.fsmonitor",`!echo unexpected > "${sentinel}"`);
    await git(f.checkout,"config","core.hooksPath",join(f.root,"untrusted-hooks"));
    const before=await metadataSnapshot(f.repository.commonGitDirectory.path);
    const observed=await observeWindowsWorktree(f.repository,f.workspace,signal(),options);
    assert.equal(observed.state,"confirmed");
    if (observed.state==="confirmed") {
      assert.equal(observed.branchRef,"refs/heads/Feature/CaseSensitive");
      assert.equal(observed.headRevision,await git(f.workspace,"rev-parse","HEAD"));
      assert.notEqual(observed.workspace.identity,f.repository.checkout.identity);
      assert.match(observed.gitDirectory.identity,/^win32-dir:/u);
    }
    assert.deepEqual(await metadataSnapshot(f.repository.commonGitDirectory.path),before);
    await assert.rejects(readFile(sentinel),{ code:"ENOENT" });
    assert.deepEqual(await observeWindowsRepository(f.workspace,signal(),options),{ state:"unconfirmed" });
  } finally { await f.dispose(); }
});
it("rejects changed repository identities, wrong machine and ancestor junction aliases",{ skip:!native,timeout:25000 },async () => {
  const f=await fixture();
  try {
    assert.deepEqual(await observeWindowsWorktree({ ...f.repository,machineFingerprint:"0".repeat(64) },f.workspace,signal(),options),{ state:"unconfirmed" });
    assert.deepEqual(await observeWindowsWorktree({ ...f.repository,checkout:{ ...f.repository.checkout,identity:"win32-dir:00000000:0000000000000000" } },f.workspace,signal(),options),{ state:"unconfirmed" });
    const alias=join(f.root,"junction"); await symlink(f.checkout,alias,"junction");
    assert.deepEqual(await observeWindowsRepository(alias,signal(),options),{ state:"unconfirmed" });
    await rm(alias); // Exact owned junction only, not its target.
    const old=join(f.root,"old-checkout"); await rename(f.checkout,old); await mkdir(f.checkout);
    assert.deepEqual(await observeWindowsWorktree(f.repository,f.workspace,signal(),options),{ state:"unconfirmed" });
  } finally { await f.dispose(); }
});
it("rejects hardlinked and contradictory worktree pointers without modifying them",{ skip:!native,timeout:25000 },async () => {
  const f=await fixture();
  try {
    const dotGit=join(f.workspace,".git"),copy=join(f.root,"pointer-copy"); await link(dotGit,copy);
    assert.deepEqual(await observeWindowsWorktree(f.repository,f.workspace,signal(),options),{ state:"unconfirmed" });
    await rm(copy);
    const metadata=(await readFile(dotGit,"utf8")).trim().slice(8),reverse=join(metadata,"gitdir"),original=await readFile(reverse);
    await writeFile(reverse,join(f.checkout,".git")+"\n");
    assert.deepEqual(await observeWindowsWorktree(f.repository,f.workspace,signal(),options),{ state:"unconfirmed" });
    await writeFile(reverse,original);
    await rm(dotGit); // Hidden .git cannot be truncated through Windows CREATE_ALWAYS.
    await writeFile(dotGit,"gitdir: C:\\not-the-selected-repository\n");
    assert.deepEqual(await observeWindowsWorktree(f.repository,f.workspace,signal(),options),{ state:"unconfirmed" });
  } finally { await f.dispose(); }
});
it("rejects detached, unborn and missing-commit worktree HEADs without lazy object fetching",{ skip:!native,timeout:25000 },async () => {
  const f=await fixture();
  try {
    const revision=await git(f.workspace,"rev-parse","HEAD");
    await git(f.workspace,"checkout","--detach",revision);
    assert.deepEqual(await observeWindowsWorktree(f.repository,f.workspace,signal(),options),{ state:"unconfirmed" });
    await git(f.workspace,"symbolic-ref","HEAD","refs/heads/Unborn");
    assert.deepEqual(await observeWindowsWorktree(f.repository,f.workspace,signal(),options),{ state:"unconfirmed" });
    await git(f.workspace,"symbolic-ref","HEAD","refs/heads/Feature/CaseSensitive");
    await git(f.checkout,"config","extensions.partialClone","origin");
    await git(f.checkout,"config","remote.origin.promisor","true");
    await git(f.checkout,"config","remote.origin.url",join(f.root,"absent-local-promisor"));
    const object=join(f.repository.commonGitDirectory.path,"objects",revision.slice(0,2),revision.slice(2));
    await rename(object,join(f.root,"retained-test-object"));
    const before=await metadataSnapshot(f.repository.commonGitDirectory.path);
    assert.deepEqual(await observeWindowsWorktree(f.repository,f.workspace,signal(),options),{ state:"unconfirmed" });
    assert.deepEqual(await metadataSnapshot(f.repository.commonGitDirectory.path),before);
  } finally { await f.dispose(); }
});
it("ignores poisoned inherited Git environment and cleans up after cancellation",{ skip:!native,timeout:25000 },async () => {
  const f=await fixture();
  const poison={ GIT_DIR:join(f.root,"absent"),GIT_WORK_TREE:join(f.root,"wrong"),GIT_CONFIG_COUNT:"1",GIT_CONFIG_KEY_0:"core.bare",GIT_CONFIG_VALUE_0:"true",
    GIT_TRACE:join(f.root,"unexpected-trace"),GIT_ASKPASS:"untrusted-askpass" };
  const previous=Object.fromEntries(Object.keys(poison).map((key) => [key,process.env[key]]));
  try {
    Object.assign(process.env,poison);
    assert.equal((await observeWindowsWorktree(f.repository,f.workspace,signal(),options)).state,"confirmed");
    await assert.rejects(readFile(poison.GIT_TRACE),{ code:"ENOENT" });
    const controller=new AbortController();
    const cancelled=await observeWindowsWorktree(f.repository,f.workspace,controller.signal,{ ...options,onSpawn:(pid,purpose) => { report(pid,purpose); controller.abort(); } });
    assert.deepEqual(cancelled,{ state:"unconfirmed" }); await gone();
    const duringGit=new AbortController();
    assert.deepEqual(await observeWindowsWorktree(f.repository,f.workspace,duringGit.signal,{ ...options,onSpawn:(pid,purpose) => {
      report(pid,purpose); if (purpose.includes("Git child")) duringGit.abort();
    } }),{ state:"unconfirmed" });
    assert.equal(duringGit.signal.aborted,true); await gone();
    assert.deepEqual(await observeWindowsRepository(f.checkout,signal(),{ ...options,gitExecutable:join(f.root,"missing","git.exe") }),{ state:"unconfirmed" });
  } finally {
    for (const [key,value] of Object.entries(previous)) { if (value===undefined) delete process.env[key]; else process.env[key]=value; }
    await f.dispose();
  }
});
it("held native metadata pins block writes and namespace replacement until the observer exits",{ skip:!native,timeout:25000 },async () => {
  const f=await fixture(); let child: ReturnType<typeof spawn> | undefined; let closed: Promise<unknown> | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    child=spawn("pwsh",["-NoProfile","-NonInteractive","-File",fileURLToPath(new URL("./synthetic-filesystem-pin-holder.ps1",import.meta.url))],
      { windowsHide:true,stdio:["pipe","pipe","pipe"] });
    assert.ok(child.pid); report(child.pid,"synthetic held filesystem pins (8-second bound)");
    closed=once(child,"close"); timer=setTimeout(() => child?.kill(),8000);
    child.stderr!.resume(); child.stdin!.on("error",() => {});
    const ready=new Promise<void>((done,reject) => {
      let text=""; child!.stdout!.setEncoding("utf8"); child!.stdout!.on("data",(part: string) => { text+=part; if (text.includes("\n")) {
        try { assert.equal(JSON.parse(text.trim()).ready,true); done(); } catch (error) { reject(error); }
      } }); child!.on("error",reject); child!.on("close",() => { if (!text.includes("\n")) reject(new Error("pin probe exited before ready")); });
    });
    child.stdin!.write(JSON.stringify({ directory:f.workspace,leaf:".git" })+"\n"); await ready;
    await assert.rejects(open(join(f.workspace,".git"),"r+"),/EPERM|EBUSY|EACCES/u);
    await assert.rejects(rename(f.workspace,join(f.root,"moved-workspace")),/EPERM|EBUSY|EACCES/u);
    await assert.rejects(rename(f.root,f.root+"-moved"),/EPERM|EBUSY|EACCES/u);
    await assert.rejects(rm(join(f.workspace,".git")),/EPERM|EBUSY|EACCES/u);
    child.stdin!.end("release\n"); await closed; clearTimeout(timer); timer=undefined;
    const released=await open(join(f.workspace,".git"),"r+"); await released.close();
  } finally {
    if (timer) clearTimeout(timer); if (child && child.exitCode===null && child.signalCode===null) child.kill(); await closed; await f.dispose();
  }
});
it("rejects repository-local includes, worktree config and alternate object stores before starting Git",{ skip:!native,timeout:25000 },async () => {
  const f=await fixture();
  try {
    const config=join(f.repository.commonGitDirectory.path,"config"),original=await readFile(config);
    for (const entry of ["\n[include]\n\tpath = C:/must-not-read/config\n","\n[includeIf \"gitdir:**\"]\n\tpath = C:/must-not-read/config\n",
      "\n[core]\n\tworktree = C:/different-checkout\n","\n[extensions]\n\tworktreeConfig = true\n"]) {
      await writeFile(config,Buffer.concat([original,Buffer.from(entry)]));
      let gitSpawned=false;
      assert.deepEqual(await observeWindowsWorktree(f.repository,f.workspace,signal(),{ ...options,onSpawn:(pid,purpose) => { report(pid,purpose); if (purpose.includes("Git child")) gitSpawned=true; } }),{ state:"unconfirmed" });
      assert.equal(gitSpawned,false);
    }
    await writeFile(config,original);
    for (const leaf of ["alternates","http-alternates"]) {
      const path=join(f.repository.commonGitDirectory.path,"objects","info",leaf); await writeFile(path,"C:/must-not-read/objects\n");
      let gitSpawned=false;
      assert.deepEqual(await observeWindowsWorktree(f.repository,f.workspace,signal(),{ ...options,onSpawn:(pid,purpose) => { report(pid,purpose); if (purpose.includes("Git child")) gitSpawned=true; } }),{ state:"unconfirmed" });
      assert.equal(gitSpawned,false); await rm(path);
    }
  } finally { await f.dispose(); }
});
