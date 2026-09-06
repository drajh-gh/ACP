import assert from "node:assert/strict";
import { it } from "node:test";
import { createStableId } from "@acp/domain";
import { snapshotNativeProvisionerPlan,parseNativeProvisionerOwner,provisionerChannelBinding } from "../src/native-provisioner-plan.ts";
import { provisionerPlanFixture } from "./provisioner-plan-fixture.ts";

it("native provisioner plan snapshots all retained terms and canonical microseconds without conferring permission",()=>{
  const source=provisionerPlanFixture(),plan=snapshotNativeProvisionerPlan(source);
  assert.deepEqual(plan,source);assert.notEqual(plan,source);assert.ok(Object.isFrozen(plan));assert.ok(Object.isFrozen(plan.reportedParent));
  assert.ok(Object.isFrozen(plan.commonGitDirectory));assert.ok(Object.isFrozen(plan.fencePlan));
  Object.assign(source.reportedParent,{path:"C:\\other"});Object.assign(source,{reservationRevision:8});
  assert.equal(plan.reservationRevision,7);assert.equal(plan.reportedParent.path,"C:\\ACP-workspaces");
  assert.equal(snapshotNativeProvisionerPlan(provisionerPlanFixture({state:"recovering"})).state,"recovering");
});
it("native provisioner plan rejects missing, extra, malformed and aliased retained fields",()=>{
  const source=provisionerPlanFixture();
  for(const key of Object.keys(source)){const changed={...source} as Record<string,unknown>;delete changed[key];assert.throws(()=>snapshotNativeProvisionerPlan(changed),key);}
  for(const change of [{permission:"go"},{dispatchGeneration:0},{dispatchGeneration:1.5},{dispatchGeneration:2147483648},{machineFingerprint:"bad"},
    {fenceKey:createStableId("worktreeProvisionerAttempt")+".provision"},{createdAt:"bad"},{state:"active"},{ownerSessionId:createStableId("run")},
    {repositoryId:createStableId("project")},{projectProfileVersion:""},{applicationVersion:"bad\0version"},{graphRevision:"bad\nrevision"},
    {reportedParent:{...source.reportedParent,identity:"invented"}},{commonGitDirectory:{...source.commonGitDirectory,path:"relative"}}])
    assert.throws(()=>snapshotNativeProvisionerPlan({...source,...change}),JSON.stringify(change));
});
it("native provisioner plan preserves nonzero microseconds and canonicalizes equivalent offset instants",()=>{
  const source=provisionerPlanFixture({deadlineAt:"2026-09-06T13:30:15.123456+02:00",createdAt:"2026-09-06T13:30:00.654321+02:00"});
  Object.assign(source.reportedParent,{observedAt:"2026-09-06T13:29:59.987654+02:00"});
  const plan=snapshotNativeProvisionerPlan(source);
  assert.equal(plan.deadlineAt,"2026-09-06T11:30:15.123456Z");assert.equal(plan.createdAt,"2026-09-06T11:30:00.654321Z");
  assert.equal(plan.reportedParent.observedAt,"2026-09-06T11:29:59.987654Z");
});
it("native provisioner plan rejects unsupported Git target spelling and inconsistent reported parent",()=>{
  const source=provisionerPlanFixture();
  for(const change of [{workspacePath:"C:\\elsewhere\\target"},{branchRef:"refs/heads/bad..ref"},{branchRef:"refs/heads/CON"},
    {reportedParent:{...source.reportedParent,identity:source.commonGitDirectory.identity}},
    {commonGitDirectory:{...source.commonGitDirectory,path:source.workspacePath+"\\.git"}}])assert.throws(()=>snapshotNativeProvisionerPlan({...source,...change}));
});
it("native provisioner owner and channel binding retain the exact original identity",()=>{
  const plan=snapshotNativeProvisionerPlan(provisionerPlanFixture()),owner={hostIdentifier:plan.hostIdentifier,sessionId:plan.ownerSessionId,applicationVersion:plan.applicationVersion};
  assert.deepEqual(parseNativeProvisionerOwner(owner),owner);assert.ok(Object.isFrozen(parseNativeProvisionerOwner(owner)));
  for(const change of [{hostIdentifier:""},{sessionId:createStableId("run")},{applicationVersion:"bad\nversion"},{extra:true}])assert.throws(()=>parseNativeProvisionerOwner({...owner,...change}));
  assert.deepEqual(provisionerChannelBinding(plan),{attemptId:plan.attemptId,expectedPlan:{reservationId:plan.reservationId,reservationRevision:plan.reservationRevision,
    deadlineAt:plan.deadlineAt,provenanceId:plan.provenanceId},owner,fencePlan:plan.fencePlan,machineFingerprint:plan.machineFingerprint});
});
