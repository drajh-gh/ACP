import assert from "node:assert/strict";
import { it } from "node:test";
import { createStableId } from "@acp/domain";
import { parseWorktreeReservation } from "../src/worktree-reservation.ts";

const request=() => ({ reservationId:createStableId("worktreeReservation"),repositoryBindingId:createStableId("repositoryBinding"),
  missionId:createStableId("mission"),nodeId:createStableId("node"),graphRevision:"graph:BeforeRun/1",workspacePath:"C:\\ACP planned ž 🚀\\Worktree",
  branchRef:"refs/heads/Feature/ExactCase",provenanceId:createStableId("provenance") });

it("pre-run target holds preserve exact Unicode paths, branch case and graph without fabricating native or run identity",() => {
  const input=request(),parsed=parseWorktreeReservation(input);
  assert.deepEqual(parsed,input); assert.notEqual(parsed,input);
  input.workspacePath="C:\\changed"; assert.notEqual(parsed.workspacePath,input.workspacePath);
});
it("pre-run target holds reject wrong ID kinds and incomplete fields",() => {
  for(const field of ["reservationId","repositoryBindingId","missionId","nodeId","provenanceId"]) {
    assert.throws(() => parseWorktreeReservation({ ...request(),[field]:createStableId("run") }));
  }
  for(const field of Object.keys(request())) {
    const value:Record<string,unknown>=request(); delete value[field]; assert.throws(() => parseWorktreeReservation(value));
  }
});
it("pre-run target holds cannot accept caller-selected owner, timestamps, keys, native identities or lifecycle authority",() => {
  for(const field of ["hostIdentifier","ownerSessionId","acquiredAt","expiresAt","revision","state","workspaceKey","physicalRepositoryKey",
    "workspaceIdentity","runId","dispatchRunId","dispatchGeneration","workerProcessId","launchSealed","releasedAt"]) {
    assert.throws(() => parseWorktreeReservation({ ...request(),[field]:"untrusted" }));
  }
  for(const value of [null,undefined,[],"reservation"]) assert.throws(() => parseWorktreeReservation(value));
});
it("prospective workspace paths reject lexical aliases without claiming to inspect the filesystem",() => {
  for(const workspacePath of ["C:\\","C:relative","relative","\\\\server\\share\\work","C:/ACP/work","C:\\a\\..\\work",
    "C:\\a\\.\\work","C:\\work.","C:\\work ","C:\\NUL.txt","C:\\a:stream","C:\\bad\npath","C:\\"+"a".repeat(4096)]) {
    assert.throws(() => parseWorktreeReservation({ ...request(),workspacePath }));
  }
});
it("pre-run graph and branch intent is bounded, nonempty and exact rather than normalized",() => {
  for(const graphRevision of [""," ","bad\nrevision","g".repeat(1025),123]) assert.throws(() => parseWorktreeReservation({ ...request(),graphRevision }));
  for(const branchRef of ["","Feature/Case","refs/tags/Case","refs/heads/","refs/heads/bad\nbranch","refs/heads/"+"a".repeat(1024),123]) {
    assert.throws(() => parseWorktreeReservation({ ...request(),branchRef }));
  }
});
