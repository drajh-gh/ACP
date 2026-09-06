import { evidenceAccessibilityStates, evidenceFreshnessStates } from "./claims.ts";
import { parseStableId, type StableId } from "./ids.ts";
import { capabilityReadinessStates, type CapabilityReadinessState } from "./reconciliation.ts";
import { expectArray, expectBoolean, expectEnum, expectIsoTimestamp, expectOnlyKeys, expectRecord, expectString } from "./validation.ts";

export const readinessKeyLimit = 50;
export const projectReadinessSchemaVersion = "2.0.0";
export const readinessEvidenceLimit = 20;
export const readinessMaximumBytes = 65_536;
export const readinessMaximumValidityMicroseconds = 86_400_000_000n;
export const readinessCurrentReasonCodes = [
  "not_assessed", "recorded_unknown", "recorded_revocation", "assessment_expired",
  "supporting_evidence_identity_changed", "supporting_evidence_unusable", "recorded_assessment",
] as const;

export interface ReadinessKey {
  readonly capability: string;
  readonly resourceKey: string;
  readonly resourceVersion: string;
}

export interface ProjectReadinessQuery {
  readonly projectId: StableId<"project">;
  readonly profileId: StableId<"projectProfile">;
  readonly profileVersion: string;
  readonly keys: readonly ReadinessKey[];
}

export interface ReadinessAssessment extends ReadinessKey {
  readonly assessmentId: StableId<"capabilityReadinessAssessment">;
  readonly projectId: StableId<"project">;
  readonly profileId: StableId<"projectProfile">;
  readonly profileVersion: string;
  readonly recordedState: CapabilityReadinessState;
  /** Already-redacted explanation supplied by a trusted evaluator, not automatic sanitization. */
  readonly recordedReason: string;
  readonly assessedAt: string;
  readonly validUntil: string;
  readonly evidenceIds: readonly StableId<"evidence">[];
  readonly evaluatorVersion: string;
  readonly provenanceId: StableId<"provenance">;
  readonly supersedesAssessmentId: StableId<"capabilityReadinessAssessment"> | null;
}

export interface ReadinessEvidenceMetadata {
  readonly evidenceId: StableId<"evidence">;
  readonly observedAt: string;
  readonly retrievedAt: string;
  readonly contentHashPresent: boolean;
  readonly freshness: (typeof evidenceFreshnessStates)[number];
  readonly accessibility: (typeof evidenceAccessibilityStates)[number];
}

export interface ReadinessEntry extends ReadinessKey {
  readonly recorded: ReadinessAssessment | null;
  readonly evidenceIdentityMatches: boolean | null;
  readonly currentState: CapabilityReadinessState;
  readonly currentReasonCode: (typeof readinessCurrentReasonCodes)[number];
}

const assessmentScope = {
  kind: "recorded_only", freshness: "recorded_deadline_and_evidence_metadata",
  authority: "none", liveProbes: "not_performed",
} as const;

export interface ProjectReadiness {
  readonly schemaVersion: typeof projectReadinessSchemaVersion;
  readonly projectId: StableId<"project">;
  readonly profileId: StableId<"projectProfile">;
  readonly profileVersion: string;
  readonly asOf: string;
  readonly assessment: typeof assessmentScope;
  readonly entries: readonly ReadinessEntry[];
  readonly evidence: readonly ReadinessEvidenceMetadata[];
}

const keyFields = ["capability", "resourceKey", "resourceVersion"];
const scopeFields = ["projectId", "profileId", "profileVersion"];
const assessmentFields = [...scopeFields, ...keyFields, "assessmentId", "recordedState", "recordedReason",
  "assessedAt", "validUntil", "evidenceIds", "evaluatorVersion", "provenanceId", "supersedesAssessmentId"];
const evidenceFields = ["evidenceId", "observedAt", "retrievedAt", "contentHashPresent", "freshness", "accessibility"];
const invalidReferences = "readiness snapshot contains invalid or undisclosable references";

