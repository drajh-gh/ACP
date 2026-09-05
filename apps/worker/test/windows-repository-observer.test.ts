import assert from "node:assert/strict";
import { it } from "node:test";
import { parseWindowsFilesystemObservation, observeWindowsRepository } from "../src/windows-repository-observer.ts";
const binding = { path:"C:\\repository ž",identity:"win32-dir:12345678:0000000000000001" };
const repository = { state:"confirmed",kind:"repository",machineFingerprint:"a".repeat(64),observedAt:"2026-09-05T16:00:00.000Z",
  checkout:binding,commonGitDirectory:{ path:binding.path+"\\.git",identity:"win32-dir:12345678:0000000000000002" } };
it("native observation parser preserves exact directory identity, Unicode and branch case",() => {
  assert.deepEqual(parseWindowsFilesystemObservation(repository),repository);
  const worktree = { state:"confirmed",kind:"worktree",machineFingerprint:repository.machineFingerprint,observedAt:repository.observedAt,
    workspace:{ ...binding,path:"C:\\workspace" },gitDirectory:repository.commonGitDirectory,branchRef:"refs/heads/Feature/Case",headRevision:"b".repeat(40) };
  assert.deepEqual(parseWindowsFilesystemObservation(worktree),worktree);
  for (const change of [{ headRevision:"HEAD" },{ branchRef:"refs/heads/" },{ gitDirectory:worktree.workspace },{ kind:"unexpected" }]) {
    assert.deepEqual(parseWindowsFilesystemObservation({ ...worktree,...change }),{ state:"unconfirmed" });
  }
});
it("native observation parser withholds malformed, partial or authority-shaped output",() => {
  for (const value of [null,[],{}, { ...repository,state:"lost" },{ ...repository,leaseHeld:true },
    { ...repository,commonGitDirectory:binding },{ ...repository,observedAt:"unknown" },{ ...repository,machineFingerprint:"host-name" },
    { ...repository,commonGitDirectory:{ ...repository.commonGitDirectory,path:"C:\\other" } }]) {
    assert.deepEqual(parseWindowsFilesystemObservation(value),{ state:"unconfirmed" });
  }
});
it("observer requires a trusted absolute executable and never spawns after cancellation",async () => {
  let spawned = false; const controller = new AbortController(); controller.abort();
  const options = { gitExecutable:"C:\\Program Files\\Git\\cmd\\git.exe",onSpawn:() => { spawned=true; } };
  assert.deepEqual(await observeWindowsRepository(binding.path,controller.signal,options),{ state:"unconfirmed" });
  assert.equal(spawned,false);
  for (const gitExecutable of ["git","C:\\tools\\shell.exe","C:/tools/git.exe"]) {
    await assert.rejects(observeWindowsRepository(binding.path,controller.signal,{ gitExecutable }),TypeError);
  }
});
