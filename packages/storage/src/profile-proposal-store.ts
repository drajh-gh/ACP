import {
  buildProfileConfirmationRequest, canonicalJsonDigest, expectJsonValue, expectOnlyKeys, expectRecord,
  parseCurrentProfileDiscoveryEvidence, parseProfileDiscoveryEvidenceQuery, parseProfileProposalIdentity, parseProfileProposalProducer, parseProjectProfileProposal, parseProjectProfileProposalQuery,
  preparePinnedProfileDiscovery, prepareProfileProposalFields, profileProposalMaximumBytes, reduceProfileDiscoveryObservations,
  type ProfileEvidencePin, type ProfileProposalIdentity, type ProfileProposalProducer, type ProjectProfileProposal, type ProjectProfileProposalQuery, type ProfileConfirmationRequest,
} from "@acp/domain";
import type { Pool, QueryResult, QueryResultRow } from "pg";
import type { QueryExecutor } from "./database.ts";
import { projectProfileProposalSql } from "./profile-proposal-query.ts";
import { parseExactProfileJson } from "./profile-proposal-json.ts";

export interface ProfileProposalWrite extends ProfileProposalIdentity { readonly fields: unknown }
export interface ProfileDiscoveryWrite extends ProfileProposalIdentity { readonly observations: unknown }
export interface PinnedProfileDiscoveryWrite extends ProfileDiscoveryWrite { readonly expectedEvidencePins: unknown }
/** Recorded proposal and review-request reads only. No producer, confirmation, publication or activation methods. */
export interface ProjectProfileProposalPersistence {
  getProjectProfileProposal(query: ProjectProfileProposalQuery): Promise<ProjectProfileProposal | undefined>;
  getProfileConfirmationRequest(query: ProjectProfileProposalQuery): Promise<ProfileConfirmationRequest | undefined>;
}
const unavailable = "Profile proposal is unavailable; no partial snapshot returned.";
const requestUnavailable = "Profile confirmation request is unavailable; no partial request returned.";
const storageMaximumBytes = profileProposalMaximumBytes * 2;

