import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { canonicalJsonDigest, createStableId, type StableId, type ProfileProposalIdentity } from "@acp/domain";
import { getProjectProfileProposal, getProfileConfirmationRequest, PostgresProfileProposalStore } from "@acp/storage";
import { discoverNpmPackageManifest } from "../../src/npm-package-manifest-discovery.ts";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("owned PostgreSQL port required");
const pool = new Pool({ connectionString: `postgresql://postgres:acp_test_password@127.0.0.1:${port}/acp_test`, max: 4,
  connectionTimeoutMillis: 3000, statement_timeout: 5000, lock_timeout: 2000 });
const legacy = (prefix: string) => `${prefix}_00000000-0000-4000-8000-000000000001`;
const projectId = legacy("prj") as StableId<"project">;
const hash = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const writer = new PostgresProfileProposalStore(pool, { component: "synthetic-manifest-discovery", version: "1",
  artifactDigest: canonicalJsonDigest({ fixture: "npm-manifest" }) });
const identity = (): ProfileProposalIdentity => ({ proposalId: createStableId("projectProfileProposal"), projectId,
  candidateProfile: { profileId: createStableId("projectProfile"), profileVersion: "1.0.0" }, baseProfile: null, supersedesProposalId: null });
const query = (row: ProfileProposalIdentity) => ({ projectId, proposalId: row.proposalId });
let checks = 0;
async function check(name: string, action: () => Promise<void>) { await action(); checks++; process.stdout.write(`PASS manifest discovery: ${name}\n`); }
async function evidence(bytes: Uint8Array) {
  const evidenceId = createStableId("evidence");
  await pool.query(`INSERT INTO acp.evidence_records SELECT (jsonb_populate_record(NULL::acp.evidence_records,to_jsonb(source)||$1::jsonb)).*
    FROM acp.evidence_records source WHERE evidence_id=$2`, [JSON.stringify({ evidence_id: evidenceId, project_id: projectId,
    content_hash: hash(bytes), source_ref: "synthetic-selected-package-json", redacted_summary: "Synthetic configured script metadata only.",
    observed_at: "2026-09-04T00:00:00Z", retrieved_at: "2026-09-04T00:00:01Z", freshness: "current", accessibility: "available", sensitivity: "project_confidential" }), legacy("evd")]);
  const current = (await pool.query("SELECT content_hash FROM acp.evidence_records WHERE evidence_id=$1", [evidenceId])).rows[0];
  return { evidenceId, expectedContentHash: current.content_hash as string, bytes };
}
async function counts() {
  return (await pool.query(`SELECT jsonb_build_object('proposals',(SELECT count(*) FROM acp.project_profile_proposals),
    'pins',(SELECT count(*) FROM acp.project_profile_proposal_evidence),'profiles',(SELECT count(*) FROM acp.project_profiles),
    'grants',(SELECT count(*) FROM acp.capability_grants),'runs',(SELECT count(*) FROM acp.worker_runs),
    'effects',(SELECT count(*) FROM acp.effect_proposals),'missions',(SELECT count(*) FROM acp.missions)) AS counts`)).rows[0].counts;
}

