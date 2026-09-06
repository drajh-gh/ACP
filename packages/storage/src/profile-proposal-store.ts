import {
  buildProfileConfirmationRequest, canonicalJsonDigest, expectJsonValue, expectOnlyKeys, expectRecord,
  parseProfileProposalIdentity, parseProfileProposalProducer, parseProjectProfileProposal, parseStableId,
  prepareProfileProposalFields, profileProposalMaximumBytes,
  type ProfileProposalIdentity, type ProfileProposalProducer, type ProjectProfileProposal,
} from "@acp/domain";
import type { Pool, QueryResult, QueryResultRow } from "pg";
import type { QueryExecutor } from "./database.ts";
import { projectProfileProposalSql } from "./profile-proposal-query.ts";
import { parseExactProfileJson } from "./profile-proposal-json.ts";

export interface ProfileProposalWrite extends ProfileProposalIdentity { readonly fields: unknown }
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

  async record(value: ProfileProposalWrite): Promise<{ readonly proposal: ProjectProfileProposal; readonly replayed: boolean }> {
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
        if (previous) { const result = exactResult(previous, input, true); attempted = true; await client.query("COMMIT"); return result; }
        if (input.baseProfile) {
          const base = (await client.query(`SELECT CASE WHEN octet_length(profile::text)<=$4 THEN acp.jsonb_sha256(profile) END AS profile_digest
            FROM acp.project_profiles WHERE project_id=$1 AND profile_id=$2 AND version=$3 FOR SHARE`,
          [input.projectId,input.baseProfile.profileId,input.baseProfile.profileVersion,storageMaximumBytes])).rows[0];
          if (!base || base.profile_digest !== input.baseProfile.profileDigest) throw new Error("profile proposal baseline does not match exact retained content");
        }
        attempted = true;
        const row = (await client.query(`INSERT INTO acp.project_profile_proposals
          (proposal_id,project_id,profile_id,profile_version,base_profile_version,base_profile_digest,supersedes_proposal_id,producer,fields)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb) RETURNING body::text AS body`,
        [input.proposalId,input.projectId,input.candidateProfile.profileId,input.candidateProfile.profileVersion,
          input.baseProfile?.profileVersion ?? null,input.baseProfile?.profileDigest ?? null,input.supersedesProposalId,
          JSON.stringify(input.producer),JSON.stringify(input.fields)])).rows[0];
        if (!row) throw new Error("profile proposal insertion returned no body");
        // Domain semantics and canonical byte ceiling are checked before COMMIT, not just on a later read.
        const result = exactResult(parseBody(row.body), input, false);
        await client.query("COMMIT"); return result;
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch { /* Physical discard resolves uncertainty. */ }
        throw error;
      } finally { try { physical.release(true); } finally { physical.off?.("error", failed); } }
    } catch (error) {
      if (!attempted) throw error;
      let recovered: ProjectProfileProposal | undefined;
      try { recovered = await load(this.pool, input.proposalId); } catch { throw error; }
      if (recovered) return exactResult(recovered, input, true);
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
  const input = expectRecord(value, "exact profile proposal query");
  expectOnlyKeys(input, ["projectId", "proposalId"], "exact profile proposal query");
  const projectId = parseStableId(input.projectId, "project"), proposalId = parseStableId(input.proposalId, "projectProfileProposal");
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
function exactResult(actual: ProjectProfileProposal, expected: ProfileProposalIdentity & { fields: unknown; producer: ProfileProposalProducer }, replayed: boolean) {
  const { proposedAt: _time, evidencePins: _pins, proposalSchemaVersion: _schema, state: _state, authority: _authority, proposalDigest: _digest, ...terms } = actual;
  if (digest(terms) !== digest(expected)) throw new Error("profile proposal aliases different terms or original producer identity");
  return { proposal: actual, replayed };
}
