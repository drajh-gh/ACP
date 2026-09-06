import { canonicalJsonDigest, expectBoolean, expectJsonValue, expectOnlyKeys, expectRecord,
  parseCurrentProfileDiscoveryEvidence, parseCurrentProfileDiscoveryEvidenceBatch, parseProfileProposalIdentity, parseProjectProfileProposal, parseStableId,
  preparePinnedProfileDiscovery, profileDiscoveryEvidenceMaximumSources, type ProfileDiscoveryObservation, type ProfileEvidencePin,
  type ProfileProposalIdentity, type ProjectProfileProposal } from "@acp/domain";
import type { PostgresProfileProposalStore } from "@acp/storage";
import { copyNpmManifestBytes } from "./npm-manifest-bytes.ts";
import { discoverNpmPackageManifest } from "./npm-package-manifest-discovery.ts";

export type NpmManifestDiscoveryCoordinatorResult =
  | { readonly state: "recorded"; readonly proposal: ProjectProfileProposal; readonly replayed: boolean }
  | { readonly state: "not_recorded"; readonly reason: "manifest_unconfirmed" | "no_relevant_declarations" };
export const npmManifestBatchMaximumBytes = 1_048_576;
const notConfirmed = "Manifest discovery was not confirmed; persistence may require exact retry.";

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
    return await recordExtracted(store, identity, extracted.observations, [source.expectedPin]);
  } catch { throw new Error(notConfirmed); }
}

/** Only nonempty contributors are rechecked/retained at commit; empty inputs are not negative scan receipts. */
export async function recordNpmManifestDiscoveries(
  store: Pick<PostgresProfileProposalStore, "getCurrentDiscoveryEvidenceBatch" | "recordPinnedDiscovery">,
  value: unknown,
): Promise<NpmManifestDiscoveryCoordinatorResult> {
  try {
    const input = expectRecord(value, "manifest discovery batch");
    expectOnlyKeys(input, ["proposalId", "projectId", "candidateProfile", "baseProfile", "supersedesProposalId", "sources"], "manifest discovery batch");
    const { sources: selected, ...selectedIdentity } = input, identity = parseProfileProposalIdentity(selectedIdentity);
    if (!Array.isArray(selected) || selected.length < 1 || selected.length > profileDiscoveryEvidenceMaximumSources
      || Reflect.ownKeys(selected).length !== selected.length + 1) throw new Error("invalid manifest source list");
    const sources: { evidenceId: ProfileEvidencePin["evidenceId"]; bytes: Uint8Array }[] = [];
    let totalBytes = 0;
    for (let index = 0; index < selected.length; index++) {
      if (!Object.hasOwn(selected, index)) throw new Error("sparse manifest source list");
      const input = expectRecord(selected[index], "manifest source");
      expectOnlyKeys(input, ["evidenceId", "bytes"], "manifest source");
      const evidenceId = parseStableId(input.evidenceId, "evidence"), bytes = copyNpmManifestBytes(input.bytes);
      totalBytes += bytes.byteLength;
      if (totalBytes > npmManifestBatchMaximumBytes) throw new Error("manifest batch byte bound");
      sources.push({ evidenceId, bytes });
    }
    sources.sort((a, b) => a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : 0);
    const evidenceIds = sources.map(source => source.evidenceId);
    if (new Set(evidenceIds).size !== evidenceIds.length) throw new Error("duplicate manifest source");
    const query = { projectId: identity.projectId, evidenceIds };
    const descriptors = parseCurrentProfileDiscoveryEvidenceBatch(await store.getCurrentDiscoveryEvidenceBatch(query), query);
    const observations: ProfileDiscoveryObservation[] = [], expectedPins: ProfileEvidencePin[] = [];
    for (const [index, source] of sources.entries()) {
      const descriptor = descriptors[index]!;
      const extracted = discoverNpmPackageManifest({ evidenceId: source.evidenceId, expectedContentHash: descriptor.contentHash, bytes: source.bytes });
      if (extracted.state !== "observed") return { state: "not_recorded", reason: "manifest_unconfirmed" };
      if (extracted.observations.length) { observations.push(...extracted.observations); expectedPins.push(descriptor.expectedPin); }
    }
    if (!observations.length) return { state: "not_recorded", reason: "no_relevant_declarations" };
    return await recordExtracted(store, identity, observations, expectedPins);
  } catch { throw new Error(notConfirmed); }
}

async function recordExtracted(store: Pick<PostgresProfileProposalStore, "recordPinnedDiscovery">, identity: ProfileProposalIdentity,
  observations: readonly ProfileDiscoveryObservation[], expectedPins: readonly ProfileEvidencePin[]): Promise<NpmManifestDiscoveryCoordinatorResult> {
  const prepared = preparePinnedProfileDiscovery(identity.projectId, observations, expectedPins);
  const result = expectRecord(await store.recordPinnedDiscovery({ ...identity, observations, expectedEvidencePins: prepared.expectedEvidencePins }), "retained manifest discovery");
  expectOnlyKeys(result, ["proposal", "replayed"], "retained manifest discovery");
  const proposal = parseProjectProfileProposal(result.proposal), replayed = expectBoolean(result.replayed, "discovery replay");
  const { producer: _producer, proposedAt: _time, proposalSchemaVersion: _schema, state: _state,
    authority: _authority, proposalDigest: _digest, ...terms } = proposal;
  if (digest(terms) !== digest({ ...identity, fields: prepared.fields, evidencePins: prepared.expectedEvidencePins })) throw new Error("retained discovery differs");
  return { state: "recorded", proposal, replayed };
}

function digest(value: unknown) { return canonicalJsonDigest(expectJsonValue(value, "manifest discovery terms")); }
