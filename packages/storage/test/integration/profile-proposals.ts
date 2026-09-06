import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool, type QueryResult, type QueryResultRow } from "pg";
import { buildProjectProfileProposal, canonicalJsonDigest, createStableId, prepareProfileProposalFields, profileFieldIds, type StableId } from "@acp/domain";
import { getProjectProfileProposal, getProfileConfirmationRequest, PostgresProfileProposalStore, type ProfileProposalWrite, type PinnedProfileDiscoveryWrite } from "../../src/profile-proposal-store.ts";
import { projectProfileProposalSql } from "../../src/profile-proposal-query.ts";

const port = Number(process.argv[2]), phase = process.argv[3];
if (!Number.isInteger(port) || port < 1024 || port > 65535 || !["core", "races", "references", "snapshot", "upgrade", "discovery", "pinned"].includes(phase ?? "")) throw new Error("owned database port and exact profile proposal phase required");
const pool = new Pool({ connectionString: `postgresql://postgres:acp_test_password@127.0.0.1:${port}/acp_test`, max: 4,
  connectionTimeoutMillis: 3000, statement_timeout: 5000, lock_timeout: 3000, application_name: "acp-profile-proposal-fixture" });
const legacy = (prefix: string) => `${prefix}_00000000-0000-4000-8000-000000000001`;
const projectId = legacy("prj") as StableId<"project">;
const producer = { component: "synthetic-profile-discovery", version: "1.0.0", artifactDigest: canonicalJsonDigest({ synthetic: true }) };
const store = new PostgresProfileProposalStore(pool, producer);
let checks = 0;
async function check(name: string, action: () => Promise<void>) { await action(); checks++; process.stdout.write(`PASS profile proposals: ${name}\n`); }
function terms(overrides: Partial<ProfileProposalWrite> = {}): ProfileProposalWrite {
  return { proposalId: createStableId("projectProfileProposal"), projectId,
    candidateProfile: { profileId: createStableId("projectProfile"), profileVersion: "1.0.0" },
    baseProfile: null, supersedesProposalId: null, fields: {}, ...overrides };
}
function resolvedFields() { return Object.fromEntries(profileFieldIds.map(id => [id, { status: "not_applicable", rationale: "Synthetic applicability proposal, not confirmation.", evidenceIds: [] }])); }
function observed(evidenceId: string) { return { status: "observed", value: "Synthetic product", evidenceIds: [evidenceId] }; }
const query = (row: ProfileProposalWrite) => ({ projectId: row.projectId, proposalId: row.proposalId });
async function clone(table: string, key: string, source: string, overrides: object) {
  assert.equal((await pool.query(`INSERT INTO acp.${table} SELECT (jsonb_populate_record(NULL::acp.${table},to_jsonb(source)||$1::jsonb)).*
    FROM acp.${table} source WHERE ${key}=$2`, [JSON.stringify(overrides),source])).rowCount, 1);
}
async function evidence(overrides: object = {}) {
  const evidenceId = createStableId("evidence");
  await clone("evidence_records", "evidence_id", legacy("evd"), { evidence_id: evidenceId, project_id: projectId,
    observed_at: "2026-09-04T00:00:00Z", retrieved_at: "2026-09-04T00:00:01Z", content_hash: "sha256:synthetic-profile",
    freshness: "current", accessibility: "available", sensitivity: "project_confidential", ...overrides });
  return evidenceId;
}
async function counts() { return (await pool.query(`SELECT jsonb_build_object('proposals',(SELECT count(*) FROM acp.project_profile_proposals),
  'pins',(SELECT count(*) FROM acp.project_profile_proposal_evidence),'profiles',(SELECT count(*) FROM acp.project_profiles),
  'grants',(SELECT count(*) FROM acp.capability_grants),'runs',(SELECT count(*) FROM acp.worker_runs),
  'effects',(SELECT count(*) FROM acp.effect_proposals),'missions',(SELECT count(*) FROM acp.missions)) AS counts`)).rows[0].counts; }
async function absent(id: string) {
  assert.equal((await pool.query("SELECT count(*)::integer AS n FROM acp.project_profile_proposals WHERE proposal_id=$1", [id])).rows[0].n, 0);
  assert.equal((await pool.query("SELECT count(*)::integer AS n FROM acp.project_profile_proposal_evidence WHERE proposal_id=$1", [id])).rows[0].n, 0);
}
async function insertDirect(client: { query(sql: string, values?: unknown[]): Promise<unknown> }, row: ProfileProposalWrite, extra: object = {}) {
  const input = { proposal_id: row.proposalId, project_id: row.projectId, profile_id: row.candidateProfile.profileId,
    profile_version: row.candidateProfile.profileVersion, base_profile_version: row.baseProfile?.profileVersion ?? null,
    base_profile_digest: row.baseProfile?.profileDigest ?? null, supersedes_proposal_id: row.supersedesProposalId,
    producer, fields: prepareProfileProposalFields(row.fields).fields, ...extra };
  return client.query("INSERT INTO acp.project_profile_proposals SELECT (jsonb_populate_record(NULL::acp.project_profile_proposals,$1::jsonb)).*", [JSON.stringify(input)]);
}
async function publish(row: ProfileProposalWrite) {
  await pool.query("INSERT INTO acp.project_profiles(profile_id,version,project_id,profile,published_at) VALUES($1,$2,$3,'{}',clock_timestamp())",
    [row.candidateProfile.profileId,row.candidateProfile.profileVersion,row.projectId]);
}
async function migration(direction: "up" | "down") {
  const sql = await readFile(new URL(`../../migrations/0018_project_profile_proposals${direction === "down" ? ".down" : ""}.sql`, import.meta.url), "utf8");
  const client = await pool.connect();
  try { await client.query("BEGIN"); await client.query(sql); await client.query("COMMIT"); }
  catch (error) { try { await client.query("ROLLBACK"); } catch { /* Discard follows. */ } throw error; }
  finally { client.release(true); }
}

