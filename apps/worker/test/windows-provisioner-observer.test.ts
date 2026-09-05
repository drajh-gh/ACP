import assert from "node:assert/strict";
import { it } from "node:test";
import { createStableId } from "@acp/domain";
import { observeWindowsProvisionerTarget, parseWindowsProvisionerTargetInput, parseWindowsProvisionerTargetObservation } from "../src/windows-repository-observer.ts";

const observation=()=>({ state:"observed",kind:"provisioner_target",scope:"observation_only",machineFingerprint:"a".repeat(64),
  checkout:{ path:"C:\\ACP-repo",identity:"win32-dir:12345678:0000000000000001" },
  commonGitDirectory:{ path:"C:\\ACP-repo\\.git",identity:"win32-dir:12345678:0000000000000002" },
  parent:{ path:"C:\\ACP-workspaces ž",identity:"win32-dir:12345678:0000000000000003" },workspacePath:"C:\\ACP-workspaces ž\\FutureCase",
  branchRef:"refs/heads/Feature/ExactCase",baseRevision:"b".repeat(40),targetAbsent:true,branchAbsent:true,observedAt:"2026-09-06T00:00:00.000Z" });
it("provisioner observation preserves native parent, exact base and branch without retained authority",()=>{
  const value=observation(),parsed=parseWindowsProvisionerTargetObservation(value);
  assert.deepEqual(parsed,value); assert.notEqual(parsed,value);
  assert.equal(parseWindowsProvisionerTargetObservation({ ...value,baseRevision:"b".repeat(64) }).state,"observed");
});
it("provisioner input denies aliases, unsupported branch components, extra authority and driveroot parents",()=>{
  const { workspacePath,branchRef,baseRevision }=observation(),input={ workspacePath,branchRef,baseRevision };
  assert.deepEqual(parseWindowsProvisionerTargetInput(input),input);
  for(const change of [{ workspacePath:"C:\\Target" },{ expectedParent:"caller-authored" },{ launch:true },{ baseRevision:"B".repeat(40) },
    ...["bad..ref","bad@{ref","bad~ref","bad ref",".hidden","bad.lock","CON","a//b","a/","a\\b",Array(17).fill("a").join("/")].map((branch)=>({ branchRef:"refs/heads/"+branch }))]) {
    assert.throws(()=>parseWindowsProvisionerTargetInput({ ...input,...change }),TypeError);
  }
});
it("provisioner pre-abort spawns nothing, but still validates exact input",async()=>{
  const { checkout,commonGitDirectory,machineFingerprint,observedAt,workspacePath,branchRef,baseRevision }=observation();
  const repository={ checkout,commonGitDirectory,machineFingerprint,observedAt,repositoryBindingId:createStableId("repositoryBinding"),
    repositoryId:createStableId("repository"),projectId:createStableId("project"),provenanceId:createStableId("provenance") };
  const options={ gitExecutable:"C:\\Program Files\\Git\\cmd\\git.exe",onSpawn:()=>assert.fail("pre-abort spawned helper") };
  assert.deepEqual(await observeWindowsProvisionerTarget(repository,{ workspacePath,branchRef,baseRevision },AbortSignal.abort(),options),{ state:"unconfirmed" });
  await assert.rejects(observeWindowsProvisionerTarget(repository,{ workspacePath,branchRef,baseRevision:"HEAD" },AbortSignal.abort(),options),TypeError);
});
it("provisioner observation denies partial, fabricated authority and unknown metadata",()=>{
  const value=observation();
  for(const item of [null,{},[],{ ...value,scope:"launch_permitted" },{ ...value,leaseHeld:true },{ ...value,launchSealed:true },
    { ...value,targetAbsent:false },{ ...value,branchAbsent:false },{ ...value,kind:"worktree" },{ ...value,observedAt:"not-a-time" },
    { ...value,machineFingerprint:"host-name" },{ ...value,parent:{ ...value.parent,pinned:true } }]) {
    assert.deepEqual(parseWindowsProvisionerTargetObservation(item),{ state:"unconfirmed" });
  }
  for(const key of Object.keys(value)) { const missing={ ...value } as Record<string,unknown>; delete missing[key];
    assert.deepEqual(parseWindowsProvisionerTargetObservation(missing),{ state:"unconfirmed" }); }
});
it("provisioner observation rejects contradictory path topology, identity and symbolic revision",()=>{
  const value=observation();
  for(const change of [{ parent:value.checkout },{ parent:value.commonGitDirectory },{ workspacePath:"C:\\Elsewhere\\Target" },
    { workspacePath:value.parent.path },{ workspacePath:"C:\\ACP-workspaces ž\\..\\Target" },{ baseRevision:"HEAD" },
    { branchRef:"refs/tags/Feature" },{ branchRef:"refs/heads/" },{ branchRef:"refs/heads/Bad\nRef" },
    { commonGitDirectory:{ ...value.commonGitDirectory,path:"C:\\Elsewhere" } }]) {
    assert.deepEqual(parseWindowsProvisionerTargetObservation({ ...value,...change }),{ state:"unconfirmed" });
  }
});
