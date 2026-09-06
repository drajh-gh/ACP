import { canonicalJsonDigest } from "./effects.ts";
import { parseStableId, type StableId } from "./ids.ts";
import { trackerSemanticCategories } from "./lifecycle.ts";
import { expectArray, expectBoolean, expectEnum, expectOnlyKeys, expectRecord, expectString,
  parseCanonicalTimestamp, timestampMicroseconds, type JsonValue } from "./validation.ts";

const sections = {
  identity: ["project", "client", "stakeholders", "environments"],
  repositories: ["inventory", "defaultBranches", "developmentBranches", "protections", "owners"],
  tracker: ["adapterAndInstance", "nativeStates", "semanticMappings", "itemTypes", "transitionPolicy"],
  verification: ["tests", "linting", "builds", "ci", "reviewRules", "requiredGates"],
  deployment: ["paths", "stagingAvailability", "productionAuthority", "verification", "rollback"],
  context: ["product", "business", "scopeBoundaries", "designDirection", "personas", "acceptanceMethods"],
  communications: ["channels", "externalRecipients", "internalRecipients", "messageApprovalRules"],
  knowledge: ["sources", "sourceAuthorityRules", "freshnessExpectations", "memoryDestinations"],
  data: ["sensitivity", "restrictedSources", "redaction", "retention"],
  orchestration: ["workflowBindings", "schedules", "reconciliationSources", "cursorStrategies", "completionContracts"],
  attention: ["quietHours", "escalationRules", "failureThresholds", "unattendedLimits"],
  execution: ["hostRequirements", "browserRequirements", "concurrencyLimits"],
  credentials: ["references", "readIdentities", "writeIdentities"],
  revalidation: ["mutableTargets", "methods"],
  compatibility: ["runtimeRequirements", "adapterRequirements"],
} as const;
for (const fields of Object.values(sections)) Object.freeze(fields);
export const profileSections = Object.freeze(sections);
type SectionId = keyof typeof sections;
export type ProfileFieldId = { [S in SectionId]: `${S}.${(typeof sections)[S][number]}` }[SectionId];
export const profileFieldIds: readonly ProfileFieldId[] = Object.freeze(Object.entries(sections)
  .flatMap(([section, fields]) => fields.map(field => `${section}.${field}` as ProfileFieldId)));
export const profileProposalSchemaVersion = "1.0.0";
export const profileProposalMaximumBytes = 262_144;
const factMaximumBytes = 4096;

export type ProfileProposalField =
  | { readonly status: "observed"; readonly value: JsonValue; readonly evidenceIds: readonly StableId<"evidence">[] }
  | { readonly status: "proposed"; readonly value: JsonValue; readonly rationale: string; readonly evidenceIds: readonly StableId<"evidence">[] }
  | { readonly status: "missing"; readonly reason: string; readonly question: string }
  | { readonly status: "conflicted"; readonly question: string; readonly alternatives: readonly ProfileFactAlternative[] }
  | { readonly status: "not_applicable"; readonly rationale: string; readonly evidenceIds: readonly StableId<"evidence">[] };
