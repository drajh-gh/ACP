import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { canonicalJsonDigest, createStableId, type StableId, type ProfileProposalIdentity } from "@acp/domain";
import { getProjectProfileProposal, getProfileConfirmationRequest, PostgresProfileProposalStore } from "@acp/storage";
import { discoverNpmPackageManifest } from "../../src/npm-package-manifest-discovery.ts";
import { recordNpmManifestDiscovery, recordNpmManifestDiscoveries } from "../../src/npm-manifest-discovery-coordinator.ts";

const port = Number(process.argv[2]), phase = process.argv[3] ?? "static";
if (!Number.isInteger(port) || port < 1024 || port > 65535 || !["static", "bound", "batch"].includes(phase)) throw new Error("owned PostgreSQL port and exact manifest phase required");
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
  if (phase === "bound" || phase === "batch") {
    await check("private coordinator binds supplied bytes to the current database hash and exact retained pin", async () => {
      const supplied = await evidence(bytes), row = identity(), before = await counts();
      const saved = await recordNpmManifestDiscovery(writer, { ...row, evidenceId: supplied.evidenceId, bytes });
      assert.equal(saved.state, "recorded"); if (saved.state !== "recorded") throw new Error("fixture discovery missing");
      assert.equal(saved.replayed, false); assert.equal(saved.proposal.state, "needs_input");
      const source = await writer.getCurrentDiscoveryEvidence({ projectId, evidenceId: supplied.evidenceId });
      assert.deepEqual(saved.proposal.evidencePins, [source.expectedPin]); assert.equal(source.contentHash, hash(bytes));
      assert.deepEqual(await getProjectProfileProposal(pool, query(row)), saved.proposal);
      const text = JSON.stringify(saved.proposal); assert.equal(text.includes(sentinel), false); assert.equal(text.includes(hash(bytes)), false);
      const after = await counts(); assert.equal(after.proposals, before.proposals + 1); assert.equal(after.pins, before.pins + 1);
      for (const key of ["profiles", "grants", "runs", "effects", "missions"]) assert.equal(after[key], before[key]);
    });
    await check("private source descriptor fails whole on absent, wrong-project, unusable or non-SHA256 evidence", async () => {
      const supplied = await evidence(bytes), selected = { projectId, evidenceId: supplied.evidenceId };
      const before = await counts(), descriptor = await writer.getCurrentDiscoveryEvidence(selected);
      assert.deepEqual(Object.keys(descriptor).sort(), ["contentHash", "evidenceId", "expectedPin", "projectId"]);
      for (const bad of [{ ...selected, evidenceId: createStableId("evidence") }, { ...selected, projectId: createStableId("project") }]) {
        await assert.rejects(writer.getCurrentDiscoveryEvidence(bad), { message: "Current discovery evidence is unavailable." });
      }
      for (const change of ["freshness='stale'", "accessibility='inaccessible'", "sensitivity='restricted'", "content_hash=NULL",
        "content_hash='sha256:invented'", "retrieved_at='2099-01-01T00:00:00Z'"]) {
        const item = await evidence(bytes); await pool.query(`UPDATE acp.evidence_records SET ${change} WHERE evidence_id=$1`, [item.evidenceId]);
        await assert.rejects(writer.getCurrentDiscoveryEvidence({ projectId, evidenceId: item.evidenceId }), { message: "Current discovery evidence is unavailable." });
      }
      assert.deepEqual(await counts(), before);
    });
    await check("bad hash, ambiguous JSON and no relevant declarations write no parent or pins", async () => {
      const before = await counts();
      for (const value of [Buffer.from("wrong hash"), Buffer.from('{"scripts":{"test":"a","test":"b"}}'), Buffer.from('{}'), Buffer.from('{"scripts":{"pretest":"synthetic"}}')]) {
        const supplied = await evidence(value.toString() === "wrong hash" ? bytes : value), row = identity();
        const result = await recordNpmManifestDiscovery(writer, { ...row, evidenceId: supplied.evidenceId, bytes: value });
        assert.equal(result.state, "not_recorded");
        if (result.state === "not_recorded") assert.equal(result.reason, value.toString().includes("scripts\":{\"test") || value.toString() === "wrong hash" ? "manifest_unconfirmed" : "no_relevant_declarations");
        assert.equal((await pool.query("SELECT count(*)::integer AS n FROM acp.project_profile_proposals WHERE proposal_id=$1", [row.proposalId])).rows[0].n, 0);
      }
      assert.deepEqual(await counts(), before);
    });
    await check("post-descriptor identity, freshness, accessibility or disclosure changes cannot slip into a new draft", async () => {
      for (const change of ["content_hash='sha256:changed'", "source_version='changed'", "freshness='stale'", "accessibility='inaccessible'", "sensitivity='restricted'"]) {
        const supplied = await evidence(bytes), row = identity(), before = await counts();
        const intercepted = { async getCurrentDiscoveryEvidence(value: unknown) {
          const source = await writer.getCurrentDiscoveryEvidence(value);
          await pool.query(`UPDATE acp.evidence_records SET ${change} WHERE evidence_id=$1`, [supplied.evidenceId]); return source;
        }, recordPinnedDiscovery: writer.recordPinnedDiscovery.bind(writer) };
        await assert.rejects(recordNpmManifestDiscovery(intercepted, { ...row, evidenceId: supplied.evidenceId, bytes }), /not confirmed/u);
        assert.deepEqual(await counts(), before);
      }
    });
    await check("same-current-source replay succeeds but changed source with equivalent declarations cannot alias history", async () => {
      const supplied = await evidence(bytes), row = identity(), input = { ...row, evidenceId: supplied.evidenceId, bytes };
      const saved = await recordNpmManifestDiscovery(writer, input); assert.equal(saved.state, "recorded");
      if (saved.state !== "recorded") throw new Error("fixture discovery missing");
      assert.deepEqual(await recordNpmManifestDiscovery(writer, input), { ...saved, replayed: true });
      const changedBytes = Buffer.concat([bytes, Buffer.from(" ")]);
      await pool.query("UPDATE acp.evidence_records SET content_hash=$2 WHERE evidence_id=$1", [supplied.evidenceId, hash(changedBytes)]);
      assert.deepEqual(await recordNpmManifestDiscovery(writer, input), { state: "not_recorded", reason: "manifest_unconfirmed" });
      await assert.rejects(recordNpmManifestDiscovery(writer, { ...input, bytes: changedBytes }), /not confirmed/u);
      assert.deepEqual(await getProjectProfileProposal(pool, query(row)), saved.proposal);
    });
    await check("no-observation result says only this invocation wrote nothing even when the proposal ID has history", async () => {
      const supplied = await evidence(bytes), row = identity(), saved = await recordNpmManifestDiscovery(writer, { ...row, evidenceId: supplied.evidenceId, bytes });
      assert.equal(saved.state, "recorded"); if (saved.state !== "recorded") throw new Error("fixture discovery missing");
      const emptyBytes = Buffer.from('{}'), empty = await evidence(emptyBytes), before = await counts();
      assert.deepEqual(await recordNpmManifestDiscovery(writer, { ...row, evidenceId: empty.evidenceId, bytes: emptyBytes }), { state: "not_recorded", reason: "no_relevant_declarations" });
      assert.deepEqual(await counts(), before); assert.deepEqual(await getProjectProfileProposal(pool, query(row)), saved.proposal);
    });
    for (const readbackFails of [false, true]) await check(`coordinator ${readbackFails ? "preserves uncertainty after failed readback" : "recovers exact retention"} after a real lost COMMIT`, async () => {
      const supplied = await evidence(bytes), row = identity(), input = { ...row, evidenceId: supplied.evidenceId, bytes };
      const intercepted = { options: pool.options, async query(sql: string, values?: unknown[]) {
        if (readbackFails && sql.startsWith("SELECT CASE WHEN octet_length(body")) throw new Error("synthetic private readback failure");
        return pool.query(sql, values);
      }, async connect() { const client = await pool.connect(); return { on: client.on.bind(client), off: client.off.bind(client),
        async query(sql: string, values?: unknown[]) { const result = await client.query(sql, values); if (sql === "COMMIT") throw new Error("synthetic private lost COMMIT"); return result; },
        release(discard?: Error | boolean) { assert.equal(discard, true); client.release(discard); } }; } } as unknown as Pool;
      const producer = { component: "synthetic-bound-manifest", version: "1", artifactDigest: canonicalJsonDigest({ boundFixture: true }) };
      if (readbackFails) await assert.rejects(recordNpmManifestDiscovery(new PostgresProfileProposalStore(intercepted, producer), input),
        { message: "Manifest discovery was not confirmed; persistence may require exact retry." });
      else {
        const result = await recordNpmManifestDiscovery(new PostgresProfileProposalStore(intercepted, producer), input);
        assert.equal(result.state, "recorded"); if (result.state === "recorded") assert.equal(result.replayed, true);
      }
      const retry = await recordNpmManifestDiscovery(new PostgresProfileProposalStore(pool, producer), input);
      assert.equal(retry.state, "recorded"); if (retry.state === "recorded") assert.equal(retry.replayed, true);
    });
  }
  if (phase === "batch") {
    const suppliedSource = async (bytes: Uint8Array) => ({ evidenceId: (await evidence(bytes)).evidenceId, bytes });
    await check("two equivalent manifests merge evidence into one draft and reorder to the same retained replay", async () => {
      const sources = [await suppliedSource(bytes), await suppliedSource(bytes)], row = identity(), before = await counts();
      const first = await recordNpmManifestDiscoveries(writer, { ...row, sources });
      assert.equal(first.state, "recorded"); if (first.state !== "recorded") throw new Error("batch fixture");
      assert.equal(first.proposal.fields["verification.tests"].status, "observed"); assert.equal(first.proposal.evidencePins.length, 2);
      assert.deepEqual(await recordNpmManifestDiscoveries(writer, { ...row, sources: sources.slice().reverse() }), { ...first, replayed: true });
      const after = await counts(); assert.equal(after.proposals, before.proposals + 1); assert.equal(after.pins, before.pins + 2);
      for (const key of ["profiles", "grants", "runs", "effects", "missions"]) assert.equal(after[key], before[key]);
    });
    await check("different manifests retain conflicts and independent configured categories in a single proposal", async () => {
      const sources = [await suppliedSource(Buffer.from('{"scripts":{"test":"one"}}')), await suppliedSource(Buffer.from('{"scripts":{"test":"two","lint":"lint"}}'))];
      const result = await recordNpmManifestDiscoveries(writer, { ...identity(), sources });
      assert.equal(result.state, "recorded"); if (result.state !== "recorded") throw new Error("batch fixture");
      assert.equal(result.proposal.state, "conflicted"); assert.equal(result.proposal.fields["verification.tests"].status, "conflicted");
      assert.equal(result.proposal.fields["verification.linting"].status, "observed"); assert.equal(result.proposal.fields["verification.builds"].status, "missing");
    });
    await check("one missing, restricted, wrong-project or hash-mismatched source prevents a partial draft", async () => {
      const good = await suppliedSource(bytes), restricted = await suppliedSource(bytes), before = await counts();
      await pool.query("UPDATE acp.evidence_records SET sensitivity='restricted' WHERE evidence_id=$1", [restricted.evidenceId]);
      for (const bad of [{ evidenceId: createStableId("evidence"), bytes }, restricted]) {
        await assert.rejects(recordNpmManifestDiscoveries(writer, { ...identity(), sources: [good, bad] }), /not confirmed/u);
      }
      await assert.rejects(writer.getCurrentDiscoveryEvidenceBatch({ projectId: createStableId("project"), evidenceIds: [good.evidenceId] }), /unavailable/u);
      const mismatched = await suppliedSource(bytes);
      assert.deepEqual(await recordNpmManifestDiscoveries(writer, { ...identity(), sources: [good, { ...mismatched, bytes: Buffer.from('{}') }] }), { state: "not_recorded", reason: "manifest_unconfirmed" });
      assert.deepEqual(await counts(), before);
    });
    await check("empty contributors are not retained and adding another empty source can replay the same attributed history", async () => {
      const nonempty = await suppliedSource(bytes), empty = await suppliedSource(Buffer.from('{}')), row = identity();
      const first = await recordNpmManifestDiscoveries(writer, { ...row, sources: [empty, nonempty] });
      assert.equal(first.state, "recorded"); if (first.state !== "recorded") throw new Error("batch fixture");
      assert.deepEqual(first.proposal.evidencePins.map(pin => pin.evidenceId), [nonempty.evidenceId]);
      const otherEmpty = await suppliedSource(Buffer.from('{"scripts":{"start":"ignored"}}'));
      assert.deepEqual(await recordNpmManifestDiscoveries(writer, { ...row, sources: [otherEmpty, nonempty] }), { ...first, replayed: true });
      const before = await counts();
      assert.deepEqual(await recordNpmManifestDiscoveries(writer, { ...row, sources: [empty, otherEmpty] }), { state: "not_recorded", reason: "no_relevant_declarations" });
      assert.deepEqual(await counts(), before);
    });
    await check("referenced-source drift after the batch snapshot rejects the whole new draft", async () => {
      for (const change of ["content_hash='sha256:changed'", "freshness='stale'", "sensitivity='restricted'"]) {
        const sources = [await suppliedSource(bytes), await suppliedSource(bytes)], before = await counts();
        const intercepted = { async getCurrentDiscoveryEvidenceBatch(value: unknown) {
          const descriptors = await writer.getCurrentDiscoveryEvidenceBatch(value);
          await pool.query(`UPDATE acp.evidence_records SET ${change} WHERE evidence_id=$1`, [sources[1]!.evidenceId]); return descriptors;
        }, recordPinnedDiscovery: writer.recordPinnedDiscovery.bind(writer) };
        await assert.rejects(recordNpmManifestDiscoveries(intercepted, { ...identity(), sources }), /not confirmed/u);
        assert.deepEqual(await counts(), before);
      }
    });
    await check("empty-source changes are not commit-pinned or negative coverage and later declarations require new retained terms", async () => {
      const nonempty = await suppliedSource(bytes), empty = await suppliedSource(Buffer.from('{}')), row = identity();
      const changed = Buffer.from('{"scripts":{"test":"newly configured"}}');
      const intercepted = { async getCurrentDiscoveryEvidenceBatch(value: unknown) {
        const descriptors = await writer.getCurrentDiscoveryEvidenceBatch(value);
        await pool.query("UPDATE acp.evidence_records SET content_hash=$2 WHERE evidence_id=$1", [empty.evidenceId, hash(changed)]); return descriptors;
      }, recordPinnedDiscovery: writer.recordPinnedDiscovery.bind(writer) };
      const first = await recordNpmManifestDiscoveries(intercepted, { ...row, sources: [empty, nonempty] });
      assert.equal(first.state, "recorded"); if (first.state !== "recorded") throw new Error("batch fixture");
      assert.deepEqual(first.proposal.evidencePins.map(pin => pin.evidenceId), [nonempty.evidenceId]);
      await assert.rejects(recordNpmManifestDiscoveries(writer, { ...row, sources: [nonempty, { ...empty, bytes: changed }] }), /not confirmed/u);
      assert.deepEqual(await getProjectProfileProposal(pool, query(row)), first.proposal);
    });
    await check("all descriptor rows share one MVCC snapshot across a concurrent metadata transaction", async () => {
      const sources = [await suppliedSource(bytes), await suppliedSource(bytes)], selected = { projectId, evidenceIds: sources.map(item => item.evidenceId) };
      const original = await writer.getCurrentDiscoveryEvidenceBatch(selected), gate = Math.floor(Math.random() * 1_000_000_000) + 1_000_000_000;
      const holder = await pool.connect(); let pending: Promise<unknown> | undefined;
      try {
        await holder.query("BEGIN"); await holder.query("SELECT pg_advisory_xact_lock($1)", [gate]);
        const intercepted = { options: pool.options, async query(sql: string, values?: unknown[]) {
          return pool.query(`WITH waited AS MATERIALIZED (SELECT pg_advisory_xact_lock($3)) ${sql.replace("FROM acp.evidence_records e", "FROM acp.evidence_records e CROSS JOIN waited")}`, [...values!, gate]);
        } } as unknown as Pool;
        pending = new PostgresProfileProposalStore(intercepted, { component: "snapshot-fixture", version: "1", artifactDigest: canonicalJsonDigest({ snapshot: true }) }).getCurrentDiscoveryEvidenceBatch(selected);
        pending.catch(() => undefined);
        const until = Date.now() + 2000; let waiting = false;
        while (Date.now() < until) {
          waiting = (await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE 'WITH waited AS MATERIALIZED%') AS waiting")).rows[0].waiting;
          if (waiting) break; await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(waiting, true);
        await pool.query("UPDATE acp.evidence_records SET freshness='stale',source_version='changed together' WHERE evidence_id=ANY($1::text[])", [selected.evidenceIds]);
        await holder.query("COMMIT"); assert.deepEqual(await pending, original);
        await assert.rejects(writer.getCurrentDiscoveryEvidenceBatch(selected), /unavailable/u);
      } finally { try { await holder.query("ROLLBACK"); } finally { holder.release(true); } await pending?.catch(() => undefined); }
    });
  }
  process.stdout.write(`Manifest PostgreSQL integration (${phase}) passed: ${checks} checks.\n`);
} finally { await pool.end(); }