/** Exact PostgreSQL-compatible UTC microseconds; no Date-based millisecond identity. */
export function parseReadinessTimestamp(value: unknown): string {
  const input = expectIsoTimestamp(value, "readiness timestamp");
  const parts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/u.exec(input);
  if (!parts || input.startsWith("0000-")) throw new TypeError("readiness timestamp must have a Gregorian date and at most six fractional digits");
  const wall = new Date(`${parts[1]}Z`);
  if (Number.isNaN(wall.getTime()) || wall.toISOString().slice(0, 19) !== parts[1]) {
    throw new TypeError("readiness timestamp must have a valid Gregorian date and time");
  }
  const fraction = (parts[2] ?? "").padEnd(6, "0");
  const utc = new Date(input).toISOString();
  if (utc.length !== 24 || utc.startsWith("0000-")) throw new TypeError("readiness timestamp UTC year must be between 0001 and 9999");
  return `${utc.slice(0, 20)}${fraction}Z`;
}

export function readinessTimestampMicroseconds(value: unknown): bigint {
  const canonical = parseReadinessTimestamp(value);
  return BigInt(Date.parse(canonical)) * 1000n + BigInt(canonical.slice(23, 26));
}

export function readinessKeyIdentity(key: ReadinessKey): string {
  return JSON.stringify([key.capability, key.resourceKey, key.resourceVersion]);
}

export function parseProjectReadinessQuery(value: unknown): ProjectReadinessQuery {
  const input = expectRecord(value, "readiness query");
  expectOnlyKeys(input, [...scopeFields, "keys"], "readiness query");
  const keys = boundedArray(input.keys, "readiness keys", readinessKeyLimit, 1).map(value => {
    const key = expectRecord(value, "readiness key");
    expectOnlyKeys(key, keyFields, "readiness key");
    return parseKey(key);
  });
  if (new Set(keys.map(readinessKeyIdentity)).size !== keys.length) throw new TypeError("readiness keys must be unique");
  return { ...parseScope(input), keys };
}

export function parseReadinessAssessment(value: unknown): ReadinessAssessment {
  const input = expectRecord(value, "readiness assessment");
  expectOnlyKeys(input, assessmentFields, "readiness assessment");
  const assessedAt = parseReadinessTimestamp(input.assessedAt);
  const validUntil = parseReadinessTimestamp(input.validUntil);
  const validity = readinessTimestampMicroseconds(validUntil) - readinessTimestampMicroseconds(assessedAt);
  if (validity <= 0n || validity > readinessMaximumValidityMicroseconds) throw new TypeError("readiness validity must be positive and at most 24 hours");
  const evidenceIds = boundedArray(input.evidenceIds, "readiness evidence", readinessEvidenceLimit)
    .map(id => parseStableId(id, "evidence")).sort();
  if (new Set(evidenceIds).size !== evidenceIds.length) throw new TypeError("readiness evidence identifiers must be unique");
  const recordedState = expectEnum(input.recordedState, capabilityReadinessStates, "readiness recorded state");
  if (isPositive(recordedState) && evidenceIds.length === 0) throw new TypeError("positive readiness requires supporting evidence");
  const assessmentId = parseStableId(input.assessmentId, "capabilityReadinessAssessment");
  const supersedesAssessmentId = input.supersedesAssessmentId === null ? null
    : parseStableId(input.supersedesAssessmentId, "capabilityReadinessAssessment");
  if (assessmentId === supersedesAssessmentId) throw new TypeError("readiness assessment cannot supersede itself");
  return {
    assessmentId, ...parseScope(input), ...parseKey(input), recordedState,
    recordedReason: boundedText(input.recordedReason, "readiness recorded reason", 2000),
    assessedAt, validUntil, evidenceIds, evaluatorVersion: boundedText(input.evaluatorVersion, "readiness evaluator version", 200),
    provenanceId: parseStableId(input.provenanceId, "provenance"), supersedesAssessmentId,
  };
}