export interface ProfileFactAlternative {
  readonly value: JsonValue;
  readonly evidenceIds: readonly StableId<"evidence">[];
}
/** An attributed source report, not verified truth, source precedence or user confirmation. */
export interface ProfileDiscoveryObservation extends ProfileFactAlternative {
  readonly fieldId: ProfileFieldId;
}
export const profileDiscoveryMaximumObservations = 310;
export const profileDiscoveryMaximumBytes = 1_048_576;
export interface ProfileEvidencePin {
  readonly evidenceId: StableId<"evidence">;
  readonly projectId: StableId<"project">;
  readonly identityDigest: string;
}
export interface ProfileProposalMetadata {
  readonly proposalId: StableId<"projectProfileProposal">;
  readonly projectId: StableId<"project">;
  readonly candidateProfile: { readonly profileId: StableId<"projectProfile">; readonly profileVersion: string };
  /** profileDigest is acp.jsonb_sha256 of the exact retained baseline, NOT the proposal's JS canonical digest. */
  readonly baseProfile: { readonly profileId: StableId<"projectProfile">; readonly profileVersion: string; readonly profileDigest: string } | null;
  readonly supersedesProposalId: StableId<"projectProfileProposal"> | null;
  /** Configured producer identity, not an operator principal or evidence-origin attestation. */
  readonly producer: { readonly component: string; readonly version: string; readonly artifactDigest: string };
  readonly proposedAt: string;
}
export type ProfileProposalIdentity = Omit<ProfileProposalMetadata, "producer" | "proposedAt">;
export type ProfileProposalProducer = ProfileProposalMetadata["producer"];
export interface ProjectProfileProposalQuery {
  readonly projectId: StableId<"project">;
  readonly proposalId: StableId<"projectProfileProposal">;
}
const authority = { assessment: "not_evaluated", publication: "not_authorized", activation: "not_authorized" } as const;
export interface ProjectProfileProposal extends ProfileProposalMetadata {
  readonly proposalSchemaVersion: typeof profileProposalSchemaVersion;
  readonly fields: Readonly<Record<ProfileFieldId, ProfileProposalField>>;
  readonly evidencePins: readonly ProfileEvidencePin[];
  /** Reviewable means every checklist field is addressed, not verified truth or valid runtime configuration. */
  readonly state: "needs_input" | "conflicted" | "reviewable";
  readonly authority: typeof authority;
  readonly proposalDigest: string;
}
const metadataFields = ["proposalId", "projectId", "candidateProfile", "baseProfile", "supersedesProposalId", "producer", "proposedAt"];
const proposalFields = [...metadataFields, "proposalSchemaVersion", "fields", "evidencePins", "state", "authority", "proposalDigest"];
const invalidProposal = "Invalid or undisclosable profile proposal.";
const unavailableRequest = "Profile confirmation request is unavailable; no partial request returned.";

export function parseProjectProfileProposalQuery(value: unknown): ProjectProfileProposalQuery {
  const input = expectRecord(value, "exact profile proposal query");
  expectOnlyKeys(input, ["projectId", "proposalId"], "exact profile proposal query");
  return { projectId: parseStableId(input.projectId, "project"), proposalId: parseStableId(input.proposalId, "projectProfileProposal") };
}

export function parseProfileDiscoveryEvidenceQuery(value: unknown) {
  const input = expectRecord(value, "exact discovery evidence query");
  expectOnlyKeys(input, ["projectId", "evidenceId"], "exact discovery evidence query");
  return { projectId: parseStableId(input.projectId, "project"), evidenceId: parseStableId(input.evidenceId, "evidence") };
}

/** Private descriptor shape/scope only. Currentness and source fingerprint derivation belong to trusted storage. */
export function parseCurrentProfileDiscoveryEvidence(value: unknown, queryValue: unknown) {
  const query = parseProfileDiscoveryEvidenceQuery(queryValue), input = expectRecord(value, "current discovery evidence");
  expectOnlyKeys(input, ["evidenceId", "projectId", "contentHash", "expectedPin"], "current discovery evidence");
  const expectedPin = parsePin(input.expectedPin, query.projectId);
  if (input.evidenceId !== query.evidenceId || input.projectId !== query.projectId || expectedPin.evidenceId !== query.evidenceId
    || typeof input.contentHash !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(input.contentHash)) throw new Error("Invalid current discovery evidence.");
  return { ...query, contentHash: input.contentHash, expectedPin };
}

/** Pure assembly from selected, already-redacted discovery results; it performs no discovery I/O or authorization. */
export function buildProjectProfileProposal(metadataValue: unknown, discoveredFields: unknown, evidencePinsValue: unknown): ProjectProfileProposal {
  try {
    const metadata = parseMetadata(metadataValue);
    const { fields, evidenceIds: referencedIds } = prepareProfileProposalFields(discoveredFields);
    const referenced = new Set(referencedIds);
    const evidencePins = boundedArray(evidencePinsValue, 1240).map(value => parsePin(value, metadata.projectId)).sort(compareEvidenceIds);
    if (new Set(evidencePins.map(pin => pin.evidenceId)).size !== evidencePins.length || evidencePins.length !== referenced.size
      || evidencePins.some(pin => !referenced.has(pin.evidenceId))) throw new Error(invalidProposal);
    const states = Object.values(fields).map(field => field.status);
    const state = states.includes("conflicted") ? "conflicted" : states.includes("missing") ? "needs_input" : "reviewable";
    const body = { ...metadata, proposalSchemaVersion: profileProposalSchemaVersion, fields, evidencePins, state, authority: { ...authority } } as const;
    const result = { ...body, proposalDigest: digest(body) };
    assertSize(result, profileProposalMaximumBytes);
    return result;
  } catch { throw new Error(invalidProposal); }
}

