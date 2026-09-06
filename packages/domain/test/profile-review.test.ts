import assert from "node:assert/strict";
import { it } from "node:test";
import { canonicalJsonDigest } from "../src/effects.ts";
import { createStableId } from "../src/ids.ts";
import { expectJsonValue } from "../src/validation.ts";
import { buildProfileConfirmationRequest, buildProjectProfileProposal, parseProfileConfirmationRequest,
  parseProjectProfileProposalQuery, profileFieldIds } from "../src/profile-proposal.ts";

const query = { projectId: createStableId("project"), proposalId: createStableId("projectProfileProposal") };
const proposal = buildProjectProfileProposal({ ...query,candidateProfile:{ profileId:createStableId("projectProfile"),profileVersion:"1.0.0" },
  baseProfile:null,supersedesProposalId:null,producer:{ component:"synthetic",version:"1",artifactDigest:canonicalJsonDigest({ synthetic:true }) },
  proposedAt:"2026-09-06T00:00:00Z" },Object.fromEntries(profileFieldIds.map(id=>[id,{ status:"not_applicable",rationale:"Synthetic proposed applicability.",evidenceIds:[] }])),[]);
const request = buildProfileConfirmationRequest(proposal,{ currentProposalId:query.proposalId,candidateProfileExists:false,baseProfileMatches:true,asOf:"2026-09-06T00:01:00Z",evidence:[] });

it("profile review queries name one exact project and proposal without latest aliases or action fields", () => {
  assert.deepEqual(parseProjectProfileProposalQuery(query),query);
  for(const invalid of [{ ...query,latest:true },{ ...query,confirm:true },{ ...query,proposalId:"latest" },{ ...query,projectId:createStableId("mission") }]) assert.throws(()=>parseProjectProfileProposalQuery(invalid));
});
it("profile confirmation wire parser verifies full request identity without claiming current storage or human intent", () => {
  assert.deepEqual(parseProfileConfirmationRequest(request,query),request);
  assert.throws(()=>parseProfileConfirmationRequest(request,{ ...query,projectId:createStableId("project") }));
  assert.throws(()=>parseProfileConfirmationRequest(request,{ ...query,proposalId:createStableId("projectProfileProposal") }));
});
it("profile confirmation wire parser rejects substitutions, extra authority, private evidence and altered digests", () => {
  for(const invalid of [
    { ...request,kind:"confirmed" },{ ...request,requestSchemaVersion:"2.0.0" },{ ...request,operatorId:"synthetic-human" },
    { ...request,authorityAssessment:"approved" },{ ...request,activation:"authorized" },
    { ...request,candidateProfile:{ ...request.candidateProfile,profileVersion:"2.0.0" } },
    { ...request,proposalDigest:canonicalJsonDigest({ changed:true }) },{ ...request,evidenceSnapshotDigest:canonicalJsonDigest({ changed:true }) },
    { ...request,confirmationDigest:canonicalJsonDigest({ changed:true }) },{ ...request,asOf:"2026-09-06T00:02:00.000000Z" },
    { ...request,proposal:{ ...proposal,state:"needs_input" } },{ ...request,evidence:[{ rawSource:"synthetic-private" }] },
  ]) assert.throws(()=>parseProfileConfirmationRequest(invalid,query),{ message:"Profile confirmation request is unavailable; no partial request returned." });
});

it("profile confirmation wire parser preserves nonempty exact evidence and rejects rehashed invalid evidence", () => {
  const pin = { evidenceId:createStableId("evidence"),projectId:query.projectId,identityDigest:canonicalJsonDigest({ source:"synthetic" }) };
  const observed = buildProjectProfileProposal({ ...query,candidateProfile:proposal.candidateProfile,baseProfile:null,supersedesProposalId:null,
    producer:proposal.producer,proposedAt:proposal.proposedAt },{ ...proposal.fields,
    "context.product":{ status:"observed",value:{ "ž": [0.1,1e-7,null,true] },evidenceIds:[pin.evidenceId] } },[pin]);
  const evidence = { ...pin,observedAt:"2026-09-05T00:00:00.000000Z",retrievedAt:"2026-09-05T00:01:00.000000Z",
    sensitivity:"project_confidential",freshness:"current",accessibility:"available",contentHashPresent:true };
  const complete = buildProfileConfirmationRequest(observed,{ currentProposalId:query.proposalId,candidateProfileExists:false,baseProfileMatches:true,asOf:request.asOf,evidence:[evidence] });
  assert.deepEqual(parseProfileConfirmationRequest(complete,query),complete);
  for(const changed of [[],[evidence,evidence],[{ ...evidence,sensitivity:"restricted" }],[{ ...evidence,freshness:"stale" }],
    [{ ...evidence,accessibility:"inaccessible" }],[{ ...evidence,contentHashPresent:false }],[{ ...evidence,projectId:createStableId("project") }],
    [{ ...evidence,identityDigest:canonicalJsonDigest({ changed:true }) }],[{ ...evidence,retrievedAt:"2026-09-07T00:00:00.000000Z" }],
    [{ ...evidence,rawSource:"synthetic-private" }]]) {
    const { confirmationDigest:_old,...body } = { ...complete,evidence:changed,evidenceSnapshotDigest:canonicalJsonDigest(changed) };
    assert.throws(()=>parseProfileConfirmationRequest({ ...body,confirmationDigest:canonicalJsonDigest(expectJsonValue(body,"synthetic request")) },query),{ message:"Profile confirmation request is unavailable; no partial request returned." });
  }
});