/** Private, trusted discovery producer. This is not a public tool, human principal or publication grant. */
export class PostgresProfileProposalStore {
  private readonly pool: Pool;
  private readonly producer: ProfileProposalProducer;
  constructor(pool: Pool, producer: ProfileProposalProducer) {
    for (const [key, maximum] of [["max", 8], ["connectionTimeoutMillis", 10_000], ["statement_timeout", 10_000], ["lock_timeout", 5_000]] as const) {
      const value = pool.options[key];
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maximum) throw new TypeError(`profile proposal pool ${key} must be explicitly bounded from 1 to ${maximum}`);
    }
    this.producer = Object.freeze(parseProfileProposalProducer(producer)); this.pool = pool;
  }

  /** Private reduction only; source selection/redaction precedes this call. No provider discovery or public writer. */
  async recordDiscovery(value: ProfileDiscoveryWrite): Promise<{ readonly proposal: ProjectProfileProposal; readonly replayed: boolean }> {
    const supplied = expectRecord(value, "profile discovery write");
    expectOnlyKeys(supplied, ["proposalId", "projectId", "candidateProfile", "baseProfile", "supersedesProposalId", "observations"], "profile discovery write");
    const { observations, ...identity } = supplied;
    const input = parseProfileProposalIdentity(identity), fields = reduceProfileDiscoveryObservations(observations);
    return this.record({ ...input, fields });
  }

  /** Private SHA-256 source descriptor, never raw content or a public read tool. One current MVCC observation, not a lease. */
  async getCurrentDiscoveryEvidence(value: unknown) {
    try {
      const query = parseProfileDiscoveryEvidenceQuery(value);
      const result = await this.pool.query(`SELECT CASE WHEN e.sensitivity IN ('public','project_confidential')
        AND e.freshness='current' AND e.accessibility='available' AND e.content_hash ~ '^sha256:[0-9a-f]{64}$'
        AND isfinite(e.observed_at) AND isfinite(e.retrieved_at)
        AND e.observed_at >= timestamptz '0001-01-01 00:00:00+00' AND e.retrieved_at < timestamptz '10000-01-01 00:00:00+00'
        AND e.observed_at <= e.retrieved_at AND e.retrieved_at <= clock_timestamp()
        THEN jsonb_build_object('projectId',e.project_id,'evidenceId',e.evidence_id,'contentHash',e.content_hash,
          'expectedPin',jsonb_build_object('projectId',e.project_id,'evidenceId',e.evidence_id,'identityDigest',acp.readiness_evidence_fingerprint(e)))
        END AS source FROM acp.evidence_records e WHERE e.project_id=$1 AND e.evidence_id=$2`, [query.projectId, query.evidenceId]);
      if (result.rows.length !== 1) throw new Error("missing discovery evidence");
      return parseCurrentProfileDiscoveryEvidence(result.rows[0].source, query);
    } catch { throw new Error("Current discovery evidence is unavailable."); }
  }

  async record(value: ProfileProposalWrite): Promise<{ readonly proposal: ProjectProfileProposal; readonly replayed: boolean }> {
    return this.recordPrepared(value);
  }

  /** New admissions require usable, exact evidence under locks; retries compare retained pins without renewal. */
  async recordPinnedDiscovery(value: PinnedProfileDiscoveryWrite): Promise<{ readonly proposal: ProjectProfileProposal; readonly replayed: boolean }> {
    const supplied = expectRecord(value, "pinned profile discovery write");
    expectOnlyKeys(supplied, ["proposalId", "projectId", "candidateProfile", "baseProfile", "supersedesProposalId", "observations", "expectedEvidencePins"], "pinned profile discovery write");
    const { observations, expectedEvidencePins: selectedPins, ...identity } = supplied;
    const input = parseProfileProposalIdentity(identity);
    const { fields, expectedEvidencePins } = preparePinnedProfileDiscovery(input.projectId, observations, selectedPins);
    return this.recordPrepared({ ...input, fields }, expectedEvidencePins);
  }

  private async recordPrepared(value: ProfileProposalWrite, expectedEvidencePins?: readonly ProfileEvidencePin[]): Promise<{ readonly proposal: ProjectProfileProposal; readonly replayed: boolean }> {
    const supplied = expectRecord(value, "profile proposal write");
    expectOnlyKeys(supplied, ["proposalId", "projectId", "candidateProfile", "baseProfile", "supersedesProposalId", "fields"], "profile proposal write");
    const { fields: selected, ...identity } = supplied;
    const input = { ...parseProfileProposalIdentity(identity), fields: prepareProfileProposalFields(selected).fields, producer: this.producer };
    let attempted = false;
    try {
      const physical = await this.pool.connect();
      let connectionFailure: Error | undefined;
      const failed = (error: Error) => { connectionFailure ??= error; };
      physical.on?.("error", failed);
      const client: QueryExecutor = { async query<R extends QueryResultRow>(sql: string, values?: unknown[]): Promise<QueryResult<R>> {
        if (connectionFailure) throw connectionFailure;
        const result = await physical.query<R>(sql,values);
        if (connectionFailure) throw connectionFailure;
        return result;
      } };
      try {
        await client.query("BEGIN");
        // Historical exact retries precede all current admission checks, never renew or re-pin.
        const previous = await load(client, input.proposalId);
        if (previous) { const result = exactResult(previous, input, true, expectedEvidencePins); attempted = true; await client.query("COMMIT"); return result; }
        // Match the proposal trigger's project -> baseline -> sorted evidence lock order.
        if (expectedEvidencePins) {
          const project = await client.query("SELECT project_id FROM acp.projects WHERE project_id=$1 FOR SHARE", [input.projectId]);
          if (project.rows.length !== 1) throw new Error("profile discovery expected evidence project is unavailable");
        }
        if (input.baseProfile) {
          const base = (await client.query(`SELECT CASE WHEN octet_length(profile::text)<=$4 THEN acp.jsonb_sha256(profile) END AS profile_digest
            FROM acp.project_profiles WHERE project_id=$1 AND profile_id=$2 AND version=$3 FOR SHARE`,
          [input.projectId,input.baseProfile.profileId,input.baseProfile.profileVersion,storageMaximumBytes])).rows[0];
          if (!base || base.profile_digest !== input.baseProfile.profileDigest) throw new Error("profile proposal baseline does not match exact retained content");
        }
        if (expectedEvidencePins) await checkExpectedEvidence(client, input.projectId, expectedEvidencePins);
        attempted = true;
        const row = (await client.query(`INSERT INTO acp.project_profile_proposals
          (proposal_id,project_id,profile_id,profile_version,base_profile_version,base_profile_digest,supersedes_proposal_id,producer,fields)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb) RETURNING body::text AS body`,
        [input.proposalId,input.projectId,input.candidateProfile.profileId,input.candidateProfile.profileVersion,
          input.baseProfile?.profileVersion ?? null,input.baseProfile?.profileDigest ?? null,input.supersedesProposalId,
          JSON.stringify(input.producer),JSON.stringify(input.fields)])).rows[0];
        if (!row) throw new Error("profile proposal insertion returned no body");
        // Domain semantics and canonical byte ceiling are checked before COMMIT, not just on a later read.
        const result = exactResult(parseBody(row.body), input, false, expectedEvidencePins);
        await client.query("COMMIT"); return result;
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch { /* Physical discard resolves uncertainty. */ }
        throw error;
      } finally { try { physical.release(true); } finally { physical.off?.("error", failed); } }
    } catch (error) {
      if (!attempted) throw error;
      let recovered: ProjectProfileProposal | undefined;
      try { recovered = await load(this.pool, input.proposalId); } catch { throw error; }
      if (recovered) return exactResult(recovered, input, true, expectedEvidencePins);
      throw error;
    }
  }
}