/** Stored envelopes must already be complete; unlike discovery assembly this never fills silent gaps. */
export function parseProjectProfileProposal(value: unknown): ProjectProfileProposal {
  try {
    assertSize(value, profileProposalMaximumBytes);
    const input = expectRecord(value, "profile proposal");
    expectOnlyKeys(input, proposalFields, "profile proposal");
    if (input.proposalSchemaVersion !== profileProposalSchemaVersion) throw new Error(invalidProposal);
    const fields = expectRecord(input.fields, "profile fields");
    if (Object.keys(fields).length !== profileFieldIds.length || profileFieldIds.some(id => !Object.hasOwn(fields, id))) throw new Error(invalidProposal);
    const claimedAuthority = expectRecord(input.authority, "proposal authority");
    expectOnlyKeys(claimedAuthority, Object.keys(authority), "proposal authority");
    for (const key of Object.keys(authority) as (keyof typeof authority)[]) if (claimedAuthority[key] !== authority[key]) throw new Error(invalidProposal);
    const metadata = Object.fromEntries(metadataFields.map(key => [key, input[key]]));
    const rebuilt = buildProjectProfileProposal(metadata, fields, input.evidencePins);
    if (input.state !== rebuilt.state || input.proposalDigest !== rebuilt.proposalDigest) throw new Error(invalidProposal);
    return rebuilt;
  } catch { throw new Error(invalidProposal); }
}

/**
 * The caller must obtain these current facts together from trusted storage. Parsing booleans or
 * fingerprints does not prove database scope, source identity, latestness or an operator's identity.
 * This returns the complete review document, never an accepted confirmation or activation token.
 */
export function buildProfileConfirmationRequest(proposalValue: unknown, currentSnapshotValue: unknown) {
  try {
    const proposal = parseProjectProfileProposal(proposalValue);
    const snapshot = expectRecord(currentSnapshotValue, "profile confirmation snapshot");
    expectOnlyKeys(snapshot, ["currentProposalId", "candidateProfileExists", "baseProfileMatches", "asOf", "evidence"], "profile confirmation snapshot");
    const asOf = parseCanonicalTimestamp(snapshot.asOf), clock = timestampMicroseconds(asOf);
    if (proposal.state !== "reviewable" || snapshot.currentProposalId !== proposal.proposalId
      || expectBoolean(snapshot.candidateProfileExists, "candidate profile exists")
      || !expectBoolean(snapshot.baseProfileMatches, "base profile matches")
      || clock < timestampMicroseconds(proposal.proposedAt)) throw new Error(unavailableRequest);
    const pins = new Map(proposal.evidencePins.map(pin => [pin.evidenceId, pin]));
    const evidence = boundedArray(snapshot.evidence, 1240).map(value => {
      const item = expectRecord(value, "current profile evidence");
      expectOnlyKeys(item, ["evidenceId", "projectId", "identityDigest", "sensitivity", "freshness", "accessibility", "contentHashPresent", "observedAt", "retrievedAt"], "current profile evidence");
      const pin = parsePin({ evidenceId: item.evidenceId, projectId: item.projectId, identityDigest: item.identityDigest }, proposal.projectId);
      const expected = pins.get(pin.evidenceId);
      const observedAt = parseCanonicalTimestamp(item.observedAt), retrievedAt = parseCanonicalTimestamp(item.retrievedAt);
      const sensitivity = expectEnum(item.sensitivity, ["public", "project_confidential"] as const, "profile evidence sensitivity");
      if (!expected || expected.identityDigest !== pin.identityDigest
        || item.freshness !== "current" || item.accessibility !== "available" || item.contentHashPresent !== true
        || timestampMicroseconds(observedAt) > timestampMicroseconds(retrievedAt) || timestampMicroseconds(retrievedAt) > clock) throw new Error(unavailableRequest);
      return { ...pin, observedAt, retrievedAt, sensitivity, freshness: "current", accessibility: "available", contentHashPresent: true } as const;
    }).sort(compareEvidenceIds);
    if (evidence.length !== pins.size || new Set(evidence.map(item => item.evidenceId)).size !== evidence.length) throw new Error(unavailableRequest);
    const body = { requestSchemaVersion: "1.0.0", kind: "confirmation_request_only", proposalId: proposal.proposalId,
      projectId: proposal.projectId, candidateProfile: proposal.candidateProfile, proposalDigest: proposal.proposalDigest,
      evidenceSnapshotDigest: digest(evidence), asOf, proposal, evidence,
      authorityAssessment: "not_evaluated", activation: "not_authorized" } as const;
    const result = { ...body, confirmationDigest: digest(body) };
    assertSize(result, profileProposalMaximumBytes * 2);
    return result;
  } catch { throw new Error(unavailableRequest); }
}

