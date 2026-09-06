import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { it } from "node:test";
import { buildProjectProfileProposal, canonicalJsonDigest, createStableId, profileFieldIds, reduceProfileDiscoveryObservations } from "@acp/domain";
import type { Pool } from "pg";
import { getProjectProfileProposal, getProfileConfirmationRequest, PostgresProfileProposalStore } from "../src/profile-proposal-store.ts";
import { parseExactProfileJson } from "../src/profile-proposal-json.ts";

const producer = { component: "synthetic-discovery", version: "1.0.0", artifactDigest: canonicalJsonDigest({ synthetic: true }) };
const terms = { proposalId: createStableId("projectProfileProposal"), projectId: createStableId("project"),
  candidateProfile: { profileId: createStableId("projectProfile"), profileVersion: "1.0.0" }, baseProfile: null, supersedesProposalId: null, fields: {} };
const options = { max: 4, connectionTimeoutMillis: 3000, statement_timeout: 5000, lock_timeout: 2000 };
const { fields: _fields, ...identity } = terms;
const proposal = buildProjectProfileProposal({ ...identity, producer, proposedAt: "2026-09-06T00:00:00Z" }, {}, []);
const bodyOf = (value: typeof proposal) => { const { proposalDigest: _digest, ...body } = value; return JSON.stringify(body); };
const query = { projectId: terms.projectId, proposalId: terms.proposalId };

it("private discovery rejects malformed observations and caller-owned fields before any database I/O", async () => {
  let calls = 0;
  const pool = { options, async connect() { calls++; throw new Error("unexpected discovery I/O"); } } as unknown as Pool;
  const store = new PostgresProfileProposalStore(pool, producer);
  for (const extra of ["producer", "proposedAt", "fields", "evidencePins", "authority", "confirmedAt"]) {
    await assert.rejects(store.recordDiscovery({ ...identity, observations: [], [extra]: "injected" }));
  }
  await assert.rejects(store.recordDiscovery({ ...identity, observations: [{ fieldId: "context.product", value: "unattributed", evidenceIds: [] }] }));
  assert.equal(calls, 0);
});
it("private discovery delegates normalized history to the same exact replay and physical-discard protocol", async () => {
  const discovered = buildProjectProfileProposal({ ...identity, producer, proposedAt: proposal.proposedAt }, reduceProfileDiscoveryObservations([]), []);
  const seen: string[] = [], releases: unknown[] = [];
  const pool = { options, async connect() { return { async query(sql: string) {
    seen.push(sql); return { rows: sql.startsWith("SELECT") ? [{ body: bodyOf(discovered) }] : [] };
  }, release(discard: unknown) { releases.push(discard); } }; } } as unknown as Pool;
  const store = new PostgresProfileProposalStore(pool, producer);
  assert.deepEqual(await store.recordDiscovery({ ...identity, observations: [] }), { proposal: discovered, replayed: true });
  assert.deepEqual(await store.record({ ...identity, fields: discovered.fields }), { proposal: discovered, replayed: true });
  assert.ok(!seen.some(sql => /INSERT|UPDATE|DELETE/u.test(sql))); assert.deepEqual(releases, [true, true]);
});