try {
  if (phase === "pinned") {
    async function pins(ids: readonly string[]) {
      return (await pool.query(`SELECT evidence_id AS "evidenceId", project_id AS "projectId", acp.readiness_evidence_fingerprint(e) AS "identityDigest"
        FROM acp.evidence_records e WHERE evidence_id=ANY($1::text[]) ORDER BY evidence_id`, [ids])).rows;
    }
    async function pinned(ids: readonly string[]): Promise<PinnedProfileDiscoveryWrite> {
      const { fields: _fields, ...identity } = terms();
      return { ...identity, observations: ids.map(evidenceId => ({ fieldId: "context.product", value: "Synthetic", evidenceIds: [evidenceId] })), expectedEvidencePins: await pins(ids) };
    }
    const expectedRows = (row: PinnedProfileDiscoveryWrite) => row.expectedEvidencePins as Awaited<ReturnType<typeof pins>>;
    await check("exact complete expectations retain server-derived pins without publishing or activating", async () => {
      const row = await pinned([await evidence(), await evidence()]), before = await counts();
      const saved = await store.recordPinnedDiscovery({ ...row, expectedEvidencePins: expectedRows(row).slice().reverse() });
      assert.equal(saved.replayed, false); assert.deepEqual(saved.proposal.evidencePins, row.expectedEvidencePins);
      assert.equal(saved.proposal.state, "needs_input"); assert.equal(saved.proposal.authority.activation, "not_authorized");
      const after = await counts(); assert.equal(after.proposals, before.proposals + 1); assert.equal(after.pins, before.pins + 2);
      for (const key of ["profiles", "grants", "runs", "effects", "missions"]) assert.equal(after[key], before[key]);
      assert.deepEqual(await getProjectProfileProposal(pool, { projectId, proposalId: row.proposalId }), saved.proposal);
    });
    await check("empty discovery remains all missing and exact pin set failures leave no rows", async () => {
      const empty = await pinned([]); assert.equal((await store.recordPinnedDiscovery(empty)).proposal.state, "needs_input");
      const row = await pinned([await evidence()]), expected = expectedRows(row);
      for (const invalid of [[], [...expected, ...expected], [{ ...expected[0], projectId: createStableId("project") }],
        [{ ...expected[0], identityDigest: canonicalJsonDigest({ changed: true }) }]]) {
        await assert.rejects(store.recordPinnedDiscovery({ ...row, expectedEvidencePins: invalid })); await absent(row.proposalId);
      }
    });
    await check("new pinned writes reject stale, inaccessible, unhashed, restricted and future evidence", async () => {
      for (const override of [{ freshness: "stale" }, { accessibility: "inaccessible" }, { content_hash: null },
        { sensitivity: "restricted" }, { retrieved_at: "2099-01-01T00:00:00Z" }]) {
        const row = await pinned([await evidence(override)]);
        await assert.rejects(store.recordPinnedDiscovery(row), /expected evidence/u); await absent(row.proposalId);
        if (!("sensitivity" in override) && !("retrieved_at" in override)) {
          const { expectedEvidencePins: _pins, ...ordinary } = row;
          assert.equal((await store.recordDiscovery(ordinary)).replayed, false, "ordinary drafts retain their looser discovery semantics");
        }
      }
    });
    await check("identity drift and non-fingerprint freshness or disclosure drift before locking reject", async () => {
      for (const change of ["content_hash='sha256:changed'", "freshness='stale'", "sensitivity='restricted'"]) {
        const id = await evidence(), row = await pinned([id]); let injected = false;
        const intercepted = { options: pool.options, query: pool.query.bind(pool), async connect() {
          const client = await pool.connect(); return { on: client.on.bind(client), off: client.off.bind(client),
            async query(sql: string, values?: unknown[]) {
              if (sql.includes("FOR SHARE OF e") && !injected) { injected = true; await pool.query(`UPDATE acp.evidence_records SET ${change} WHERE evidence_id=$1`, [id]); }
              return client.query(sql, values);
            }, release(discard?: Error | boolean) { client.release(discard); } };
        } } as unknown as Pool;
        await assert.rejects(new PostgresProfileProposalStore(intercepted, producer).recordPinnedDiscovery(row), /expected evidence/u);
        assert.equal(injected, true); await absent(row.proposalId);
      }
    });
    await check("held evidence lock excludes a concurrent mutation until commit without extending freshness afterward", async () => {
      const id = await evidence(), row = await pinned([id]); let excluded = false;
      const intercepted = { options: pool.options, query: pool.query.bind(pool), async connect() {
        const client = await pool.connect(); return { on: client.on.bind(client), off: client.off.bind(client), async query(sql: string, values?: unknown[]) {
          const result = await client.query(sql, values);
          if (sql.includes("FOR SHARE OF e")) {
            const updater = await pool.connect();
            try { await updater.query("SET lock_timeout='100ms'");
              await assert.rejects(updater.query("UPDATE acp.evidence_records SET freshness='stale' WHERE evidence_id=$1", [id]), /lock timeout/u); excluded = true;
            } finally { updater.release(true); }
          }
          return result;
        }, release(discard?: Error | boolean) { client.release(discard); } };
      } } as unknown as Pool;
      const saved = await new PostgresProfileProposalStore(intercepted, producer).recordPinnedDiscovery(row);
      assert.equal(excluded, true); assert.deepEqual(saved.proposal.evidencePins, row.expectedEvidencePins);
      await pool.query("UPDATE acp.evidence_records SET freshness='stale' WHERE evidence_id=$1", [id]);
      assert.deepEqual(await store.recordPinnedDiscovery(row), { proposal: saved.proposal, replayed: true });
    });
    await check("returned pin mismatch is checked before COMMIT and rolls back actual parent and pin rows", async () => {
      const row = await pinned([await evidence()]), seen: string[] = [];
      const intercepted = { options: pool.options, query: pool.query.bind(pool), async connect() {
        const client = await pool.connect(); return { on: client.on.bind(client), off: client.off.bind(client), async query(sql: string, values?: unknown[]) {
          seen.push(sql); const result = await client.query(sql, values);
          if (sql.startsWith("INSERT")) {
            const body = JSON.parse(result.rows[0].body); body.evidencePins[0].identityDigest = canonicalJsonDigest({ wrong: true });
            return { ...result, rows: [{ body: JSON.stringify(body) }] };
          }
          return result;
        }, release(discard?: Error | boolean) { client.release(discard); } };
      } } as unknown as Pool;
      await assert.rejects(new PostgresProfileProposalStore(intercepted, producer).recordPinnedDiscovery(row), /expected evidence/u);
      assert.equal(seen.includes("COMMIT"), false); assert.equal(seen.at(-1), "ROLLBACK"); await absent(row.proposalId);
    });
    await check("historical original pins replay after identity and restriction drift while replacement pins reject", async () => {
      const id = await evidence(), row = await pinned([id]), saved = await store.recordPinnedDiscovery(row);
      await pool.query("UPDATE acp.evidence_records SET content_hash='sha256:changed',sensitivity='restricted' WHERE evidence_id=$1", [id]);
      assert.deepEqual(await store.recordPinnedDiscovery(row), { proposal: saved.proposal, replayed: true });
      await assert.rejects(store.recordPinnedDiscovery({ ...row, expectedEvidencePins: await pins([id]) }), /expected evidence/u);
      await assert.rejects(getProjectProfileProposal(pool, { projectId, proposalId: row.proposalId }), /unavailable/u);
    });
    for (const replay of [false, true]) await check(`lost COMMIT on pinned ${replay ? "historical replay" : "new admission"} discards the backend and recovers original pins`, async () => {
      const row = await pinned([await evidence()]); if (replay) await store.recordPinnedDiscovery(row);
      let pid = 0, discarded = false;
      const intercepted = { options: pool.options, async query(sql: string, values?: unknown[]) { assert.equal(discarded, true); return pool.query(sql, values); }, async connect() {
        const client = await pool.connect(); pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        return { on: client.on.bind(client), off: client.off.bind(client), async query(sql: string, values?: unknown[]) {
          const result = await client.query(sql, values); if (sql === "COMMIT") throw new Error("synthetic pinned lost COMMIT"); return result;
        }, release(discard?: Error | boolean) { assert.equal(discard, true); client.release(discard); discarded = true; } };
      } } as unknown as Pool;
      const saved = await new PostgresProfileProposalStore(intercepted, producer).recordPinnedDiscovery(row);
      assert.equal(saved.replayed, true); assert.deepEqual(saved.proposal.evidencePins, row.expectedEvidencePins);
      const until = Date.now() + 2000; let remains = true;
      while (Date.now() < until) { remains = (await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1) AS remains", [pid])).rows[0].remains;
        if (!remains) break; await new Promise(resolve => setTimeout(resolve, 10)); }
      assert.equal(remains, false);
    });
    await check("lost COMMIT readback cannot substitute different retained pins", async () => {
      const row = await pinned([await evidence()]);
      const intercepted = { options: pool.options, async query(sql: string, values?: unknown[]) {
        const result = await pool.query(sql, values), body = JSON.parse(result.rows[0].body);
        body.evidencePins[0].identityDigest = canonicalJsonDigest({ wrongRecovery: true }); return { ...result, rows: [{ body: JSON.stringify(body) }] };
      }, async connect() {
        const client = await pool.connect(); return { on: client.on.bind(client), off: client.off.bind(client), async query(sql: string, values?: unknown[]) {
          const result = await client.query(sql, values); if (sql === "COMMIT") throw new Error("synthetic pinned lost COMMIT"); return result;
        }, release(discard?: Error | boolean) { client.release(discard); } };
      } } as unknown as Pool;
      await assert.rejects(new PostgresProfileProposalStore(intercepted, producer).recordPinnedDiscovery(row), /expected evidence/u);
      assert.deepEqual((await store.recordPinnedDiscovery(row)).proposal.evidencePins, row.expectedEvidencePins);
    });
  }
  if (phase === "discovery") {
    await check("empty attributed discovery persists every unanswered field without inventing completeness", async () => {
      const { fields: _selected, ...identity } = terms(), before = await counts();
      const saved = await store.recordDiscovery({ ...identity, observations: [] });
      assert.equal(saved.replayed, false); assert.equal(saved.proposal.state, "needs_input");
      assert.equal(Object.keys(saved.proposal.fields).length, 62);
      for (const field of Object.values(saved.proposal.fields)) assert.equal(field.status, "missing");
      const after = await counts(); assert.equal(after.proposals, before.proposals + 1);
      for (const key of ["profiles", "grants", "runs", "effects", "missions", "pins"]) assert.equal(after[key], before[key]);
    });
    const firstEvidence = await evidence(), secondEvidence = await evidence();
    const { fields: _selected, ...identity } = terms();
    const observations = [
      { fieldId: "context.product", value: { name: "Synthetic", scale: 0.1 }, evidenceIds: [firstEvidence] },
      { fieldId: "context.product", value: { scale: 0.1, name: "Synthetic" }, evidenceIds: [secondEvidence] },
      { fieldId: "repositories.defaultBranches", value: "Main", evidenceIds: [firstEvidence] },
      { fieldId: "repositories.defaultBranches", value: "main", evidenceIds: [secondEvidence] },
    ];
    const saved = await store.recordDiscovery({ ...identity, observations });
    const selectedQuery = { projectId, proposalId: identity.proposalId };
    await check("attributed discovery retains merged evidence, conflicts, gaps and server-derived fingerprints", async () => {
      assert.equal(saved.proposal.state, "conflicted");
      assert.deepEqual(saved.proposal.fields["context.product"], { status: "observed", value: { name: "Synthetic", scale: 0.1 }, evidenceIds: [firstEvidence, secondEvidence].sort() });
      const conflict = saved.proposal.fields["repositories.defaultBranches"]; assert.equal(conflict.status, "conflicted");
      if (conflict.status === "conflicted") assert.deepEqual(conflict.alternatives.map(item => item.value).sort(), ["Main", "main"]);
      assert.equal(saved.proposal.fields["repositories.protections"].status, "missing");
      assert.deepEqual(await getProjectProfileProposal(pool, selectedQuery), saved.proposal);
      for (const pin of saved.proposal.evidencePins) assert.equal(pin.identityDigest, (await pool.query("SELECT acp.readiness_evidence_fingerprint(e) AS digest FROM acp.evidence_records e WHERE evidence_id=$1", [pin.evidenceId])).rows[0].digest);
      await assert.rejects(getProfileConfirmationRequest(pool, selectedQuery), /unavailable/u);
    });
    await check("reordered and repeated observations replay the exact reduction while changed content or evidence rejects", async () => {
      const before = await counts();
      assert.deepEqual(await store.recordDiscovery({ ...identity, observations: [...observations.slice().reverse(), observations[0]] }), { proposal: saved.proposal, replayed: true });
      assert.deepEqual(await store.record({ ...identity, fields: saved.proposal.fields }), { proposal: saved.proposal, replayed: true });
      await assert.rejects(store.recordDiscovery({ ...identity, observations: observations.slice(1) }), /different terms/u);
      await assert.rejects(store.recordDiscovery({ ...identity, observations: [{ ...observations[0], value: "Changed" }, ...observations.slice(1)] }), /different terms/u);
      assert.deepEqual(await counts(), before);
    });
    await check("a corrected successor does not rewrite conflicts or fill unrelated gaps", async () => {
      const successor = { ...identity, proposalId: createStableId("projectProfileProposal"), supersedesProposalId: identity.proposalId };
      const next = await store.recordDiscovery({ ...successor, observations: observations.slice(0, 3) });
      assert.equal(next.proposal.state, "needs_input"); assert.equal(next.proposal.fields["repositories.defaultBranches"].status, "observed");
      assert.equal(next.proposal.fields["repositories.protections"].status, "missing");
      assert.deepEqual(await getProjectProfileProposal(pool, selectedQuery), saved.proposal);
      await assert.rejects(store.recordDiscovery({ ...identity, proposalId: createStableId("projectProfileProposal"), supersedesProposalId: identity.proposalId, observations }), /exact latest/u);
    });
    await check("restricted or missing evidence rejects fresh discovery without retaining a partial proposal", async () => {
      const restricted = await evidence({ sensitivity: "restricted" }), before = await counts();
      for (const evidenceId of [restricted, createStableId("evidence")]) {
        const { fields: _ignored, ...fresh } = terms();
        await assert.rejects(store.recordDiscovery({ ...fresh, observations: [{ fieldId: "context.product", value: "Synthetic", evidenceIds: [evidenceId] }] }));
        await absent(fresh.proposalId);
      }
      assert.deepEqual(await counts(), before);
    });
    await check("private replay after evidence restriction preserves history but never bypasses public disclosure", async () => {
      await pool.query("UPDATE acp.evidence_records SET sensitivity='restricted' WHERE evidence_id=$1", [firstEvidence]);
      assert.deepEqual(await store.recordDiscovery({ ...identity, observations }), { proposal: saved.proposal, replayed: true });
      await assert.rejects(getProjectProfileProposal(pool, selectedQuery), /unavailable/u);
      await assert.rejects(getProfileConfirmationRequest(pool, selectedQuery), /unavailable/u);
    });
  }
  if (phase === "core") {
    await check("SQL and domain checklist catalogs agree exactly", async () => {
      assert.deepEqual((await pool.query("SELECT acp.profile_proposal_field_ids() AS ids")).rows[0].ids, profileFieldIds);
    });
    await check("first-profile draft needs no runtime provenance and cannot confirm or activate", async () => {
      const row = terms(), before = await counts(), saved = await store.record(row);
      assert.equal(saved.replayed, false); assert.equal(saved.proposal.state, "needs_input");
      assert.equal(Object.keys(saved.proposal.fields).length, 62); assert.equal(saved.proposal.authority.activation, "not_authorized");
      assert.deepEqual(await getProjectProfileProposal(pool, query(row)), saved.proposal);
      await assert.rejects(getProfileConfirmationRequest(pool, query(row)), /unavailable/u);
      const after = await counts(); for (const key of ["profiles", "grants", "runs", "effects", "missions"]) assert.equal(after[key], before[key]);
      assert.equal(after.proposals, before.proposals + 1); assert.equal(after.pins, before.pins);
    });
    await check("reviewable document pins server evidence and produces only an exact confirmation request", async () => {
      const evd = await evidence(), row = terms({ fields: { ...resolvedFields(), "context.product": observed(evd) } });
      const saved = await store.record(row), request = await getProfileConfirmationRequest(pool, query(row)); assert.ok(request);
      assert.equal(request.kind, "confirmation_request_only"); assert.equal(request.activation, "not_authorized");
      assert.equal(request.proposalDigest, saved.proposal.proposalDigest); assert.equal(request.evidence.length, 1);
      assert.equal(request.proposal.evidencePins[0]?.identityDigest, (await pool.query("SELECT acp.readiness_evidence_fingerprint(e) AS digest FROM acp.evidence_records e WHERE evidence_id=$1", [evd])).rows[0].digest);
      const encoded = JSON.stringify(request); for (const field of ["sourceRef", "rawContentRef", "redactedSummary", "operatorId", "confirmedAt"]) assert.equal(encoded.includes(`"${field}"`), false);
    });
    await check("immutable retries retain original fields, timestamps and pins after supersession", async () => {
      const first = terms(), saved = await store.record(first);
      const next = { ...first, proposalId: createStableId("projectProfileProposal"), supersedesProposalId: first.proposalId, fields: resolvedFields() };
      await store.record(next);
      assert.deepEqual(await store.record(first), { proposal: saved.proposal, replayed: true });
      assert.deepEqual(await store.record({ ...first, fields: saved.proposal.fields }), { proposal: saved.proposal, replayed: true });
      await assert.rejects(store.record({ ...first, fields: resolvedFields() }), /different terms/u);
      await assert.rejects(new PostgresProfileProposalStore(pool, { ...producer, version: "2.0.0" }).record(first), /different terms/u);
      await assert.rejects(store.record({ ...next, proposalId: createStableId("projectProfileProposal"), supersedesProposalId: first.proposalId }), /exact latest/u);
    });
    await check("Unicode and exponent fact JSON retain the JS digest independently of the PG checksum", async () => {
      const row = terms({ fields: { "context.product": { status: "proposed", value: { "界": 1e-7, "ž": 0.000000000001, "a": -0,
        numbers: [Number.MIN_VALUE,Number.MAX_SAFE_INTEGER,0.1,1.0000000000000002,2.2250738585072014e-308] }, rationale: "Synthetic JSON.", evidenceIds: [] } } });
      const saved = await store.record(row); assert.deepEqual(await getProjectProfileProposal(pool, query(row)), saved.proposal);
      const stored = (await pool.query("SELECT storage_digest,acp.jsonb_sha256(body) AS computed FROM acp.project_profile_proposals WHERE proposal_id=$1", [row.proposalId])).rows[0];
      assert.equal(stored.storage_digest, stored.computed); assert.notEqual(stored.storage_digest, saved.proposal.proposalDigest);
    });
    await check("baseline uses exact PG content, including integers that JavaScript would round", async () => {
      const profileId = createStableId("projectProfile");
      await pool.query(`INSERT INTO acp.project_profiles(profile_id,version,project_id,profile,published_at)
        VALUES($1,'1.0.0',$2,'{"exact":9007199254740993}',clock_timestamp()),($1,'1.1.0',$2,'{"different":true}',clock_timestamp())`, [profileId,projectId]);
      const digest = (await pool.query("SELECT acp.jsonb_sha256(profile) AS digest FROM acp.project_profiles WHERE profile_id=$1 AND version='1.0.0'", [profileId])).rows[0].digest;
      const row = terms({ candidateProfile: { profileId, profileVersion: "2.0.0" }, baseProfile: { profileId, profileVersion: "1.0.0", profileDigest: digest }, fields: resolvedFields() });
      await assert.rejects(store.record({ ...row, baseProfile: { ...row.baseProfile!, profileDigest: canonicalJsonDigest({ exact: 9007199254740992 }) } }), /baseline/u);
      await store.record(row); assert.ok(await getProfileConfirmationRequest(pool, query(row)));
      // The independently published 1.1.0 is not inferred to be a current head.
    });
    await check("published candidate prevents new admission and confirmation, not historical replay", async () => {
      const row = terms({ fields: resolvedFields() }), saved = await store.record(row); await publish(row);
      assert.deepEqual(await store.record(row), { proposal: saved.proposal, replayed: true });
      await assert.rejects(getProfileConfirmationRequest(pool, query(row)), /unavailable/u);
      await assert.rejects(store.record({ ...row, proposalId: createStableId("projectProfileProposal"), supersedesProposalId: row.proposalId }), /already exists/u);
    });
    await check("proposal and pin history prohibit update, delete and truncate", async () => {
      for (const table of ["project_profile_proposals", "project_profile_proposal_evidence"]) for (const action of ["UPDATE", "DELETE", "TRUNCATE"]) {
        const sql = action === "UPDATE" ? `UPDATE acp.${table} SET proposal_id=proposal_id WHERE false` : action === "DELETE" ? `DELETE FROM acp.${table} WHERE false` : `TRUNCATE acp.${table} CASCADE`;
        await assert.rejects(pool.query(sql));
      }
    });
    await check("absent and cross-project IDs never select an alternate or latest document", async () => {
      const row = terms(); await store.record(row);
      assert.equal(await getProjectProfileProposal(pool, { projectId: createStableId("project"), proposalId: row.proposalId }), undefined);
      assert.equal(await getProjectProfileProposal(pool, { projectId, proposalId: createStableId("projectProfileProposal") }), undefined);
    });
  }
  if (phase === "races") {
    for (const phase of ["insert", "commit"] as const) await check(`real checked-out socket loss after ${phase} is contained and reconciled`, async () => {
      const row = terms(); let pid: number | undefined;
      const intercepted = { options: pool.options, query: pool.query.bind(pool), async connect() {
        const client = await pool.connect(); pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
        return { on: client.on.bind(client), off: client.off.bind(client), async query<R extends QueryResultRow>(sql: string, values?: unknown[]): Promise<QueryResult<R>> {
          const result = await client.query<R>(sql,values);
          if ((phase === "insert" && sql.startsWith("INSERT")) || (phase === "commit" && sql === "COMMIT")) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const observedError = new Promise<void>((resolve,reject) => {
              timer = setTimeout(() => reject(new Error("fixture socket error deadline")),1500);
              client.once("error",() => { clearTimeout(timer); resolve(); });
            });
            try { await pool.query("SELECT pg_terminate_backend($1)",[pid]); await observedError; }
            finally { clearTimeout(timer); }
          }
          return result;
        }, release(discard?: Error | boolean) { client.release(discard); } };
      } } as unknown as Pool;
      if (phase === "insert") { await assert.rejects(new PostgresProfileProposalStore(intercepted,producer).record(row)); await absent(row.proposalId); }
      else assert.equal((await new PostgresProfileProposalStore(intercepted,producer).record(row)).replayed,true);
      assert.equal((await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1) AS remains",[pid])).rows[0].remains,false);
      assert.equal((await store.record(row)).replayed,phase === "commit");
    });
    await check("concurrent same-ID retry converges to one exact record", async () => {
      const row = terms(), results = await Promise.all([store.record(row),store.record(row)]);
      assert.equal(results.filter(result => !result.replayed).length, 1); assert.deepEqual(results[0]?.proposal, results[1]?.proposal);
    });
    await check("competing roots and corrections cannot fork one candidate chain", async () => {
      const row = terms(), roots = await Promise.allSettled([store.record(row),store.record({ ...row, proposalId: createStableId("projectProfileProposal") })]);
      assert.equal(roots.filter(result => result.status === "fulfilled").length, 1);
      const winner = roots.find(result => result.status === "fulfilled"); assert.ok(winner?.status === "fulfilled");
      const next = { ...row, proposalId: createStableId("projectProfileProposal"), supersedesProposalId: winner.value.proposal.proposalId };
      const successors = await Promise.allSettled([store.record(next),store.record({ ...next, proposalId: createStableId("projectProfileProposal") })]);
      assert.equal(successors.filter(result => result.status === "fulfilled").length, 1);
    });
    await check("repeatable-read stale snapshots cannot bypass single-root uniqueness", async () => {
      const row = terms(), client = await pool.connect();
      try { await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ"); await client.query("SELECT count(*) FROM acp.project_profile_proposals");
        await store.record(row); await assert.rejects(insertDirect(client, { ...row, proposalId: createStableId("projectProfileProposal") }));
      } finally { await client.query("ROLLBACK"); client.release(true); }
    });
    for (const replay of [false,true]) await check(`lost real COMMIT on ${replay ? "historical replay" : "insertion"} closes backend before exact readback`, async () => {
      const row = terms(); if (replay) await store.record(row);
      const pids: number[] = [], releases: unknown[] = [];
      const intercepted = { options: pool.options, query: pool.query.bind(pool), async connect() {
        const client = await pool.connect(); pids.push((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number);
        return { async query<R extends QueryResultRow>(sql: string, values?: unknown[]): Promise<QueryResult<R>> {
          const result = await client.query<R>(sql,values); if (sql === "COMMIT") throw new Error("synthetic lost profile COMMIT"); return result;
        }, release(discard?: Error | boolean) { releases.push(discard); client.release(discard); } };
      } } as unknown as Pool;
      assert.equal((await new PostgresProfileProposalStore(intercepted,producer).record(row)).replayed, true); assert.deepEqual(releases,[true]);
      const until = Date.now()+2000; let remaining = true;
      while (Date.now()<until) { remaining = (await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=ANY($1::integer[])) AS remains",[pids])).rows[0].remains as boolean;
        if (!remaining) break; await new Promise(resolve => setTimeout(resolve,10)); }
      assert.equal(remaining,false);
    });
    await check("failed independent readback is uncertainty, while later explicit retry retains the original", async () => {
      const row = terms();
      const intercepted = { options: pool.options, async query() { throw new Error("synthetic failed readback"); }, async connect() {
        const client = await pool.connect(); return { async query(sql: string, values?: unknown[]) {
          const result = await client.query(sql,values); if (sql === "COMMIT") throw new Error("synthetic uncertain COMMIT"); return result;
        }, release(discard?: Error | boolean) { client.release(discard); } };
      } } as unknown as Pool;
      await assert.rejects(new PostgresProfileProposalStore(intercepted,producer).record(row), /uncertain COMMIT/u);
      assert.equal((await store.record(row)).replayed,true);
    });
  }
  if (phase === "references") {
    await check("near-limit quote-heavy valid proposals are not rejected by double transport escaping", async () => {
      const row = terms(), ids: string[] = []; for (let index=0; index<80; index++) ids.push(await evidence());
      const pins = (await pool.query("SELECT jsonb_agg(jsonb_build_object('evidenceId',e.evidence_id,'projectId',e.project_id,'identityDigest',acp.readiness_evidence_fingerprint(e))) AS pins FROM acp.evidence_records e WHERE evidence_id=ANY($1::text[])",[ids])).rows[0].pins;
      let fields: Record<string,unknown> | undefined;
      for (let units=950; units<=1000; units++) {
        const candidate = Object.fromEntries(profileFieldIds.map(id => [id,{ status: "not_applicable",rationale: '"\\'.repeat(units),evidenceIds: [] }])) as Record<string,unknown>;
        for (const [index,id] of ["identity.project","identity.client","identity.stakeholders","identity.environments"].entries()) {
          candidate[id] = { status: "observed",value: '"\\'.repeat(950),evidenceIds: ids.slice(index*20,index*20+20) };
        }
        const { fields: _fields, ...identity } = row;
        try { buildProjectProfileProposal({ ...identity,producer,proposedAt: "2026-09-06T00:00:00Z" },candidate,pins); fields=candidate; }
        catch { break; }
      }
      assert.ok(fields); const saved = await store.record({ ...row,fields });
      assert.ok(Buffer.byteLength(JSON.stringify(saved.proposal),"utf8")>260000);
      assert.deepEqual(await getProjectProfileProposal(pool,query(row)),saved.proposal);
      const request = await getProfileConfirmationRequest(pool,query(row)); assert.ok(request);
      const { proposalDigest: _digest, ...body } = saved.proposal;
      assert.ok(Buffer.byteLength(JSON.stringify({ body: JSON.stringify(body),evidence: request.evidence }),"utf8")>524288,"old double-encoded wrapper must really exceed its bound");
      assert.ok(Buffer.byteLength(JSON.stringify(request),"utf8")<=524288);
    });
    await check("direct high-precision decimals and underflow cannot alias the visible proposal digest", async () => {
      for (const numeric of ["0.1000000000000000000001", "1e-400"]) {
        const row = terms({ fields: { ...resolvedFields(), "context.product": { status: "proposed", value: 0.1, rationale: "Synthetic exact numeric fixture.", evidenceIds: [] } } });
        const exactNumeric = { async query(sql: string, values?: unknown[]) { return pool.query(sql,[(values![0] as string).replace('"value":0.1',`"value":${numeric}`)]); } };
        await insertDirect(exactNumeric,row);
        await assert.rejects(getProjectProfileProposal(pool,query(row)), /unavailable/u);
        await assert.rejects(getProfileConfirmationRequest(pool,query(row)), /unavailable/u);
      }
    });
    await check("missing, restricted, cross-project and future evidence reject first insertion", async () => {
      const otherProject = createStableId("project"); await clone("projects","project_id",projectId,{ project_id: otherProject });
      for (const evd of [createStableId("evidence"),await evidence({ sensitivity: "restricted" }),await evidence({ project_id: otherProject }),await evidence({ retrieved_at: "2099-01-01T00:00:00Z" })]) {
        const row = terms({ fields: { "context.product": observed(evd) } }); await assert.rejects(store.record(row)); await absent(row.proposalId);
      }
    });
    await check("current restriction denies the entire public payload but not private exact retry", async () => {
      const evd = await evidence(), row = terms({ fields: { ...resolvedFields(), "context.product": observed(evd) } }), saved = await store.record(row);
      await pool.query("UPDATE acp.evidence_records SET sensitivity='restricted' WHERE evidence_id=$1",[evd]);
      await assert.rejects(getProjectProfileProposal(pool,query(row)), /no partial snapshot/u);
      await assert.rejects(getProfileConfirmationRequest(pool,query(row)), /no partial request/u);
      const raw = (await pool.query(projectProfileProposalSql,[projectId,row.proposalId,524288])).rows[0];
      assert.equal(raw.snapshot,null); assert.equal(raw.proposal_error,"invalid_references");
      assert.deepEqual(await store.record(row), { proposal: saved.proposal, replayed: true });
    });
    await check("source identity drift and unusable metadata each prevent confirmation without rewriting history", async () => {
      for (const change of ["content_hash='sha256:changed'","freshness='stale'","accessibility='inaccessible'","content_hash=NULL"]) {
        const evd = await evidence(), row = terms({ fields: { ...resolvedFields(), "context.product": observed(evd) } }), saved = await store.record(row);
        await pool.query(`UPDATE acp.evidence_records SET ${change} WHERE evidence_id=$1`,[evd]);
        assert.deepEqual(await getProjectProfileProposal(pool,query(row)),saved.proposal);
        await assert.rejects(getProfileConfirmationRequest(pool,query(row)), /unavailable/u);
      }
    });
    await check("same-transaction evidence drift rolls back proposal and pins at default deferred commit", async () => {
      for (const change of ["content_hash='sha256:changed'","sensitivity='restricted'"]) {
        const evd = await evidence(), row = terms({ fields: { "context.product": observed(evd) } }), client = await pool.connect();
        try { await client.query("BEGIN"); await insertDirect(client,row); await client.query(`UPDATE acp.evidence_records SET ${change} WHERE evidence_id=$1`,[evd]);
          await assert.rejects(client.query("COMMIT"), /changed before commit/u);
        } finally { client.release(true); }
        await absent(row.proposalId);
      }
    });
    await check("privileged early constraint forcing cannot hide later drift from confirmation", async () => {
      const evd = await evidence(), row = terms({ fields: { ...resolvedFields(), "context.product": observed(evd) } }), client = await pool.connect();
      try { await client.query("BEGIN"); await insertDirect(client,row); await client.query("SET CONSTRAINTS acp.project_profile_proposals_commit IMMEDIATE");
        await client.query("UPDATE acp.evidence_records SET content_hash='sha256:after-early-check' WHERE evidence_id=$1",[evd]); await client.query("COMMIT");
      } finally { client.release(true); }
      await assert.rejects(getProfileConfirmationRequest(pool,query(row)), /unavailable/u);
    });
    await check("server-owned metadata and exact pin set reject direct injection", async () => {
      for (const extra of [{ proposed_at: "2026-01-01T00:00:00Z" },{ body: {} },{ evidence_pins: [] },{ storage_digest: canonicalJsonDigest({ fake: true }) }]) {
        const row = terms(); await assert.rejects(insertDirect(pool,row,extra), /server owned/u); await absent(row.proposalId);
      }
      const row = terms(); await store.record(row);
      await assert.rejects(pool.query("INSERT INTO acp.project_profile_proposal_evidence(proposal_id,evidence_id,ordinal,identity_digest) VALUES($1,$2,1,$3)", [row.proposalId,await evidence(),canonicalJsonDigest({ fake: true })]), /exact server-owned/u);
    });
    await check("malformed direct fact JSON never becomes a public proposal or confirmation", async () => {
      const row = terms(), fields = { ...resolvedFields(), "context.product": { status: "proposed", value: { unsafe: 1e20 }, rationale: "Synthetic unsafe value.", evidenceIds: [] } };
      await insertDirect(pool,row,{ fields });
      await assert.rejects(getProjectProfileProposal(pool,query(row)), /unavailable/u);
      await assert.rejects(getProfileConfirmationRequest(pool,query(row)), /unavailable/u);
    });
    await check("whole canonical UTF-8 bound rolls back before any invalid candidate can commit", async () => {
      const row = terms({ fields: Object.fromEntries(profileFieldIds.map(id => [id,{ status: "missing", reason: "界".repeat(2000), question: "界".repeat(2000) }])) });
      await assert.rejects(store.record(row)); await absent(row.proposalId);
      const valid = terms(); await store.record(valid);
      const raw = (await pool.query(projectProfileProposalSql,[projectId,valid.proposalId,100])).rows[0]; assert.equal(raw.proposal_error,"too_large"); assert.equal(raw.snapshot,null);
    });
    await check("server pin expansion beyond canonical body limit rolls back after INSERT before COMMIT", async () => {
      const fields: Record<string,unknown> = Object.fromEntries(profileFieldIds.map(id => [id,{ status: "missing",reason: "x".repeat(2000),question: "y".repeat(2000) }]));
      for (const id of ["identity.project","identity.client","identity.stakeholders","identity.environments","context.product"]) {
        const ids: string[] = []; for (let index = 0; index < 20; index++) ids.push(await evidence());
        fields[id] = { status: "observed",value: "z".repeat(3800),evidenceIds: ids };
      }
      assert.ok(Buffer.byteLength(JSON.stringify(prepareProfileProposalFields(fields).fields),"utf8") < 262144);
      const row = terms({ fields }); await assert.rejects(store.record(row), /profile proposal/u); await absent(row.proposalId);
    });
  }
  if (phase === "snapshot") {
    await check("SELECT-only database role can read proposals and requests without creating authority", async () => {
      const row = terms({ fields: resolvedFields() }); await store.record(row);
      await pool.query("CREATE ROLE acp_profile_proposal_reader LOGIN PASSWORD 'acp_test_reader_password'; GRANT USAGE ON SCHEMA acp TO acp_profile_proposal_reader; GRANT SELECT ON ALL TABLES IN SCHEMA acp TO acp_profile_proposal_reader; ALTER ROLE acp_profile_proposal_reader SET default_transaction_read_only=on");
      const reader = new Pool({ connectionString: `postgresql://acp_profile_proposal_reader:acp_test_reader_password@127.0.0.1:${port}/acp_test`,max: 1,
        connectionTimeoutMillis: 3000,statement_timeout: 5000,lock_timeout: 3000 });
      try {
        const before = await counts(); assert.ok(await getProjectProfileProposal(reader,query(row))); assert.ok(await getProfileConfirmationRequest(reader,query(row)));
        await assert.rejects(reader.query("CREATE TABLE acp.synthetic_forbidden_profile_write(id integer)")); assert.deepEqual(await counts(),before);
      } finally { await reader.end(); }
    });
    for (const mutation of ["successor","evidence","publication"] as const) await check(`one MVCC request is coherent across concurrent ${mutation}`, async () => {
      const evd = await evidence(), row = terms({ fields: { ...resolvedFields(), "context.product": observed(evd) } }); await store.record(row);
      const gate = Math.floor(Math.random()*1_000_000_000)+1_000_000_000, holder = await pool.connect();
      let pending: ReturnType<typeof getProfileConfirmationRequest> | undefined;
      try {
        await holder.query("SELECT pg_advisory_lock($1::bigint)",[gate]);
        const intercepted = { async query<R extends QueryResultRow>(sql: string, values?: unknown[]): Promise<QueryResult<R>> {
          const blocked = sql.replace("WITH\n","WITH fixture_gate AS MATERIALIZED(SELECT pg_advisory_xact_lock($4::bigint)),\n")
            .replace("FROM acp.project_profile_proposals WHERE project_id=$1","FROM acp.project_profile_proposals CROSS JOIN fixture_gate WHERE project_id=$1");
          return pool.query<R>(blocked,[...values!,gate]);
        } };
        pending = getProfileConfirmationRequest(intercepted,query(row)); void pending.catch(() => {});
        const until = Date.now()+1500; let waiting = false;
        while(Date.now()<until) { waiting = (await pool.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=$1 AND NOT granted) AS waiting",[gate])).rows[0].waiting as boolean;
          if(waiting) break; await new Promise(resolve => setTimeout(resolve,10)); }
        assert.equal(waiting,true);
        if(mutation === "successor") await store.record({ ...row, proposalId: createStableId("projectProfileProposal"), supersedesProposalId: row.proposalId });
        else if(mutation === "evidence") await pool.query("UPDATE acp.evidence_records SET sensitivity='restricted' WHERE evidence_id=$1",[evd]);
        else await publish(row);
        await holder.query("SELECT pg_advisory_unlock($1::bigint)",[gate]);
        const request = await pending; assert.ok(request); assert.equal(request.proposalId,row.proposalId); assert.equal(request.activation,"not_authorized");
        await assert.rejects(getProfileConfirmationRequest(pool,query(row)), /unavailable/u);
      } finally { holder.release(true); if(pending) await Promise.allSettled([pending]); }
    });
  }
  if (phase === "upgrade") {
    await check("empty downgrade and re-upgrade preserve all predecessor rows", async () => {
      const before = await counts(); await migration("down");
      assert.equal((await pool.query("SELECT to_regclass('acp.project_profile_proposals') IS NULL AS absent")).rows[0].absent,true);
      await migration("up"); assert.deepEqual(await counts(),before);
    });
    await check("nonempty downgrade refuses to erase retained proposal history", async () => {
      const row = terms({ fields: { "context.product": observed(await evidence()) } }), saved = await store.record(row), before = await counts();
      await assert.rejects(migration("down"), /retained profile proposal history/u);
      assert.deepEqual(await counts(),before); assert.deepEqual(await getProjectProfileProposal(pool,query(row)),saved.proposal);
    });
  }
  if (checks === 0) throw new Error("requested profile proposal phase has no checks");
  process.stdout.write(`Profile proposal integration: ${checks} checks passed.\n`);
} finally { await pool.end(); }