export type ProfileConfirmationRequest = ReturnType<typeof buildProfileConfirmationRequest>;

/** Wire self-consistency only: this parser cannot establish current database facts or human intent. */
export function parseProfileConfirmationRequest(value: unknown, expectedQueryValue: unknown): ProfileConfirmationRequest {
  try {
    assertSize(value, profileProposalMaximumBytes * 2);
    const expected = parseProjectProfileProposalQuery(expectedQueryValue), input = expectRecord(value, "profile confirmation request");
    expectOnlyKeys(input, ["requestSchemaVersion", "kind", "proposalId", "projectId", "candidateProfile", "proposalDigest", "evidenceSnapshotDigest",
      "asOf", "proposal", "evidence", "authorityAssessment", "activation", "confirmationDigest"], "profile confirmation request");
    const rebuilt = buildProfileConfirmationRequest(input.proposal, { currentProposalId: expected.proposalId,
      candidateProfileExists: false, baseProfileMatches: true, asOf: input.asOf, evidence: input.evidence });
    if (rebuilt.projectId !== expected.projectId || rebuilt.proposalId !== expected.proposalId || digest(input) !== digest(rebuilt)) throw new Error(unavailableRequest);
    return rebuilt;
  } catch { throw new Error(unavailableRequest); }
}

function parseMetadata(value: unknown): ProfileProposalMetadata {
  const input = expectRecord(value, "profile proposal metadata");
  expectOnlyKeys(input, metadataFields, "profile proposal metadata");
  const { producer, proposedAt, ...identity } = input;
  return { ...parseProfileProposalIdentity(identity), producer: parseProfileProposalProducer(producer), proposedAt: parseCanonicalTimestamp(proposedAt) };
}

/** Pure normalization for trusted producers before they acquire a database connection. */
export function prepareProfileProposalFields(value: unknown) {
  const selected = expectRecord(value, "discovered profile fields");
  expectOnlyKeys(selected, profileFieldIds, "discovered profile fields");
  const fields = Object.fromEntries(profileFieldIds.map(id => [id, Object.hasOwn(selected, id) ? parseField(id, selected[id]) : {
    status: "missing" as const, reason: "This required information has not been discovered.", question: `What is the intended value for ${id}?`,
  }])) as Record<ProfileFieldId, ProfileProposalField>;
  validateCredentialReferences(fields);
  assertSize(fields, profileProposalMaximumBytes);
  const ids = [...new Set(Object.values(fields).flatMap(field => fieldEvidenceIds(field)))].sort();
  if (ids.length > 1240) throw new Error(invalidProposal);
  return { fields, evidenceIds: ids };
}

/** Compare preconditions only: these opaque fingerprints neither prove source bytes nor grant authority. */
export function preparePinnedProfileDiscovery(projectIdValue: unknown, observations: unknown, expectedEvidencePinsValue: unknown) {
  const projectId = parseStableId(projectIdValue, "project");
  const { fields, evidenceIds } = prepareProfileProposalFields(reduceProfileDiscoveryObservations(observations));
  const expectedEvidencePins = boundedArray(expectedEvidencePinsValue, 1240).map(value => parsePin(value, projectId)).sort(compareEvidenceIds);
  if (expectedEvidencePins.length !== evidenceIds.length
    || expectedEvidencePins.some((pin, index) => pin.evidenceId !== evidenceIds[index])) throw new Error("Invalid expected evidence pins for profile discovery.");
  return { fields, expectedEvidencePins };
}