try {
  await check("selected repository manifest becomes attributed metadata without running its scripts", async () => {
    // Fixture-only explicit acquisition; the adapter itself has no filesystem or process capability.
    const bytes = await readFile(new URL("../../../../package.json", import.meta.url));
    const supplied = await evidence(bytes), result = discoverNpmPackageManifest(supplied);
    assert.equal(result.state, "observed"); if (result.state !== "observed") throw new Error("fixture manifest unavailable");
    assert.equal(result.contentHash, hash(bytes));
    const row = identity(), before = await counts(), saved = await writer.recordDiscovery({ ...row, observations: result.observations });
    assert.equal(saved.proposal.state, "needs_input"); assert.equal(saved.proposal.fields["verification.tests"].status, "observed");
    assert.equal(saved.proposal.fields["verification.requiredGates"].status, "missing");
    assert.deepEqual(await getProjectProfileProposal(pool, query(row)), saved.proposal);
    assert.equal(saved.proposal.evidencePins[0]?.identityDigest, (await pool.query("SELECT acp.readiness_evidence_fingerprint(e) AS digest FROM acp.evidence_records e WHERE evidence_id=$1", [supplied.evidenceId])).rows[0].digest);
    const after = await counts(); for (const key of ["profiles", "grants", "runs", "effects", "missions"]) assert.equal(after[key], before[key]);
    await assert.rejects(getProfileConfirmationRequest(pool, query(row)), /unavailable/u);
  });
  const sentinel = "synthetic-private-command-body", bytes = Buffer.from(JSON.stringify({ scripts: {
    test: `node -e "throw Error('${sentinel}')"`, pretest: "synthetic private setup", lint: "synthetic private lint", build: "synthetic private build",
  } }));
  const supplied = await evidence(bytes), result = discoverNpmPackageManifest(supplied);
  assert.equal(result.state, "observed"); if (result.state !== "observed") throw new Error("synthetic manifest unavailable");
  const row = identity(), saved = await writer.recordDiscovery({ ...row, observations: result.observations });
  await check("full retained fields contain fingerprints but no command bodies, execution or approval claims", async () => {
    const historical = await getProjectProfileProposal(pool, query(row)); assert.deepEqual(historical, saved.proposal);
    const encoded = JSON.stringify(historical); assert.equal(encoded.includes(sentinel), false); assert.equal(encoded.includes("synthetic private"), false);
    assert.equal(Object.keys(saved.proposal.fields).length, 62); assert.equal(saved.proposal.state, "needs_input");
    assert.equal(saved.proposal.authority.activation, "not_authorized"); assert.equal(saved.proposal.fields["verification.ci"].status, "missing");
    assert.equal(saved.proposal.fields["repositories.inventory"].status, "missing");
  });
  await check("exact static extraction replays through the immutable private producer", async () => {
    const before = await counts();
    assert.deepEqual(await writer.recordDiscovery({ ...row, observations: result.observations.slice().reverse() }), { proposal: saved.proposal, replayed: true });
    assert.deepEqual(await counts(), before);
  });
  await check("hash mismatch and ambiguous JSON leave no partial discovery record", async () => {
    const before = await counts();
    for (const input of [{ ...supplied, expectedContentHash: hash(Buffer.from("wrong")) },
      { ...supplied, bytes: Buffer.from('{"scripts":{"test":"a","test":"b"}}'), expectedContentHash: hash(Buffer.from('{"scripts":{"test":"a","test":"b"}}')) }]) {
      const rejected = discoverNpmPackageManifest(input); assert.deepEqual(rejected, { state: "unconfirmed", kind: "npm_package_manifest", observations: [] });
      // The producer does not translate an unconfirmed adapter result into a successful empty-source scan.
      assert.equal(rejected.state, "unconfirmed");
    }
    assert.deepEqual(await counts(), before);
  });
  await check("different manifest reports preserve a conflict instead of silently choosing the later source", async () => {
    const other = await evidence(Buffer.from(JSON.stringify({ scripts: { test: "synthetic different test" } }))), alternate = discoverNpmPackageManifest(other);
    assert.equal(alternate.state, "observed"); if (alternate.state !== "observed") throw new Error("alternate manifest unavailable");
    const next = { ...row, proposalId: createStableId("projectProfileProposal"), supersedesProposalId: row.proposalId };
    const conflicted = await writer.recordDiscovery({ ...next, observations: [...result.observations, ...alternate.observations] });
    assert.equal(conflicted.proposal.state, "conflicted"); assert.equal(conflicted.proposal.fields["verification.tests"].status, "conflicted");
    assert.deepEqual(await getProjectProfileProposal(pool, query(row)), saved.proposal);
    await assert.rejects(getProfileConfirmationRequest(pool, query(next)), /unavailable/u);
  });
  await check("current evidence restriction still blocks public disclosure of historical extracted metadata", async () => {
    await pool.query("UPDATE acp.evidence_records SET sensitivity='restricted' WHERE evidence_id=$1", [supplied.evidenceId]);
    await assert.rejects(getProjectProfileProposal(pool, query(row)), /unavailable/u);
    assert.deepEqual(await writer.recordDiscovery({ ...row, observations: result.observations }), { proposal: saved.proposal, replayed: true });
  });
  process.stdout.write(`Static manifest PostgreSQL integration passed: ${checks} checks.\n`);
} finally { await pool.end(); }