it("pinned discovery rejects invalid expectations before opening a database session", async () => {
  let calls = 0;
  const pool = { options, async connect() { calls++; throw new Error("unexpected pinned discovery I/O"); } } as unknown as Pool;
  const store = new PostgresProfileProposalStore(pool, producer);
  await assert.rejects(store.recordPinnedDiscovery({ ...identity, observations: [], expectedEvidencePins: [{ evidenceId: createStableId("evidence"), projectId: identity.projectId, identityDigest: canonicalJsonDigest({ synthetic: true }) }] }));
  await assert.rejects(store.recordPinnedDiscovery({ ...identity, observations: [], expectedEvidencePins: [], authority: "injected" } as never));
  assert.equal(calls, 0);
});
it("current discovery evidence is one bounded private snapshot with exact scope and no raw source metadata", async () => {
  const evidenceId = createStableId("evidence"), expectedPin = { evidenceId, projectId: identity.projectId, identityDigest: canonicalJsonDigest({ source: true }) };
  const contentHash = canonicalJsonDigest({ bytes: true }), seen: string[] = [];
  const pool = { options, async query(sql: string, values: unknown[]) { seen.push(sql); assert.deepEqual(values, [identity.projectId, evidenceId]);
    return { rows: [{ source: { evidenceId, projectId: identity.projectId, contentHash, expectedPin } }] };
  } } as unknown as Pool;
  const result = await new PostgresProfileProposalStore(pool, producer).getCurrentDiscoveryEvidence({ projectId: identity.projectId, evidenceId });
  assert.deepEqual(result, { evidenceId, projectId: identity.projectId, contentHash, expectedPin });
  assert.equal(seen.length, 1); assert.match(seen[0]!, /SELECT/u); assert.doesNotMatch(seen[0]!, /INSERT|UPDATE|DELETE|FOR SHARE/u);
});
it("current discovery evidence denies invalid queries before I/O and missing or substituted source responses as a whole", async () => {
  const evidenceId = createStableId("evidence"), expectedPin = { evidenceId, projectId: identity.projectId, identityDigest: canonicalJsonDigest({ source: true }) };
  const source = { evidenceId, projectId: identity.projectId, contentHash: canonicalJsonDigest({ bytes: true }), expectedPin };
  let rows: unknown[] = [], calls = 0;
  const pool = { options, async query() { calls++; return { rows }; } } as unknown as Pool, store = new PostgresProfileProposalStore(pool, producer);
  await assert.rejects(store.getCurrentDiscoveryEvidence({ projectId: identity.projectId, evidenceId, latest: true })); assert.equal(calls, 0);
  for (const bad of [[], [{ source: null }], [{ source: { ...source, contentHash: "sha256:bad" } }], [{ source: { ...source, projectId: createStableId("project") } }],
    [{ source: { ...source, expectedPin: { ...expectedPin, evidenceId: createStableId("evidence") } } }], [{ source }, { source }]]) {
    rows = bad; await assert.rejects(store.getCurrentDiscoveryEvidence({ projectId: identity.projectId, evidenceId }), { message: "Current discovery evidence is unavailable." });
  }
});
it("current discovery evidence batch uses one query and canonical exact-set association", async () => {
  const evidenceIds = [createStableId("evidence"), createStableId("evidence")].sort();
  const sources = evidenceIds.map(evidenceId => ({ evidenceId, projectId: identity.projectId, contentHash: canonicalJsonDigest({ bytes: evidenceId }),
    expectedPin: { evidenceId, projectId: identity.projectId, identityDigest: canonicalJsonDigest({ source: evidenceId }) } }));
  let calls = 0;
  const pool = { options, async query(sql: string, values: unknown[]) { calls++; assert.deepEqual(values, [identity.projectId, evidenceIds]); assert.match(sql, /ANY\(\$2::text\[\]\)/u);
    return { rows: sources.slice().reverse().map(source => ({ source })) };
  } } as unknown as Pool;
  assert.deepEqual(await new PostgresProfileProposalStore(pool, producer).getCurrentDiscoveryEvidenceBatch({ projectId: identity.projectId, evidenceIds: evidenceIds.slice().reverse() }), sources);
  assert.equal(calls, 1);
});
it("current evidence batch rejects bad selectors before I/O and missing, duplicate or undisclosable rows as a whole", async () => {
  const evidenceId = createStableId("evidence"), source = { evidenceId, projectId: identity.projectId, contentHash: canonicalJsonDigest({ bytes: true }),
    expectedPin: { evidenceId, projectId: identity.projectId, identityDigest: canonicalJsonDigest({ source: true }) } };
  let rows: unknown[] = [], calls = 0;
  const pool = { options, async query() { calls++; return { rows }; } } as unknown as Pool, store = new PostgresProfileProposalStore(pool, producer);
  for (const evidenceIds of [[], [evidenceId, evidenceId], new Array(1), Array.from({ length: 6 }, () => createStableId("evidence"))]) {
    await assert.rejects(store.getCurrentDiscoveryEvidenceBatch({ projectId: identity.projectId, evidenceIds }));
  }
  assert.equal(calls, 0);
  for (const bad of [[], [{ source: null }], [{ source }, { source }], [{ source: { ...source, projectId: createStableId("project") } }]]) {
    rows = bad; await assert.rejects(store.getCurrentDiscoveryEvidenceBatch({ projectId: identity.projectId, evidenceIds: [evidenceId] }), { message: "Current discovery evidence is unavailable." });
  }
});
it("pinned discovery checks retained pins before historical COMMIT and does not rerun live admission", async () => {
  const evidenceId = createStableId("evidence"), pin = { evidenceId, projectId: identity.projectId, identityDigest: canonicalJsonDigest({ source: "original" }) };
  const observations = [{ fieldId: "context.product", value: "Synthetic", evidenceIds: [evidenceId] }];
  const saved = buildProjectProfileProposal({ ...identity, producer, proposedAt: proposal.proposedAt }, reduceProfileDiscoveryObservations(observations), [pin]);
  const seen: string[] = [], releases: unknown[] = [];
  const pool = { options, async connect() { return { async query(sql: string) {
    seen.push(sql); if (sql.startsWith("SELECT CASE")) return { rows: [{ body: bodyOf(saved) }] };
    assert.ok(sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK"); return { rows: [] };
  }, release(discard: unknown) { releases.push(discard); } }; } } as unknown as Pool;
  const store = new PostgresProfileProposalStore(pool, producer);
  assert.deepEqual(await store.recordPinnedDiscovery({ ...identity, observations, expectedEvidencePins: [pin] }), { proposal: saved, replayed: true });
  seen.length = 0;
  await assert.rejects(store.recordPinnedDiscovery({ ...identity, observations, expectedEvidencePins: [{ ...pin, identityDigest: canonicalJsonDigest({ source: "changed" }) }] }), /expected evidence/u);
  assert.equal(seen.includes("COMMIT"), false); assert.equal(seen.at(-1), "ROLLBACK"); assert.deepEqual(releases, [true, true]);
});

it("profile writer observes checked-out socket errors and removes the listener only after discard", async () => {
  for (const phase of ["BEGIN", "COMMIT"]) {
    const client = new EventEmitter(), seen: string[] = [];
    let released = false;
    Object.assign(client, { async query(sql: string) {
      seen.push(sql); assert.equal(client.listenerCount("error"), 1);
      if (sql === phase) client.emit("error", new Error("synthetic socket failure"));
      return { rows: sql.startsWith("INSERT") ? [{ body: bodyOf(proposal) }] : [] };
    }, release(discard: unknown) { assert.equal(discard,true); assert.equal(client.listenerCount("error"),1); released = true; } });
    const pool = { options, async connect() { return client; }, async query() { assert.equal(released,true); return { rows: [{ body: bodyOf(proposal) }] }; } } as unknown as Pool;
    if (phase === "BEGIN") await assert.rejects(new PostgresProfileProposalStore(pool,producer).record(terms), /socket failure/u);
    else assert.equal((await new PostgresProfileProposalStore(pool,producer).record(terms)).replayed,true);
    assert.equal(client.listenerCount("error"),0); assert.equal(released,true); assert.equal(seen.at(-1),phase);
  }
});

it("profile writer rejects caller-owned authority and unbounded pools before I/O", async () => {
  let calls = 0;
  const pool = { options, async connect() { calls++; throw new Error("unexpected I/O"); } } as unknown as Pool;
  assert.throws(() => new PostgresProfileProposalStore({ ...pool, options: {} } as unknown as Pool, producer));
  assert.throws(() => new PostgresProfileProposalStore(pool, { ...producer, component: " " }));
  const store = new PostgresProfileProposalStore(pool, producer);
  for (const extra of ["producer", "proposedAt", "evidencePins", "state", "authority", "proposalDigest", "confirmedAt"]) {
    await assert.rejects(store.record({ ...terms, [extra]: "injected" }));
  }
  await assert.rejects(store.record({ ...terms, fields: { "identity.guessed": true } }));
  assert.equal(calls, 0);
});

it("profile writer normalizes partial fields and replays only exact historical terms on a discarded session", async () => {
  const seen: string[] = [], releases: unknown[] = [];
  let body = bodyOf(proposal);
  const pool = { options, async connect() { return { async query(sql: string) {
    seen.push(sql); return { rows: sql.startsWith("SELECT") ? [{ body }] : [] };
  }, release(discard: unknown) { releases.push(discard); } }; } } as unknown as Pool;
  const store = new PostgresProfileProposalStore(pool, producer);
  assert.deepEqual(await store.record(terms), { proposal, replayed: true });
  assert.deepEqual(await store.record({ ...terms, fields: proposal.fields }), { proposal, replayed: true });
  assert.ok(!seen.some(sql => /INSERT|UPDATE|DELETE/u.test(sql)));
  body = JSON.stringify({ ...JSON.parse(body), producer: { ...producer, version: "2.0.0" } });
  await assert.rejects(store.record(terms), /different terms/u);
  assert.equal(seen.at(-1), "ROLLBACK"); assert.deepEqual(releases, [true, true, true]);
});

it("profile writer closes failed transaction before independent lost-COMMIT readback", async () => {
  let released = false, readbacks = 0;
  const seen: string[] = [];
  const pool = { options, async connect() { return { async query(sql: string) {
    seen.push(sql);
    if (sql === "COMMIT") throw new Error("synthetic lost COMMIT");
    if (sql.startsWith("INSERT")) return { rows: [{ body: bodyOf(proposal) }] };
    return { rows: [] };
  }, release(discard: unknown) { assert.equal(discard, true); released = true; } }; },
  async query() { assert.equal(released, true); readbacks++; return { rows: [{ body: bodyOf(proposal) }] }; } } as unknown as Pool;
  assert.deepEqual(await new PostgresProfileProposalStore(pool, producer).record(terms), { proposal, replayed: true });
  assert.equal(readbacks, 1); assert.ok(seen.includes("ROLLBACK"));
});

it("profile reads are exact single snapshots, reconstruct the domain digest and deny partial disclosure", async () => {
  let calls = 0;
  let row: unknown = { proposal_error: null, body: bodyOf(proposal), snapshot: { currentProposalId: terms.proposalId,
    candidateProfileExists: false, baseProfileDigest: null, asOf: "2026-09-06T00:01:00Z", evidence: [] } };
  const executor = { async query() { calls++; return { rows: row === undefined ? [] : [row] }; } } as unknown as Pool;
  await assert.rejects(getProjectProfileProposal(executor, { ...query, latest: true })); assert.equal(calls, 0);
  assert.deepEqual(await getProjectProfileProposal(executor, query), proposal); assert.equal(calls, 1);
  await assert.rejects(getProfileConfirmationRequest(executor, query), /unavailable/u);
  const complete = buildProjectProfileProposal({ proposalId: terms.proposalId, projectId: terms.projectId,
    candidateProfile: terms.candidateProfile, baseProfile: null, supersedesProposalId: null, producer, proposedAt: proposal.proposedAt },
  Object.fromEntries(profileFieldIds.map(id => [id, { status: "not_applicable", rationale: "Synthetic proposal.", evidenceIds: [] }])), []);
  row = { proposal_error: null, body: bodyOf(complete), snapshot: { currentProposalId: terms.proposalId,
    candidateProfileExists: false, baseProfileDigest: null, asOf: "2026-09-06T00:01:00Z", evidence: [] } };
  const request = await getProfileConfirmationRequest(executor, query);
  assert.equal(request?.kind, "confirmation_request_only"); assert.equal(request?.activation, "not_authorized");
  for (const error of ["invalid_references", "too_large", "unexpected"]) {
    row = { proposal_error: error, snapshot: { forbidden: "synthetic-private" } };
    await assert.rejects(getProjectProfileProposal(executor, query), { message: "Profile proposal is unavailable; no partial snapshot returned." });
  }
  row = undefined; assert.equal(await getProjectProfileProposal(executor, query), undefined);
});

it("exact PostgreSQL JSON accepts scale/exponent variants but rejects decimal rounding and malformed tokens", () => {
  for (const [text,number] of [["0.100",0.1],["0.0000001",1e-7],["9007199254740991.0",Number.MAX_SAFE_INTEGER],["-0",-0],["5e-324",Number.MIN_VALUE]] as const) {
    assert.equal(parseExactProfileJson(text),number);
  }
  const escaped = { text: '0.100000000000000001 \" \\ 1e999', value: 0.1 };
  assert.deepEqual(parseExactProfileJson(JSON.stringify(escaped)),escaped);
  for (const text of ["0.1000000000000000000001","1e-400","9007199254740993","1e1000000","01","1.","1e","{\"x\":NaN}","[1,,2]",'"unterminated', '"bad\\x"']) assert.throws(() => parseExactProfileJson(text));
});