/** Deterministic reduction of already-selected, already-redacted observations. No I/O or authority evaluation. */
export function reduceProfileDiscoveryObservations(value: unknown): Readonly<Record<ProfileFieldId, ProfileProposalField>> {
  try {
    const observations = boundedArray(value, profileDiscoveryMaximumObservations);
    assertSize(observations, profileDiscoveryMaximumBytes);
    const grouped = new Map<ProfileFieldId, Map<string, { value: JsonValue; evidenceIds: Set<StableId<"evidence">> }>>();
    for (const value of observations) {
      const input = expectRecord(value, "attributed profile observation");
      expectOnlyKeys(input, ["fieldId", "value", "evidenceIds"], "attributed profile observation");
      const id = expectEnum(input.fieldId, profileFieldIds, "profile observation field");
      const fact = parseField(id, { status: "observed", value: input.value, evidenceIds: input.evidenceIds });
      if (fact.status !== "observed") throw new Error(invalidProposal);
      const alternatives = grouped.get(id) ?? new Map<string, { value: JsonValue; evidenceIds: Set<StableId<"evidence">> }>();
      const key = digest(fact.value), previous = alternatives.get(key);
      const merged = new Set([...(previous?.evidenceIds ?? []), ...fact.evidenceIds]);
      if (merged.size > 20) throw new Error(invalidProposal);
      alternatives.set(key, { value: fact.value, evidenceIds: merged });
      if (alternatives.size > 5) throw new Error(invalidProposal);
      grouped.set(id, alternatives);
    }
    const fields = Object.fromEntries(profileFieldIds.map(id => {
      const alternatives = grouped.get(id);
      if (!alternatives) return [id, { status: "missing", reason: "No attributed observation was supplied for this field.", question: `What is the intended value for ${id}?` }];
      const values = [...alternatives.keys()].sort().map(key => {
        const fact = alternatives.get(key)!;
        return { value: fact.value, evidenceIds: [...fact.evidenceIds].sort() };
      });
      return [id, values.length === 1 ? { status: "observed", ...values[0]! }
        : { status: "conflicted", question: `Which attributed value is intended for ${id}?`, alternatives: values }];
    }));
    // Apply the same cross-field credentials, tracker semantics and complete-document bounds as direct proposals.
    return prepareProfileProposalFields(fields).fields;
  } catch { throw new Error("Invalid profile discovery observations; no partial fields returned."); }
}

export function parseProfileProposalProducer(value: unknown): ProfileProposalProducer {
  const producer = expectRecord(value, "profile producer");
  expectOnlyKeys(producer, ["component", "version", "artifactDigest"], "profile producer");
  return { component: text(producer.component, 200), version: text(producer.version, 200), artifactDigest: parseDigest(producer.artifactDigest) };
}

export function parseProfileProposalIdentity(value: unknown): ProfileProposalIdentity {
  const input = expectRecord(value, "profile proposal identity");
  expectOnlyKeys(input, ["proposalId", "projectId", "candidateProfile", "baseProfile", "supersedesProposalId"], "profile proposal identity");
  const proposalId = parseStableId(input.proposalId, "projectProfileProposal");
  const candidateProfile = parseProfileReference(input.candidateProfile);
  let baseProfile: ProfileProposalMetadata["baseProfile"] = null;
  if (input.baseProfile !== null) {
    const base = expectRecord(input.baseProfile, "base profile");
    expectOnlyKeys(base, ["profileId", "profileVersion", "profileDigest"], "base profile");
    baseProfile = { ...parseProfileReference({ profileId: base.profileId, profileVersion: base.profileVersion }), profileDigest: parseDigest(base.profileDigest) };
    if (baseProfile.profileId !== candidateProfile.profileId || baseProfile.profileVersion === candidateProfile.profileVersion) throw new Error(invalidProposal);
  }
  const supersedesProposalId = input.supersedesProposalId === null ? null : parseStableId(input.supersedesProposalId, "projectProfileProposal");
  if (supersedesProposalId === proposalId) throw new Error(invalidProposal);
  return { proposalId, projectId: parseStableId(input.projectId, "project"), candidateProfile, baseProfile, supersedesProposalId };
}

function parseProfileReference(value: unknown) {
  const input = expectRecord(value, "profile reference");
  expectOnlyKeys(input, ["profileId", "profileVersion"], "profile reference");
  return { profileId: parseStableId(input.profileId, "projectProfile"), profileVersion: semanticVersion(input.profileVersion) };
}