/**
 * Build from a trusted snapshot clock and at most one already-selected latest row per key.
 * Storage must establish profile existence, history/supersession and writer provenance.
 * This pure projection neither queries a provider nor creates authority.
 */
export function buildProjectReadiness(
  queryValue: unknown, asOfValue: unknown, selectedLatest: unknown, selectedEvidence: unknown,
  selectedIdentityMatches: unknown,
): ProjectReadiness {
  const query = parseProjectReadinessQuery(queryValue);
  const asOf = parseReadinessTimestamp(asOfValue);
  const clock = readinessTimestampMicroseconds(asOf);
  let rows: ReadinessAssessment[];
  let evidence: ReadinessEvidenceMetadata[];
  const identityMatches = new Map<string, boolean>();
  try {
    rows = boundedArray(selectedLatest, "selected readiness", readinessKeyLimit).map(parseReadinessAssessment);
    const requested = new Set(query.keys.map(readinessKeyIdentity));
    const found = new Set<string>();
    const assessmentIds = new Set<string>();
    for (const row of rows) {
      const key = readinessKeyIdentity(row);
      if (!sameScope(query, row) || !requested.has(key) || found.has(key) || assessmentIds.has(row.assessmentId)
        || readinessTimestampMicroseconds(row.assessedAt) > clock) throw new Error(invalidReferences);
      found.add(key);
      assessmentIds.add(row.assessmentId);
    }
    for (const value of boundedArray(selectedIdentityMatches, "readiness identity comparisons", readinessKeyLimit)) {
      const input = expectRecord(value, "readiness identity comparison");
      expectOnlyKeys(input, ["assessmentId", "matches"], "readiness identity comparison");
      const id = parseStableId(input.assessmentId, "capabilityReadinessAssessment");
      if (!assessmentIds.has(id) || identityMatches.has(id)) throw new Error(invalidReferences);
      identityMatches.set(id, expectBoolean(input.matches, "readiness evidence identity match"));
    }
    if (identityMatches.size !== assessmentIds.size) throw new Error(invalidReferences);
    const referenced = new Set(rows.flatMap(row => row.evidenceIds));
    const seen = new Set<string>();
    evidence = boundedArray(selectedEvidence, "selected evidence", readinessKeyLimit * readinessEvidenceLimit).map(value => {
      const input = expectRecord(value, "readiness evidence");
      expectOnlyKeys(input, [...evidenceFields.filter(field => field !== "contentHashPresent"), "projectId", "sensitivity", "contentHash"], "readiness evidence");
      const id = parseStableId(input.evidenceId, "evidence");
      if (input.projectId !== query.projectId || !["public", "project_confidential"].includes(String(input.sensitivity))
        || !referenced.has(id) || seen.has(id)) throw new Error(invalidReferences);
      seen.add(id);
      const contentHash = input.contentHash === null ? null : boundedText(input.contentHash, "evidence content hash", 512);
      return parseEvidenceMetadata({
        evidenceId: id, observedAt: input.observedAt, retrievedAt: input.retrievedAt,
        contentHashPresent: contentHash !== null, freshness: input.freshness, accessibility: input.accessibility,
      }, clock);
    }).sort((a, b) => a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : 0);
    if (seen.size !== referenced.size) throw new Error(invalidReferences);
  } catch {
    // Never identify the restricted/missing project, assessment or evidence in a partial response.
    throw new Error(invalidReferences);
  }
  const byKey = new Map(rows.map(row => [readinessKeyIdentity(row), row]));
  const byEvidence = new Map(evidence.map(item => [item.evidenceId, item]));
  const result: ProjectReadiness = {
    schemaVersion: projectReadinessSchemaVersion, projectId: query.projectId, profileId: query.profileId, profileVersion: query.profileVersion,
    asOf, assessment: { ...assessmentScope }, entries: query.keys.map(key => {
      const recorded = byKey.get(readinessKeyIdentity(key)) ?? null;
      const evidenceIdentityMatches = recorded === null ? null : identityMatches.get(recorded.assessmentId)!;
      return { ...key, recorded, evidenceIdentityMatches, ...currentAssessment(recorded, clock, byEvidence, evidenceIdentityMatches) };
    }), evidence,
  };
  assertSize(result);
  return result;
}

