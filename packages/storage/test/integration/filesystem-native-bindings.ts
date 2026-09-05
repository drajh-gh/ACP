import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import type { Pool } from "pg";
import { createStableId } from "@acp/domain";
import { PostgresRepositoryBindingStore, type RepositoryBindingInput, type WorktreeBindingInput } from "../../src/index.ts";
import { observeWindowsRepository, observeWindowsWorktree } from "../../../../apps/worker/src/windows-repository-observer.ts";
import { launchRecoveryFixture } from "./launch-recovery-fixture.ts";

export async function runNativeFilesystemBindings(pool: Pool) {
  if (process.platform !== "win32") throw new Error("native filesystem gate requires Windows");
  const gitExecutable=process.env.ACP_TEST_GIT; assert.ok(gitExecutable && isAbsolute(gitExecutable));
  const pids=new Set<number>(),report=(pid: number,purpose: string) => { pids.add(pid); process.stdout.write(`Owned PID ${pid}: ${purpose}\n`); };
  const options={ gitExecutable,onSpawn:report },signal=() => new AbortController().signal;
  const root=await mkdtemp(join(tmpdir(),"acp-filesystem-pg-test-")),checkout=join(root,"checkout ž 🚀"),workspace=join(root,"workspace ž 🚀");
  async function git(...args: string[]) {
    const env=Object.fromEntries(["SystemRoot","WINDIR","TEMP","TMP"].flatMap((key) => process.env[key] ? [[key,process.env[key]!]] : []));
    Object.assign(env,{ GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"NUL",GIT_CONFIG_SYSTEM:"NUL",GIT_TERMINAL_PROMPT:"0" });
    const child=spawn(gitExecutable!,["-c","core.hooksPath=NUL","-c","commit.gpgsign=false",...args],{ cwd:root,windowsHide:true,stdio:["ignore","pipe","pipe"],env });
    if (child.pid) report(child.pid,"native/database disposable Git setup (8-second bound)");
    await new Promise<void>((done,reject) => {
      let bytes=0,failed=false; const timer=setTimeout(() => { failed=true; child.kill(); },8000);
      const drain=(chunk: Buffer) => { bytes+=chunk.length; if (bytes>16384) { failed=true; child.kill(); } };
      child.stdout.on("data",drain); child.stderr.on("data",drain); child.on("error",reject);
      child.on("close",(code) => { clearTimeout(timer); if (code===0 && !failed) done(); else reject(new Error("disposable Git fixture setup failed")); });
    });
  }
  try {
    await mkdir(checkout); await git("init","--initial-branch=main",checkout);
    await git("-C",checkout,"-c","user.name=ACP synthetic test","-c","user.email=acp@example.invalid","commit","--allow-empty","-m","Native database fixture");
    await git("-C",checkout,"worktree","add","-b","Feature/NativeCase",workspace);
    const f=await launchRecoveryFixture(pool,"host:filesystem-native-check","0013"),a=await f.assignment();
    const store=new PostgresRepositoryBindingStore(pool,f.runtime);
    async function provenance() {
      const id=createStableId("provenance");
      await pool.query(`INSERT INTO acp.runtime_provenance SELECT (jsonb_populate_record(NULL::acp.runtime_provenance,to_jsonb(p)
        ||jsonb_build_object('provenance_id',$1::text,'recorded_at',clock_timestamp()))).* FROM acp.runtime_provenance p WHERE provenance_id=$2`,[id,f.template]);
      return id;
    }
    const repositoryObservation=await observeWindowsRepository(checkout,signal(),options);
    assert.equal(repositoryObservation.state,"confirmed"); if (repositoryObservation.state!=="confirmed") throw new Error("native repository observation unavailable");
    const { state:_state,kind:_kind,...repositoryFields }=repositoryObservation;
    const repository: RepositoryBindingInput={ ...repositoryFields,repositoryBindingId:createStableId("repositoryBinding"),repositoryId:createStableId("repository"),
      projectId:a.packet.projectId,provenanceId:await provenance() };
    assert.deepEqual(await store.recordRepository(repository),repository);
    const loaded=await store.loadRepository(repository.repositoryBindingId); assert.ok(loaded && !loaded.retired);
    const worktreeObservation=await observeWindowsWorktree(loaded.binding,workspace,signal(),options);
    assert.equal(worktreeObservation.state,"confirmed"); if (worktreeObservation.state!=="confirmed") throw new Error("native worktree observation unavailable");
    const { state:_treeState,kind:_treeKind,machineFingerprint:_machine,...treeFields }=worktreeObservation;
    const tree: WorktreeBindingInput={ ...treeFields,worktreeBindingId:createStableId("worktreeBinding"),repositoryBindingId:repository.repositoryBindingId,
      missionId:a.a.missionId,provenanceId:await provenance() };
    assert.deepEqual(await store.recordWorktree(tree),tree);
    assert.deepEqual(await store.loadWorktree(tree.worktreeBindingId),{ binding:tree,retired:false });
    assert.equal(tree.branchRef,"refs/heads/Feature/NativeCase");
    process.stdout.write("PASS native filesystem binding: actual machine/directory/branch/commit observations persist with exact mission provenance\n");

    assert.equal((await pool.query("SELECT 1 FROM acp.resource_leases WHERE mission_id=$1",[a.a.missionId])).rowCount,0);
    assert.equal((await pool.query("SELECT 1 FROM acp.worker_runs WHERE mission_id=$1",[a.a.missionId])).rowCount,0);
    await rename(checkout,join(root,"retained-checkout")); await mkdir(checkout);
    assert.deepEqual(await observeWindowsWorktree(loaded.binding,workspace,signal(),options),{ state:"unconfirmed" });
    assert.deepEqual(await store.loadWorktree(tree.worktreeBindingId),{ binding:tree,retired:false });
    process.stdout.write("PASS native filesystem binding: replaced checkout fails reobservation without rewriting history or inventing writer authority\n");

    await store.retireWorktree(tree.worktreeBindingId,await provenance(),"Disposable native observation ended.");
    await store.retireRepository(repository.repositoryBindingId,await provenance(),"Disposable native observation ended.");
    assert.equal((await store.loadWorktree(tree.worktreeBindingId))?.retired,true);
    assert.deepEqual(await store.recordRepository(repository),repository);
    await f.dispatches.closeRuntime(f.runtime.hostIdentifier,f.runtime.sessionId);
    process.stdout.write("PASS native filesystem binding: retirement preserves exact readback after physical observation ends\nNative filesystem binding integration: 3 checks passed.\n");
  } finally {
    const until=Date.now()+5000;
    while (pids.size && Date.now()<until) {
      for (const pid of pids) { try { process.kill(pid,0); } catch (error) { if ((error as NodeJS.ErrnoException).code==="ESRCH") pids.delete(pid); else throw error; } }
      if (pids.size) await new Promise((done) => setTimeout(done,20));
    }
    assert.equal(pids.size,0,"all owned filesystem/Git processes must exit before fixture cleanup");
    const location=resolve(root),local=relative(resolve(tmpdir()),location);
    assert.ok(local.startsWith("acp-filesystem-pg-test-") && !local.includes("..") && !isAbsolute(local));
    await rm(location,{ recursive:true,force:true });
  }
}