function parseField(id: ProfileFieldId, value: unknown): ProfileProposalField {
  const input = expectRecord(value, "profile field");
  const status = expectEnum(input.status, ["observed", "proposed", "missing", "conflicted", "not_applicable"] as const, "profile field status");
  if (status === "missing") {
    expectOnlyKeys(input, ["status", "reason", "question"], "missing profile field");
    return { status, reason: text(input.reason, 2000), question: text(input.question, 2000) };
  }
  if (status === "conflicted") {
    expectOnlyKeys(input, ["status", "question", "alternatives"], "conflicted profile field");
    const alternatives = boundedArray(input.alternatives, 5, 2).map(value => {
      const alternative = expectRecord(value, "profile alternative");
      expectOnlyKeys(alternative, ["value", "evidenceIds"], "profile alternative");
      return { value: parseFactValue(id, alternative.value), evidenceIds: evidenceIds(alternative.evidenceIds, 1) };
    });
    if (new Set(alternatives.map(item => digest(item.value))).size !== alternatives.length) throw new Error(invalidProposal);
    return { status, question: text(input.question, 2000), alternatives };
  }
  if (status === "not_applicable") {
    expectOnlyKeys(input, ["status", "rationale", "evidenceIds"], "proposed non-applicability");
    return { status, rationale: text(input.rationale, 2000), evidenceIds: evidenceIds(input.evidenceIds, 0) };
  }
  expectOnlyKeys(input, status === "observed" ? ["status", "value", "evidenceIds"] : ["status", "value", "rationale", "evidenceIds"], "profile fact");
  const fact = { value: parseFactValue(id, input.value), evidenceIds: evidenceIds(input.evidenceIds, status === "observed" ? 1 : 0) };
  return status === "observed" ? { status, ...fact } : { status, ...fact, rationale: text(input.rationale, 2000) };
}

function parseFactValue(id: ProfileFieldId, value: unknown): JsonValue {
  // Most fields are inert review content, not a compiled runtime profile. Special boundary
  // records below prohibit secret-shaped credentials and universal tracker-state inference.
  const result = boundedJson(value);
  assertSize(result, factMaximumBytes);
  if (id.startsWith("credentials.")) {
    const references = id === "credentials.references";
    const rows = boundedArray(result, 50).map(value => {
      const row = expectRecord(value, "credential reference metadata");
      expectOnlyKeys(row, references ? ["credentialReferenceId", "version", "purpose"]
        : ["credentialReferenceId", "credentialReferenceVersion", "identityRef"], "credential reference metadata");
      const credentialReferenceId = parseStableId(row.credentialReferenceId, "credentialReference");
      return references ? { credentialReferenceId, version: text(row.version, 100), purpose: text(row.purpose, 200) }
        : { credentialReferenceId, credentialReferenceVersion: text(row.credentialReferenceVersion, 100), identityRef: text(row.identityRef, 512) };
    });
    if (new Set(rows.map(row => references ? JSON.stringify([row.credentialReferenceId, row.version])
      : JSON.stringify([row.credentialReferenceId, row.credentialReferenceVersion, row.identityRef]))).size !== rows.length) throw new Error(invalidProposal);
    return rows;
  }
  if (id === "tracker.semanticMappings") {
    const rows = boundedArray(result, 100).map(value => {
      const row = expectRecord(value, "tracker mapping");
      expectOnlyKeys(row, ["adapterId", "adapterVersion", "instanceRef", "itemType", "nativeState", "semanticCategory"], "tracker mapping");
      return { adapterId: parseStableId(row.adapterId, "adapter"), adapterVersion: semanticVersion(row.adapterVersion),
        instanceRef: text(row.instanceRef, 512), itemType: text(row.itemType, 200), nativeState: text(row.nativeState, 200),
        semanticCategory: row.semanticCategory === null ? null : expectEnum(row.semanticCategory, trackerSemanticCategories, "tracker semantic category") };
    });
    if (new Set(rows.map(({ semanticCategory: _category, ...identity }) => digest(identity))).size !== rows.length) throw new Error(invalidProposal);
    return rows;
  }
  if (id === "knowledge.sourceAuthorityRules") expectRecord(result, "proposed source authority rules");
  return result;
}