/** Validate identity and recompute every derived state before serving a stored/adaptor response. */
export function parseProjectReadiness(value: unknown, queryValue: unknown): ProjectReadiness {
  assertSize(value);
  const input = expectRecord(value, "project readiness");
  expectOnlyKeys(input, ["schemaVersion", ...scopeFields, "asOf", "assessment", "entries", "evidence"], "project readiness");
  const query = parseProjectReadinessQuery(queryValue);
  if (input.schemaVersion !== projectReadinessSchemaVersion || !sameScope(query, parseScope(input))) throw new TypeError("readiness snapshot identity mismatch");
  const asOf = parseReadinessTimestamp(input.asOf);
  const clock = readinessTimestampMicroseconds(asOf);
  const scope = expectRecord(input.assessment, "readiness assessment scope");
  expectOnlyKeys(scope, Object.keys(assessmentScope), "readiness assessment scope");
  for (const field of Object.keys(assessmentScope) as (keyof typeof assessmentScope)[]) {
    if (scope[field] !== assessmentScope[field]) throw new TypeError("readiness snapshot cannot claim live probes or authority");
  }
  const entries = boundedArray(input.entries, "readiness entries", readinessKeyLimit, 1).map(value => {
    const entry = expectRecord(value, "readiness entry");
    expectOnlyKeys(entry, [...keyFields, "recorded", "evidenceIdentityMatches", "currentState", "currentReasonCode"], "readiness entry");
    return {
      ...parseKey(entry), recorded: entry.recorded === null ? null : parseReadinessAssessment(entry.recorded),
      evidenceIdentityMatches: entry.evidenceIdentityMatches === null ? null : expectBoolean(entry.evidenceIdentityMatches, "readiness evidence identity match"),
      currentState: expectEnum(entry.currentState, capabilityReadinessStates, "readiness current state"),
      currentReasonCode: expectEnum(entry.currentReasonCode, readinessCurrentReasonCodes, "readiness current reason"),
    };
  });
  if (entries.length !== query.keys.length || entries.some((entry, index) => readinessKeyIdentity(entry) !== readinessKeyIdentity(query.keys[index]!))) {
    throw new TypeError("readiness snapshot requested keys mismatch");
  }
  const evidence = boundedArray(input.evidence, "readiness evidence metadata", readinessKeyLimit * readinessEvidenceLimit)
    .map(value => parseEvidenceMetadata(value, clock));
  const rebuilt = buildProjectReadiness(query, asOf, entries.flatMap(entry => entry.recorded === null ? [] : [entry.recorded]), evidence.map(item => ({
    evidenceId: item.evidenceId, projectId: query.projectId, observedAt: item.observedAt, retrievedAt: item.retrievedAt,
    contentHash: item.contentHashPresent ? "recorded-hash-present" : null, sensitivity: "project_confidential",
    freshness: item.freshness, accessibility: item.accessibility,
  })), entries.flatMap(entry => entry.recorded === null ? [] : [{ assessmentId: entry.recorded.assessmentId, matches: entry.evidenceIdentityMatches }]));
  if (JSON.stringify(entries) !== JSON.stringify(rebuilt.entries) || JSON.stringify(evidence) !== JSON.stringify(rebuilt.evidence)) {
    throw new TypeError("readiness snapshot derived state or evidence mismatch");
  }
  return rebuilt;
}

