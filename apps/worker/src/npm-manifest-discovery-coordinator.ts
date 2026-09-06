import { canonicalJsonDigest, expectBoolean, expectJsonValue, expectOnlyKeys, expectRecord,
  parseCurrentProfileDiscoveryEvidence, parseProfileProposalIdentity, parseProjectProfileProposal, parseStableId,
  preparePinnedProfileDiscovery, type ProjectProfileProposal } from "@acp/domain";
import type { PostgresProfileProposalStore } from "@acp/storage";
import { copyNpmManifestBytes } from "./npm-manifest-bytes.ts";
import { discoverNpmPackageManifest } from "./npm-package-manifest-discovery.ts";

export type NpmManifestDiscoveryCoordinatorResult =
  | { readonly state: "recorded"; readonly proposal: ProjectProfileProposal; readonly replayed: boolean }
  | { readonly state: "not_recorded"; readonly reason: "manifest_unconfirmed" | "no_relevant_declarations" };

/**
 * Private supplied-byte composition, not filesystem/provider acquisition. Each invocation rechecks a current
 * descriptor. A thrown error can include an uncertain write; it never establishes historical absence.
 */
export async function recordNpmManifestDiscovery(
  store: Pick<PostgresProfileProposalStore, "getCurrentDiscoveryEvidence" | "recordPinnedDiscovery">,
  value: unknown,
): Promise<NpmManifestDiscoveryCoordinatorResult> {
  try {
    const input = expectRecord(value, "manifest discovery write");
    expectOnlyKeys(input, ["proposalId", "projectId", "candidateProfile", "baseProfile", "supersedesProposalId", "evidenceId", "bytes"], "manifest discovery write");
    const { evidenceId: selectedEvidence, bytes: selectedBytes, ...selectedIdentity } = input;
    const identity = parseProfileProposalIdentity(selectedIdentity), evidenceId = parseStableId(selectedEvidence, "evidence");
    // Fix the invocation's byte view before any asynchronous source lookup can let callers replace it.
    const bytes = copyNpmManifestBytes(selectedBytes), query = { projectId: identity.projectId, evidenceId };
    const source = parseCurrentProfileDiscoveryEvidence(await store.getCurrentDiscoveryEvidence(query), query);
    const extracted = discoverNpmPackageManifest({ evidenceId, expectedContentHash: source.contentHash, bytes });
    if (extracted.state !== "observed") return { state: "not_recorded", reason: "manifest_unconfirmed" };
    if (!extracted.observations.length) return { state: "not_recorded", reason: "no_relevant_declarations" };
    const prepared = preparePinnedProfileDiscovery(identity.projectId, extracted.observations, [source.expectedPin]);
    const result = expectRecord(await store.recordPinnedDiscovery({ ...identity, observations: extracted.observations,
      expectedEvidencePins: prepared.expectedEvidencePins }), "retained manifest discovery");
    expectOnlyKeys(result, ["proposal", "replayed"], "retained manifest discovery");
    const proposal = parseProjectProfileProposal(result.proposal), replayed = expectBoolean(result.replayed, "discovery replay");
    const { producer: _producer, proposedAt: _time, proposalSchemaVersion: _schema, state: _state,
      authority: _authority, proposalDigest: _digest, ...terms } = proposal;
    if (digest(terms) !== digest({ ...identity, fields: prepared.fields, evidencePins: prepared.expectedEvidencePins })) throw new Error("retained discovery differs");
    return { state: "recorded", proposal, replayed };
  } catch { throw new Error("Manifest discovery was not confirmed; persistence may require exact retry."); }
}

function digest(value: unknown) { return canonicalJsonDigest(expectJsonValue(value, "manifest discovery terms")); }