function validateCredentialReferences(fields: Readonly<Record<ProfileFieldId, ProfileProposalField>>): void {
  const refs = fields["credentials.references"];
  // Unresolved discovery is retained, not resolved by guessing the missing reference catalog.
  if (refs.status === "missing" || refs.status === "conflicted") return;
  const values = refs.status === "not_applicable" ? [] : refs.value as readonly { credentialReferenceId: string; version: string }[];
  const declared = new Set(values.map(row => JSON.stringify([row.credentialReferenceId, row.version])));
  for (const fieldId of ["credentials.readIdentities", "credentials.writeIdentities"] as const) {
    const field = fields[fieldId];
    const alternatives = field.status === "conflicted" ? field.alternatives : field.status === "observed" || field.status === "proposed" ? [field] : [];
    for (const alternative of alternatives) for (const row of alternative.value as readonly { credentialReferenceId: string; credentialReferenceVersion: string }[]) {
      if (!declared.has(JSON.stringify([row.credentialReferenceId, row.credentialReferenceVersion]))) throw new Error(invalidProposal);
    }
  }
}

function boundedJson(value: unknown, depth = 0, state = { nodes: 0 }): JsonValue {
  if (depth > 8 || ++state.nodes > 2000) throw new Error(invalidProposal);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") { if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) throw new Error(invalidProposal); return Object.is(value, -0) ? 0 : value; }
  if (typeof value === "string") return text(value, 4096, true);
  if (Array.isArray(value)) return boundedArray(value, 100).map(item => boundedJson(item, depth + 1, state));
  const input = expectRecord(value, "profile JSON");
  const keys = Object.keys(input).sort();
  if (keys.length > 100) throw new Error(invalidProposal);
  return Object.fromEntries(keys.map(key => {
    text(key, 100);
    if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error(invalidProposal);
    return [key, boundedJson(input[key], depth + 1, state)];
  }));
}

function fieldEvidenceIds(field: ProfileProposalField): readonly StableId<"evidence">[] {
  return field.status === "missing" ? [] : field.status === "conflicted" ? field.alternatives.flatMap(item => item.evidenceIds) : field.evidenceIds;
}
function evidenceIds(value: unknown, minimum: number) {
  const ids = boundedArray(value, 20, minimum).map(id => parseStableId(id, "evidence")).sort();
  if (new Set(ids).size !== ids.length) throw new Error(invalidProposal);
  return ids;
}
function parsePin(value: unknown, projectId: StableId<"project">): ProfileEvidencePin {
  const input = expectRecord(value, "profile evidence pin");
  expectOnlyKeys(input, ["evidenceId", "projectId", "identityDigest"], "profile evidence pin");
  if (input.projectId !== projectId) throw new Error(invalidProposal);
  return { evidenceId: parseStableId(input.evidenceId, "evidence"), projectId, identityDigest: parseDigest(input.identityDigest) };
}
function compareEvidenceIds(a: { readonly evidenceId: string }, b: { readonly evidenceId: string }) { return a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : 0; }
function boundedArray(value: unknown, maximum: number, minimum = 0) {
  const values = expectArray(value, "bounded profile collection");
  if (values.length < minimum || values.length > maximum) throw new Error(invalidProposal);
  // Sparse arrays skip map/flatMap callbacks and can otherwise lose required references.
  if (Reflect.ownKeys(values).length !== values.length + 1) throw new Error(invalidProposal);
  const dense: unknown[] = [];
  for (let index = 0; index < values.length; index++) {
    if (!Object.hasOwn(values, index)) throw new Error(invalidProposal);
    dense.push(values[index]);
  }
  return dense;
}
function text(value: unknown, maximum: number, allowEmpty = false): string {
  const parsed = expectString(value, "profile text", { allowEmpty });
  if (parsed !== parsed.trim() || parsed.length > maximum || /[\p{Cc}\p{Cs}]/u.test(parsed)) throw new Error(invalidProposal);
  return parsed;
}
function semanticVersion(value: unknown): string {
  const version = text(value, 100);
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version)) throw new Error(invalidProposal);
  return version;
}
function parseDigest(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error(invalidProposal);
  return value;
}
function digest(value: unknown): string { return canonicalJsonDigest(value as JsonValue); }
function assertSize(value: unknown, maximum: number): void {
  const json = JSON.stringify(value);
  if (typeof json !== "string" || Buffer.byteLength(json, "utf8") > maximum) throw new Error(invalidProposal);
}
