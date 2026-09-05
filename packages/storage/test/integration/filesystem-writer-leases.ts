import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool, type QueryResult, type QueryResultRow } from "pg";
import { createStableId } from "@acp/domain";
import { PostgresFilesystemWriterStore, PostgresRepositoryBindingStore, PostgresRuntimeStore, type RepositoryBindingInput, type WorktreeBindingInput } from "../../src/index.ts";
import { launchRecoveryFixture } from "./launch-recovery-fixture.ts";
import { FilesystemWriterGuard } from "../../../../apps/worker/src/filesystem-writer-guard.ts";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("owned database port required");
const pool = new Pool({ connectionString: `postgresql://postgres:acp_test_password@127.0.0.1:${port}/acp_test`, max: 4,
  statement_timeout: 5000, lock_timeout: 3000, connectionTimeoutMillis: 3000 });
let checks = 0, directories = 0;
const identity = () => `win32-dir:12345678:${(++directories).toString(16).padStart(16,"0")}`;
async function check(name: string, action: () => Promise<void>) { await action(); checks++; process.stdout.write(`PASS filesystem writer: ${name}\n`); }
try {
  let f = await launchRecoveryFixture(pool,"host:filesystem-writer-check","0014");
  let store = new PostgresFilesystemWriterStore(pool,f.runtime), registry = new PostgresRepositoryBindingStore(pool,f.runtime);
  async function provenance() {
    const id = createStableId("provenance");
    await pool.query(`INSERT INTO acp.runtime_provenance SELECT (jsonb_populate_record(NULL::acp.runtime_provenance,to_jsonb(p)
      ||jsonb_build_object('provenance_id',$1::text,'recorded_at',clock_timestamp()))).* FROM acp.runtime_provenance p WHERE provenance_id=$2`,[id,f.template]);
    return id;
  }
  async function fixture(options: { repo?: RepositoryBindingInput; repositoryId?: RepositoryBindingInput["repositoryId"]; branch?: string; delivery?: boolean; journal?: boolean; wallTimeMs?: number; machine?: string } = {}) {
    const id = createStableId("worktreeBinding"), workspace = { path: `C:\\ACP-writer-test\\worktrees\\${id}`, identity: identity() };
    const s = await f.sample(options.journal ?? false,undefined,workspace.path,options.delivery ?? true,options.wallTimeMs ?? 60000);
    const repoId = createStableId("repositoryBinding");
    const repo: RepositoryBindingInput = options.repo ?? { repositoryBindingId: repoId,repositoryId: options.repositoryId ?? createStableId("repository"),
      projectId: s.packet.projectId, machineFingerprint: options.machine ?? "b".repeat(64),
      checkout: { path: `C:\\ACP-writer-test\\repos\\${repoId}`,identity: identity() },
      commonGitDirectory: { path: `C:\\ACP-writer-test\\repos\\${repoId}\\.git`,identity: identity() },
      observedAt: new Date().toISOString(),provenanceId: await provenance() };
    if (!options.repo) await registry.recordRepository(repo);
    const tree: WorktreeBindingInput = { worktreeBindingId: id,repositoryBindingId: repo.repositoryBindingId,missionId: s.a.missionId,workspace,
      gitDirectory: { path: `${repo.commonGitDirectory.path}\\worktrees\\${id}`,identity: identity() }, branchRef: options.branch ?? "refs/heads/Feature/ExactCase",
      headRevision: "a".repeat(40),observedAt: new Date().toISOString(),provenanceId: await provenance() };
    await registry.recordWorktree(tree);
    const reservation = { leaseId: createStableId("lease"),runId: s.start.runId,workerProcessId: s.registration.workerProcessId,
      worktreeBindingId: id,provenanceId: s.a.packetProvenanceId };
    return { ...s,repo,tree,reservation,stop: async () => {
      if (!options.journal) await f.workers.recordWorkerProcessFromRun(s.registration);
      await s.finishOwner();
    } };
  }
  function intercepted(mode: "lost_commit" | "close_before_commit") {
    return new PostgresFilesystemWriterStore({ options: pool.options,async connect() {
      const client = await pool.connect();
      return { release: () => client.release(),async query<R extends QueryResultRow>(text: string,values?: unknown[]): Promise<QueryResult<R>> {
        if (text === "COMMIT" && mode === "close_before_commit") await client.query("UPDATE acp.worker_host_sessions SET state='closed' WHERE host_identifier=$1",[f.runtime.hostIdentifier]);
        const result = await client.query<R>(text,values);
        if (text === "COMMIT" && mode === "lost_commit") throw new Error("synthetic lost commit acknowledgement");
        return result;
      } };
    } } as unknown as Pool,f.runtime);
  }
  await check("database-derived ownership, bounded renewal and exact concurrent replay",async () => {
    const x = await fixture();
    const [left,right] = await Promise.all([store.reserve(x.reservation),store.reserve(x.reservation)]);
    assert.deepEqual(left,right); assert.equal(left.state,"active"); assert.equal(left.revision,1);
    assert.equal(left.workspaceKey,`repo:${x.repo.repositoryId}:worktree:${x.a.missionId}`);
    assert.equal(left.branchKey,`branch:${x.repo.repositoryId}:${createHash("sha256").update(x.tree.branchRef).digest("hex")}`);
    assert.ok(left.physicalWorkspaceKey.includes(x.tree.workspace.identity));
    assert.ok(Date.parse(left.expiresAt)-Date.parse(left.heartbeatAt)<=20000);
    assert.deepEqual(await store.loadLaunchBinding(left.leaseId),{ lease:left,intent:x.start.launchIntent,
      workspace:x.tree.workspace.path,deadlineAt:x.started.timeoutAt });
    assert.deepEqual(await store.load(left.leaseId),left); // Metadata reads never renew.
    for (const owner of [{ ...f.runtime,hostIdentifier:"host:other-writer" },
      { ...f.runtime,sessionId:createStableId("workerHostSession") },{ ...f.runtime,applicationVersion:"other" }]) {
      assert.equal(await new PostgresFilesystemWriterStore(pool,owner).loadLaunchBinding(left.leaseId),undefined);
    }
    assert.equal(await store.loadLaunchBinding(createStableId("lease")),undefined);
    const renewed = await store.heartbeat(left.leaseId); assert.equal(renewed.revision,2);
    assert.equal(renewed.acquiredAt,left.acquiredAt); assert.ok(Date.parse(renewed.expiresAt)>=Date.parse(left.expiresAt));
    await assert.rejects(store.reserve({ ...x.reservation,leaseId: createStableId("lease") }),/aliases different/u);
    await assert.rejects(store.reserve({ ...x.reservation,workerProcessId: createStableId("workerProcess") }),/aliases different/u);
    await assert.rejects(store.release(left.leaseId),/stopped terminal run/u);
    await x.stop(); assert.equal((await store.load(left.leaseId))?.state,"recovering");
    assert.equal(await store.loadLaunchBinding(left.leaseId),undefined);
    await assert.rejects(store.release(left.leaseId),/stopped terminal run/u); // Result-validation gap remains excluded.
    await x.finishRun(); assert.equal((await store.release(left.leaseId)).state,"released");
    assert.equal((await store.reserve(x.reservation)).state,"released");
    assert.equal(await store.loadLaunchBinding(left.leaseId),undefined);
    await assert.rejects(store.heartbeat(left.leaseId),/unreleased owner/u);
    const events = (await pool.query("SELECT event_type FROM acp.mission_events WHERE mission_id=$1 AND event_type LIKE 'filesystem.writer-%' ORDER BY occurred_at",[x.a.missionId])).rows;
    assert.deepEqual(events.map((e) => e.event_type),["filesystem.writer-acquired","filesystem.writer-renewed","filesystem.writer-released"]);
  });
  await check("same exact branch across physical clones has one concurrent winner while logical branch case remains distinct",async () => {
    const x = await fixture(), y = await fixture({ repositoryId: x.repo.repositoryId }), z = await fixture({ repositoryId: x.repo.repositoryId,branch: x.tree.branchRef.toLowerCase() });
    const results = await Promise.allSettled([store.reserve(x.reservation),store.reserve(y.reservation)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length,1);
    assert.equal(results.filter((r) => r.status === "rejected").length,1);
    const winner = results[0]!.status === "fulfilled" ? x : y, loser = winner === x ? y : x;
    assert.equal((await store.reserve(z.reservation)).state,"active");
    await winner.stop(); await winner.finishRun(); await store.release(winner.reservation.leaseId);
    assert.equal((await store.reserve(loser.reservation)).state,"active");
  });
  await check("physical common-directory exclusion protects shared Windows ref aliases without folding logical branch keys",async () => {
    const x = await fixture(), y = await fixture({ repo: x.repo,branch: x.tree.branchRef.toLowerCase() });
    const original = await store.reserve(x.reservation);
    await assert.rejects(store.reserve(y.reservation),/filesystem_writer_repository_exclusive/u);
    await x.stop(); await x.finishRun(); await store.release(x.reservation.leaseId);
    const replacement = await store.reserve(y.reservation);
    assert.equal(original.physicalRepositoryKey,replacement.physicalRepositoryKey);
    assert.notEqual(original.branchKey,replacement.branchKey);
  });
  await check("read-only, wrong-machine, wrong-mission and already journaled runs cannot retrospectively acquire",async () => {
    for (const options of [{ delivery: false },{ machine: "a".repeat(64) },{ journal: true }]) {
      const x = await fixture(options); await assert.rejects(store.reserve(x.reservation),/exact live delivery|before process registration/u);
    }
    const x = await fixture(), y = await fixture();
    await assert.rejects(store.reserve({ ...x.reservation,worktreeBindingId: y.tree.worktreeBindingId }),/exact live delivery/u);
    await x.handoff(); await assert.rejects(store.reserve(x.reservation),/exact live delivery/u);
  });
  await check("expiry retains branch exclusion and exact replay never revives an expired owner",async () => {
    const x = await fixture({ wallTimeMs: 2000 }); const lease = await store.reserve(x.reservation);
    const y = await fixture({ repo: x.repo });
    await new Promise((done) => setTimeout(done,Math.max(1,Date.parse(lease.expiresAt)-Date.now()+30)));
    assert.equal((await store.load(lease.leaseId))?.state,"recovering");
    assert.equal(await store.loadLaunchBinding(lease.leaseId),undefined);
    assert.equal((await store.reserve(x.reservation)).revision,1);
    await assert.rejects(store.heartbeat(lease.leaseId),/expired filesystem writer/u);
    await assert.rejects(store.reserve(y.reservation),/duplicate key/u);
    await assert.rejects(store.release(lease.leaseId),/stopped terminal run/u);
  });
  await check("retirement and revocation revoke renewal but cannot free exclusion",async () => {
    const x = await fixture(); await store.reserve(x.reservation);
    await registry.retireWorktree(x.tree.worktreeBindingId,await provenance(),"No further writer admission.");
    assert.equal((await store.load(x.reservation.leaseId))?.state,"recovering");
    assert.equal(await store.loadLaunchBinding(x.reservation.leaseId),undefined);
    await assert.rejects(store.heartbeat(x.reservation.leaseId),/exact live delivery/u);
    const y = await fixture({ repo: x.repo }); await assert.rejects(store.reserve(y.reservation),/duplicate key/u);
    await x.stop(); await x.finishRun(); assert.equal((await store.release(x.reservation.leaseId)).state,"released");
    await store.reserve(y.reservation); await y.handoff();
    assert.equal((await store.load(y.reservation.leaseId))?.state,"recovering");
    await assert.rejects(store.heartbeat(y.reservation.leaseId),/exact live delivery/u);
  });
  await check("lost acquisition, renewal and release acknowledgements keep one durable history",async () => {
    const x = await fixture(), uncertain = intercepted("lost_commit");
    await assert.rejects(uncertain.reserve(x.reservation),/lost commit/u);
    assert.equal((await store.reserve(x.reservation)).revision,1);
    await assert.rejects(uncertain.heartbeat(x.reservation.leaseId),/lost commit/u);
    assert.equal((await store.load(x.reservation.leaseId))?.revision,2);
    await x.stop(); await x.finishRun(); await assert.rejects(uncertain.release(x.reservation.leaseId),/lost commit/u);
    assert.equal((await store.release(x.reservation.leaseId)).revision,3);
    assert.equal((await pool.query("SELECT 1 FROM acp.filesystem_writer_releases WHERE lease_id=$1",[x.reservation.leaseId])).rowCount,1);
  });
  await check("durable cancellation intent denies renewal without releasing an unsealed writer",async () => {
    const x = await fixture(); await store.reserve(x.reservation);
    await f.workers.recordWorkerProcessFromRun(x.registration);
    const execution = createStableId("workflowExecution"), dbosWorkflowId = `writer-cancel:${x.a.missionId}`;
    const run = (await pool.query(`INSERT INTO acp.mission_workflow_runs(workflow_execution_id,mission_id,dbos_workflow_id,
      workflow_id,workflow_version,workflow_binding_id,dbos_application_version,graph_revision,state,provenance_id,transition_provenance_id)
      SELECT $1,mission_id,$2,workflow_id,workflow_version,workflow_binding_id,$3,'launch-recovery-check','running',$4,$4
      FROM acp.missions WHERE mission_id=$5 RETURNING workflow_version`,
    [execution,dbosWorkflowId,f.runtime.applicationVersion,f.template,x.a.missionId])).rows[0];
    await new PostgresRuntimeStore(pool).recordWorkflowCancellationIntent({ target: { workflowExecutionId: execution,dbosWorkflowId,
      missionId: x.a.missionId,workflowVersion: run.workflow_version as string,graphRevision: "launch-recovery-check",provenanceId: f.template },
      eventId: createStableId("event"),idempotencyKey: `writer-cancel:${execution}`,reason: "Synthetic cancellation.",
      requestedBy: "test:operator",occurredAt: new Date().toISOString() });
    assert.equal((await store.load(x.reservation.leaseId))?.state,"recovering");
    await assert.rejects(store.heartbeat(x.reservation.leaseId),/exact live delivery/u);
    await assert.rejects(store.release(x.reservation.leaseId),/stopped terminal run/u);
    const y = await fixture({ repo: x.repo }); await assert.rejects(store.reserve(y.reservation),/duplicate key/u);
    await x.finishOwner(); await x.finishRun(); assert.equal((await store.release(x.reservation.leaseId)).state,"released");
  });
  await check("admission and renewal wait for concurrent retirement and then fail closed",async () => {
    for (const renewing of [false,true]) {
      const x = await fixture(); if (renewing) await store.reserve(x.reservation);
      const client = await pool.connect(); let pending: Promise<unknown> | undefined;
      try {
        const actor = await provenance(); await client.query("BEGIN");
        const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
        await client.query(`INSERT INTO acp.worktree_binding_retirements(worktree_binding_id,host_identifier,owner_session_id,application_version,provenance_id,reason)
          VALUES($1,$2,$3,$4,$5,'Concurrent retirement.')`,[x.tree.worktreeBindingId,f.runtime.hostIdentifier,f.runtime.sessionId,f.runtime.applicationVersion,actor]);
        pending = assert.rejects(renewing ? store.heartbeat(x.reservation.leaseId) : store.reserve(x.reservation),/exact live delivery/u);
        let blocked = false;
        for (let attempt=0; attempt<100; attempt++) {
          blocked = (await pool.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE NOT granted AND $1=ANY(pg_blocking_pids(pid))) AS blocked",[pid])).rows[0].blocked as boolean;
          if (blocked) break;
          await new Promise((done) => setTimeout(done,10));
        }
        assert.equal(blocked,true,"writer must wait for exact binding retirement lock");
        await client.query("COMMIT"); await pending;
        assert.equal((await store.load(x.reservation.leaseId))?.revision,renewing ? 1 : undefined);
      } finally { await client.query("ROLLBACK"); client.release(); if (pending) await pending; }
    }
  });
  await check("deferred checks roll back admission, renewal and release if authority ends before commit",async () => {
    const x = await fixture(), denied = intercepted("close_before_commit");
    await assert.rejects(denied.reserve(x.reservation),/authority ended before commit/u);
    assert.equal(await store.load(x.reservation.leaseId),undefined);
    await store.reserve(x.reservation); await assert.rejects(denied.heartbeat(x.reservation.leaseId),/authority ended before commit/u);
    assert.equal((await store.load(x.reservation.leaseId))?.revision,1);
    await x.stop(); await x.finishRun(); await assert.rejects(denied.release(x.reservation.leaseId),/authority ended before commit/u);
    assert.equal((await store.load(x.reservation.leaseId))?.releasedAt,null);
    await store.release(x.reservation.leaseId);
  });
  await check("release receipt and owner identities cannot be forged or removed and populated downgrade refuses",async () => {
    const x = await fixture(); await store.reserve(x.reservation);
    await assert.rejects(pool.query("UPDATE acp.filesystem_writer_leases SET released_at=clock_timestamp() WHERE lease_id=$1",[x.reservation.leaseId]),/exact durable receipt/u);
    await assert.rejects(pool.query("UPDATE acp.filesystem_writer_leases SET branch_key='forged' WHERE lease_id=$1",[x.reservation.leaseId]),/immutable/u);
    await assert.rejects(pool.query(`INSERT INTO acp.filesystem_writer_releases(lease_id,run_id,host_identifier,owner_session_id,application_version,provenance_id)
      VALUES($1,$2,$3,$4,$5,$6)`,[x.reservation.leaseId,x.start.runId,f.runtime.hostIdentifier,f.runtime.sessionId,f.runtime.applicationVersion,x.a.packetProvenanceId]),/terminal run, sealed stop/u);
    for (const table of ["filesystem_writer_leases","filesystem_writer_releases"]) {
      await assert.rejects(pool.query(`DELETE FROM acp.${table}`),/append-only/u);
      await assert.rejects(pool.query(`TRUNCATE acp.${table} CASCADE`),/append-only/u);
    }
    await assert.rejects(pool.query("UPDATE acp.filesystem_writer_releases SET released_at=released_at"),/append-only/u);
    const client = await pool.connect();
    try { await client.query("BEGIN"); await assert.rejects(client.query(await readFile(new URL("../../migrations/0014_filesystem_writer_leases.down.sql",import.meta.url),"utf8")),/retained filesystem writer history/u); }
    finally { await client.query("ROLLBACK"); client.release(); }
  });
  await check("replacement sessions cannot renew old owners but can release terminal sealed ownership with fresh provenance",async () => {
    const x = await fixture(), y = await fixture(); await store.reserve(x.reservation); await store.reserve(y.reservation);
    await x.stop(); await x.finishRun(); const old = store;
    await f.replaceOwner(); store = new PostgresFilesystemWriterStore(pool,f.runtime); registry = new PostgresRepositoryBindingStore(pool,f.runtime);
    await assert.rejects(old.heartbeat(y.reservation.leaseId),/exact live delivery/u);
    await assert.rejects(store.heartbeat(y.reservation.leaseId),/unreleased owner/u);
    await assert.rejects(old.release(x.reservation.leaseId),/current runtime/u);
    const released = await store.release(x.reservation.leaseId); assert.equal(released.state,"released");
    const receipt = (await pool.query("SELECT * FROM acp.filesystem_writer_releases WHERE lease_id=$1",[x.reservation.leaseId])).rows[0];
    assert.equal(receipt.owner_session_id,f.runtime.sessionId); assert.notEqual(receipt.provenance_id,x.a.packetProvenanceId);
    assert.equal((await old.release(x.reservation.leaseId)).state,"released"); // Read-only history.
    assert.equal((await store.load(y.reservation.leaseId))?.state,"recovering");
    const otherHost = new PostgresFilesystemWriterStore(pool,{ ...f.runtime,hostIdentifier: "host:other-writer" });
    assert.equal(await otherHost.load(x.reservation.leaseId),undefined);
    await assert.rejects(otherHost.release(x.reservation.leaseId),/not found on this host/u);
  });
  await check("bounded keyset recovery inventory is host-scoped, complete, duplicate-free and read-only",async () => {
    const terminal = await fixture(), awaiting = await fixture(), unsealed = await fixture(), healthy = await fixture();
    for (const x of [terminal,awaiting,unsealed,healthy]) await store.reserve(x.reservation);
    await terminal.stop(); await terminal.finishRun(); await awaiting.stop(); await unsealed.handoff();
    const before = (await pool.query("SELECT count(*)::int AS count,sum(revision)::int AS revision FROM acp.filesystem_writer_leases")).rows[0];
    const found = new Map<string,string>(); let afterLeaseId: typeof terminal.reservation.leaseId | undefined;
    for (let pageNumber=0; pageNumber<50; pageNumber++) {
      const page = await store.listRecovery({ limit: 1,...(afterLeaseId === undefined ? {} : { afterLeaseId }) });
      assert.ok(page.items.length<=1);
      for (const item of page.items) {
        assert.equal(item.lease.hostIdentifier,f.runtime.hostIdentifier); assert.equal(item.lease.state,"recovering");
        assert.equal(found.has(item.lease.leaseId),false); found.set(item.lease.leaseId,item.condition);
      }
      if (page.nextCursor === undefined) break;
      if (afterLeaseId !== undefined) assert.ok(page.nextCursor>afterLeaseId);
      afterLeaseId = page.nextCursor;
      assert.ok(pageNumber<49,"bounded fixture inventory must finish");
    }
    assert.equal(found.get(terminal.reservation.leaseId),"sealed_terminal");
    assert.equal(found.get(awaiting.reservation.leaseId),"awaiting_run_result");
    assert.equal(found.get(unsealed.reservation.leaseId),"needs_launch_stop");
    assert.equal(found.has(healthy.reservation.leaseId),false);
    const expected = (await pool.query("SELECT lease_id FROM acp.filesystem_writer_lease_status WHERE host_identifier=$1 AND state='recovering' ORDER BY lease_id",[f.runtime.hostIdentifier])).rows;
    assert.deepEqual([...found.keys()],expected.map((r) => r.lease_id));
    assert.deepEqual((await pool.query("SELECT count(*)::int AS count,sum(revision)::int AS revision FROM acp.filesystem_writer_leases")).rows[0],before);
    const otherHost = new PostgresFilesystemWriterStore(pool,{ ...f.runtime,hostIdentifier: "host:other-writer" });
    assert.deepEqual(await otherHost.listRecovery(),{ items: [] });
    await store.release(terminal.reservation.leaseId);
    assert.equal((await store.listRecovery({ limit: 100 })).items.some((item) => item.lease.leaseId===terminal.reservation.leaseId),false);
  });
  await check("cooperative guard serially renews real ownership and quiesces before stop/result/release",async () => {
    const x=await fixture(); await store.reserve(x.reservation);
    let calls=0,validated!: () => void;
    const validation=new Promise<void>((done) => { validated=done; });
    const guard=new FilesystemWriterGuard({ authority:store.authority,load:(id) => store.load(id),async heartbeat(id) {
      const value=await store.heartbeat(id); if (++calls===3) validated(); return value;
    } },{ renewalIntervalMs:20 });
    assert.deepEqual(await guard.run(x.reservation.leaseId,new AbortController().signal,async () => {
      await validation; return "synthetic local validation";
    }),{ state:"completed",value:"synthetic local validation" });
    assert.equal(calls,4); assert.equal((await store.load(x.reservation.leaseId))?.revision,5);
    assert.equal((await store.load(x.reservation.leaseId))?.releasedAt,null);
    await x.stop(); assert.equal((await store.load(x.reservation.leaseId))?.state,"recovering");
    await assert.rejects(store.release(x.reservation.leaseId),/stopped terminal run/u);
    await x.finishRun(); assert.equal((await store.release(x.reservation.leaseId)).state,"released");
  });
  await check("guard loses authority after an actually committed periodic ACK is lost without releasing exclusion",async () => {
    const x=await fixture(); await store.reserve(x.reservation); const uncertain=intercepted("lost_commit");
    let calls=0,cleaned=false;
    const guard=new FilesystemWriterGuard({ authority:store.authority,load:(id) => store.load(id),heartbeat(id) {
      return ++calls===2 ? uncertain.heartbeat(id) : store.heartbeat(id);
    } },{ renewalIntervalMs:20 });
    assert.deepEqual(await guard.run(x.reservation.leaseId,new AbortController().signal,async ({ signal }) => {
      await new Promise<void>((done) => signal.addEventListener("abort",() => done(),{ once:true }));
      await Promise.resolve(); cleaned=true; return "late output";
    }),{ state:"unconfirmed" });
    assert.equal(cleaned,true); assert.equal(calls,2); assert.equal((await store.load(x.reservation.leaseId))?.revision,3);
    assert.equal((await store.load(x.reservation.leaseId))?.releasedAt,null);
    const y=await fixture({ repo:x.repo }); await assert.rejects(store.reserve(y.reservation),/duplicate key/u);
    await x.stop(); await x.finishRun(); await store.release(x.reservation.leaseId);
  });
  await check("durable handoff aborts a running cooperative guard without inventing stop or terminal proof",async () => {
    const x=await fixture(); await store.reserve(x.reservation);
    const guard=new FilesystemWriterGuard(store,{ renewalIntervalMs:20 });
    assert.deepEqual(await guard.run(x.reservation.leaseId,new AbortController().signal,async ({ signal }) => {
      const aborted=new Promise<void>((done) => signal.addEventListener("abort",() => done(),{ once:true }));
      await x.handoff(); await aborted; return "late output";
    }),{ state:"unconfirmed" });
    assert.equal((await store.load(x.reservation.leaseId))?.state,"recovering");
    assert.equal(await store.loadLaunchBinding(x.reservation.leaseId),undefined);
    for (const table of ["worker_launch_stops","filesystem_writer_releases"]) {
      assert.equal((await pool.query(`SELECT 1 FROM acp.${table} WHERE run_id=$1`,[x.start.runId])).rowCount,0);
    }
    assert.deepEqual((await pool.query("SELECT state,result FROM acp.worker_runs WHERE run_id=$1",[x.start.runId])).rows[0],{ state:"started",result:null });
  });
  await check("a stop receipt inside the scope denies its final ACK rather than widening renewal authority",async () => {
    const x=await fixture(); await store.reserve(x.reservation);
    const guard=new FilesystemWriterGuard(store,{ renewalIntervalMs:5000 });
    assert.deepEqual(await guard.run(x.reservation.leaseId,new AbortController().signal,async () => {
      await x.stop(); return "premature stop receipt";
    }),{ state:"unconfirmed" });
    assert.equal((await store.load(x.reservation.leaseId))?.state,"recovering");
    await assert.rejects(store.release(x.reservation.leaseId),/stopped terminal run/u);
    await x.finishRun(); await store.release(x.reservation.leaseId);
  });
  // This resets the synthetic PID sequence; keep it last because it intentionally
  // retains the same host's old journal history and only tests new reservation.
  await check("new mission profiles can use a retained same-project repository without rewriting its observation",async () => {
    const original = await fixture();
    await f.dispatches.closeRuntime(f.runtime.hostIdentifier,f.runtime.sessionId);
    f = await launchRecoveryFixture(pool,"host:filesystem-writer-check","0014",f.host.provenanceId);
    store = new PostgresFilesystemWriterStore(pool,f.runtime); registry = new PostgresRepositoryBindingStore(pool,f.runtime);
    const x = await fixture({ repo: original.repo });
    const profiles = (await pool.query(`SELECT b.project_profile_id AS repository_profile,w.project_profile_id AS worktree_profile
      FROM acp.worktree_bindings w JOIN acp.repository_bindings b USING(repository_binding_id) WHERE w.worktree_binding_id=$1`,[x.tree.worktreeBindingId])).rows[0];
    assert.notEqual(profiles.repository_profile,profiles.worktree_profile);
    assert.equal(profiles.worktree_profile,x.packet.projectProfile.id);
    assert.equal((await store.reserve(x.reservation)).state,"active");
  });
  process.stdout.write(`Filesystem writer lease integration: ${checks} checks passed.\n`);
  if (process.argv[3] === "native") {
    const { runNativeFilesystemBindings } = await import("./filesystem-native-bindings.ts");
    await runNativeFilesystemBindings(pool,true);
  }
} finally { await pool.end(); }