/** Bounded, disclosure-checked historical read. No latest fallback, mutation or authorization. */
export async function getProjectProfileProposal(executor: QueryExecutor, queryValue: unknown): Promise<ProjectProfileProposal | undefined> {
  try { return (await snapshot(executor, queryValue))?.proposal; } catch { throw new Error(unavailable); }
}

/** One MVCC observation, not a reservation or accepted human confirmation. */
export async function getProfileConfirmationRequest(executor: QueryExecutor, queryValue: unknown) {
  try {
    const current = await snapshot(executor, queryValue);
    if (!current) return undefined;
    const { proposal, data } = current;
    const baseProfileMatches = proposal.baseProfile === null ? data.baseProfileDigest === null
      : data.baseProfileDigest === proposal.baseProfile.profileDigest;
    return buildProfileConfirmationRequest(proposal, { currentProposalId: data.currentProposalId,
      candidateProfileExists: data.candidateProfileExists, baseProfileMatches, asOf: data.asOf, evidence: data.evidence });
  } catch { throw new Error(requestUnavailable); }
}

async function snapshot(executor: QueryExecutor, value: unknown) {
  const { projectId, proposalId } = parseProjectProfileProposalQuery(value);
  const row = (await executor.query(projectProfileProposalSql, [projectId,proposalId,storageMaximumBytes])).rows[0];
  if (!row) return undefined;
  if (row.proposal_error !== null) throw new Error(unavailable);
  const data = expectRecord(row.snapshot, "profile proposal snapshot");
  expectOnlyKeys(data, ["currentProposalId", "candidateProfileExists", "baseProfileDigest", "asOf", "evidence"], "profile proposal snapshot");
  const proposal = parseBody(row.body);
  if (proposal.projectId !== projectId || proposal.proposalId !== proposalId) throw new Error(unavailable);
  return { proposal, data };
}

function parseBody(value: unknown): ProjectProfileProposal {
  const body = expectRecord(parseExactProfileJson(value), "stored profile proposal body");
  if (Object.hasOwn(body, "proposalDigest")) throw new Error(unavailable);
  return parseProjectProfileProposal({ ...body, proposalDigest: digest(body) });
}
function digest(value: unknown): string { return canonicalJsonDigest(expectJsonValue(value, "profile JSON")); }
async function load(executor: QueryExecutor, proposalId: string) {
  const row = (await executor.query("SELECT CASE WHEN octet_length(body::text)<=$2 THEN body::text END AS body FROM acp.project_profile_proposals WHERE proposal_id=$1", [proposalId,storageMaximumBytes])).rows[0];
  return row ? parseBody(row.body) : undefined;
}
async function checkExpectedEvidence(client: QueryExecutor, projectId: string, expected: readonly ProfileEvidencePin[]) {
  const rows = (await client.query(`SELECT e.evidence_id AS "evidenceId", e.project_id AS "projectId",
    acp.readiness_evidence_fingerprint(e) AS "identityDigest",
    (e.sensitivity IN ('public','project_confidential') AND e.freshness='current' AND e.accessibility='available'
      AND e.content_hash IS NOT NULL AND isfinite(e.observed_at) AND isfinite(e.retrieved_at)
      AND e.observed_at >= timestamptz '0001-01-01 00:00:00+00' AND e.retrieved_at < timestamptz '10000-01-01 00:00:00+00'
      AND e.observed_at <= e.retrieved_at AND e.retrieved_at <= clock_timestamp()) AS usable
    FROM acp.evidence_records e WHERE e.project_id=$1 AND e.evidence_id=ANY($2::text[])
    ORDER BY e.evidence_id FOR SHARE OF e`, [projectId, expected.map(pin => pin.evidenceId)])).rows;
  if (rows.length !== expected.length || rows.some((row, index) => row.usable !== true
    || row.evidenceId !== expected[index]!.evidenceId || row.projectId !== projectId
    || row.identityDigest !== expected[index]!.identityDigest)) throw new Error("profile discovery expected evidence is changed or unusable");
}
function exactResult(actual: ProjectProfileProposal, expected: ProfileProposalIdentity & { fields: unknown; producer: ProfileProposalProducer }, replayed: boolean, expectedEvidencePins?: readonly ProfileEvidencePin[]) {
  const { proposedAt: _time, evidencePins: _pins, proposalSchemaVersion: _schema, state: _state, authority: _authority, proposalDigest: _digest, ...terms } = actual;
  if (digest(terms) !== digest(expected)) throw new Error("profile proposal aliases different terms or original producer identity");
  if (expectedEvidencePins && digest(actual.evidencePins) !== digest(expectedEvidencePins)) throw new Error("profile discovery expected evidence differs from retained pins");
  return { proposal: actual, replayed };
}