function currentAssessment(
  row: ReadinessAssessment | null, clock: bigint, evidence: ReadonlyMap<string, ReadinessEvidenceMetadata>,
  identityMatches: boolean | null,
): Pick<ReadinessEntry, "currentState" | "currentReasonCode"> {
  if (row === null) return { currentState: "unknown", currentReasonCode: "not_assessed" };
  if (row.recordedState === "unknown") return { currentState: "unknown", currentReasonCode: "recorded_unknown" };
  if (row.recordedState === "revoked") return { currentState: "revoked", currentReasonCode: "recorded_revocation" };
  if (clock >= readinessTimestampMicroseconds(row.validUntil)) return { currentState: "stale", currentReasonCode: "assessment_expired" };
  if (isPositive(row.recordedState) && identityMatches !== true) return { currentState: "stale", currentReasonCode: "supporting_evidence_identity_changed" };
  if (isPositive(row.recordedState) && row.evidenceIds.some(id => {
    const item = evidence.get(id);
    return !item || !item.contentHashPresent || item.freshness !== "current" || item.accessibility !== "available";
  })) return { currentState: "stale", currentReasonCode: "supporting_evidence_unusable" };
  return { currentState: row.recordedState, currentReasonCode: "recorded_assessment" };
}

function parseEvidenceMetadata(value: unknown, clock: bigint): ReadinessEvidenceMetadata {
  const input = expectRecord(value, "readiness evidence metadata");
  expectOnlyKeys(input, evidenceFields, "readiness evidence metadata");
  const observedAt = parseReadinessTimestamp(input.observedAt);
  const retrievedAt = parseReadinessTimestamp(input.retrievedAt);
  if (readinessTimestampMicroseconds(observedAt) > readinessTimestampMicroseconds(retrievedAt)
    || readinessTimestampMicroseconds(retrievedAt) > clock) throw new TypeError("readiness evidence has invalid observation boundaries");
  return {
    evidenceId: parseStableId(input.evidenceId, "evidence"), observedAt, retrievedAt,
    contentHashPresent: expectBoolean(input.contentHashPresent, "readiness evidence hash presence"),
    freshness: expectEnum(input.freshness, evidenceFreshnessStates, "readiness evidence freshness"),
    accessibility: expectEnum(input.accessibility, evidenceAccessibilityStates, "readiness evidence accessibility"),
  };
}

function parseScope(input: Readonly<Record<string, unknown>>) {
  const profileVersion = boundedText(input.profileVersion, "readiness profile version", 100);
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(profileVersion)) throw new TypeError("readiness profile version must be an exact registered semantic version");
  return { projectId: parseStableId(input.projectId, "project"), profileId: parseStableId(input.profileId, "projectProfile"), profileVersion };
}

function parseKey(input: Readonly<Record<string, unknown>>): ReadinessKey {
  return {
    capability: boundedText(input.capability, "readiness capability", 200),
    resourceKey: boundedText(input.resourceKey, "readiness resource key", 512),
    resourceVersion: boundedText(input.resourceVersion, "readiness resource version", 200),
  };
}

function sameScope(a: Pick<ProjectReadinessQuery, "projectId" | "profileId" | "profileVersion">, b: Pick<ProjectReadinessQuery, "projectId" | "profileId" | "profileVersion">): boolean {
  return a.projectId === b.projectId && a.profileId === b.profileId && a.profileVersion === b.profileVersion;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  const text = expectString(value, label);
  if (text !== text.trim() || text.length > maximum || /[\p{Cc}\p{Cs}]/u.test(text)) throw new TypeError(`${label} must be bounded canonical text without control characters`);
  return text;
}

function boundedArray(value: unknown, label: string, maximum: number, minimum = 0): readonly unknown[] {
  const array = expectArray(value, label);
  if (array.length < minimum || array.length > maximum) throw new TypeError(`${label} exceeds bounded collection`);
  return array;
}

function isPositive(state: CapabilityReadinessState): boolean {
  return state === "available" || state === "degraded";
}

function assertSize(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > readinessMaximumBytes) {
    throw new Error("readiness exceeds bounded snapshot; no partial readiness returned");
  }
}
