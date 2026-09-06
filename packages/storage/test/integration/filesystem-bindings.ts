import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool, type QueryResult, type QueryResultRow } from "pg";
import { createStableId } from "@acp/domain";
import { PostgresRepositoryBindingStore, type RepositoryBindingInput, type WorktreeBindingInput } from "../../src/index.ts";
import { launchRecoveryFixture } from "./launch-recovery-fixture.ts";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("owned database port required");
const pool = new Pool({ connectionString: `postgresql://postgres:acp_test_password@127.0.0.1:${port}/acp_test`, max: 4,
  statement_timeout: 5000, lock_timeout: 3000, connectionTimeoutMillis: 3000 });
let checks = 0, directoryNumber = 0;
const directoryIdentity = () => `win32-dir:12345678:${(++directoryNumber).toString(16).padStart(16,"0")}`;
async function check(name: string, action: () => Promise<void>) { await action(); checks++; process.stdout.write(`PASS filesystem binding: ${name}\n`); }
try {
  const f = await launchRecoveryFixture(pool, "host:filesystem-binding-check", "0013");
  const a = await f.assignment();
  let store = new PostgresRepositoryBindingStore(pool, f.runtime);
  async function provenance() {
    const id = createStableId("provenance");
    await pool.query(`INSERT INTO acp.runtime_provenance SELECT (jsonb_populate_record(NULL::acp.runtime_provenance,to_jsonb(p)
      ||jsonb_build_object('provenance_id',$1::text,'recorded_at',clock_timestamp()))).* FROM acp.runtime_provenance p WHERE provenance_id=$2`, [id,f.template]);
    return id;
  }
  const observedAt = async () => ((await pool.query("SELECT clock_timestamp() AS now")).rows[0].now as Date).toISOString();
  async function repository(): Promise<RepositoryBindingInput> {
    const id = createStableId("repositoryBinding"), actor = await provenance();
    return { repositoryBindingId: id, repositoryId: createStableId("repository"), projectId: a.packet.projectId, machineFingerprint: "a".repeat(64),
      checkout: { path: `C:\\ACP-FS-test\\Repositories\\${id}`, identity: directoryIdentity() },
      commonGitDirectory: { path: `C:\\ACP-FS-test\\Repositories\\${id}\\.git`, identity: directoryIdentity() },
      observedAt: await observedAt(), provenanceId: actor };
  }
  async function worktree(repo: RepositoryBindingInput): Promise<WorktreeBindingInput> {
    const id = createStableId("worktreeBinding"), actor = await provenance();
    return { worktreeBindingId: id, repositoryBindingId: repo.repositoryBindingId, missionId: a.a.missionId,
      workspace: { path: `C:\\ACP-FS-test\\Worktrees\\${id}`, identity: directoryIdentity() },
      gitDirectory: { path: repo.commonGitDirectory.path + `\\worktrees\\${id}`, identity: directoryIdentity() },
      branchRef: "refs/heads/Feature/CaseSensitive", headRevision: "a".repeat(40), observedAt: await observedAt(), provenanceId: actor };
  }
  const repo = await repository(); let tree: WorktreeBindingInput;
  const sessions:{ pid:number;ended:Promise<void>;discard:Error|boolean|undefined }[]=[];
  async function closedSessions(offset:number,count:number) {
    const observed=sessions.slice(offset); assert.equal(observed.length,count);
    assert.ok(observed.every((session)=>session.discard===true));
    await Promise.all(observed.map((session)=>session.ended));
    assert.equal((await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid=ANY($1::integer[])",[observed.map((session)=>session.pid)])).rowCount,0);
  }
  function intercepted(mode: "ok" | "lost_commit" | "close_before_commit" | "killed_insert" | "lost_begin",lockId?:string) {
    return new PostgresRepositoryBindingStore({ options: pool.options, async connect() {
      const client = await pool.connect();
      const session={ pid:Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid),
        ended:new Promise<void>((resolve)=>client.once("end",()=>resolve())),discard:undefined as Error|boolean|undefined };
      sessions.push(session);
      const failed=mode==="killed_insert" ? new Promise<void>((resolve)=>client.once("error",()=>resolve())) : undefined;
      return { on:client.on.bind(client),off:client.off.bind(client),release:(discard?:Error|boolean)=>{
        assert.equal(discard,true); assert.ok(client.listenerCount("error")>0); session.discard=discard; client.release(discard);
      },async query<R extends QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>> {
        if(text==="ROLLBACK" && mode==="lost_begin") throw new Error("synthetic unavailable registry rollback acknowledgement");
        if (text === "COMMIT" && mode === "close_before_commit") {
          await client.query("UPDATE acp.worker_host_sessions SET state='closed' WHERE host_identifier=$1", [f.runtime.hostIdentifier]);
        }
        const result = await client.query<R>(text,values);
        if(text==="BEGIN" && mode==="lost_begin") {
          assert.ok(lockId);
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended('acp:filesystem-binding-record:'||$1,0))",[lockId]);
          throw new Error("synthetic lost actual registry BEGIN acknowledgement");
        }
        if(mode==="killed_insert" && /^INSERT INTO acp\.(repository_bindings|worktree_bindings|repository_binding_retirements|worktree_binding_retirements)\(/u.test(text)) {
          assert.equal((await pool.query("SELECT pg_terminate_backend($1) AS stopped",[session.pid])).rows[0].stopped,true);
          await failed;
        }
        if (text === "COMMIT" && mode === "lost_commit") throw new Error("synthetic lost commit acknowledgement");
        return result;
      } };
    } } as unknown as Pool, f.runtime);
  }
  await check("all four registry mutations discard killed post-INSERT sessions without partial observations or retirement",async()=>{
    for(const operation of ["recordRepository","recordWorktree","retireRepository","retireWorktree"] as const) {
      const candidate=await repository();
      if(operation!=="recordRepository") await store.recordRepository(candidate);
      const child=await worktree(candidate),actor=await provenance();
      if(operation==="retireWorktree") await store.recordWorktree(child);
      const offset=sessions.length,killed=intercepted("killed_insert");
      const action=operation==="recordRepository" ? killed.recordRepository(candidate) : operation==="recordWorktree" ? killed.recordWorktree(child)
        : operation==="retireRepository" ? killed.retireRepository(candidate.repositoryBindingId,actor,"Rejected interrupted retirement.")
        : killed.retireWorktree(child.worktreeBindingId,actor,"Rejected interrupted retirement.");
      await assert.rejects(action,/terminating connection|connection terminated/iu); await closedSessions(offset,1);
      const id=operation.endsWith("Repository") ? candidate.repositoryBindingId : child.worktreeBindingId;
      assert.equal((await pool.query("SELECT pg_try_advisory_xact_lock(hashtextextended('acp:filesystem-binding-record:'||$1,0)) AS acquired",[id])).rows[0].acquired,true);
      assert.equal((await store.loadRepository(candidate.repositoryBindingId))?.retired,operation==="recordRepository" ? undefined : false);
      assert.equal((await store.loadWorktree(child.worktreeBindingId))?.retired,operation==="retireWorktree" ? false : undefined);
      assert.equal((await pool.query("SELECT 1 FROM acp.repositories WHERE repository_id=$1",[candidate.repositoryId])).rowCount,operation==="recordRepository" ? 0 : 1);
      assert.equal((await pool.query("SELECT 1 FROM acp.filesystem_directory_reservations WHERE binding_id=$1",[id])).rowCount,operation.startsWith("retire") ? 2 : 0);
    }
  });
  await check("lost actual registry BEGIN response and unavailable rollback close the exact record lock",async()=>{
    const candidate=await repository(),offset=sessions.length;
    await assert.rejects(intercepted("lost_begin",candidate.repositoryBindingId).recordRepository(candidate),/lost actual registry BEGIN/u);
    await closedSessions(offset,1);
    assert.equal((await pool.query("SELECT pg_try_advisory_xact_lock(hashtextextended('acp:filesystem-binding-record:'||$1,0)) AS acquired",[candidate.repositoryBindingId])).rows[0].acquired,true);
    assert.equal(await store.loadRepository(candidate.repositoryBindingId),undefined);
    assert.equal((await pool.query("SELECT 1 FROM acp.repositories WHERE repository_id=$1",[candidate.repositoryId])).rowCount,0);
    assert.equal((await pool.query("SELECT 1 FROM acp.filesystem_directory_reservations WHERE binding_id=$1",[candidate.repositoryBindingId])).rowCount,0);
  });
  await check("exact repository/worktree observations replay without granting or fabricating a writer lease", async () => {
    const offset=sessions.length,tracked=intercepted("ok");
    assert.deepEqual(await tracked.recordRepository(repo), repo); assert.deepEqual(await tracked.recordRepository(repo), repo);
    tree = await worktree(repo); assert.deepEqual(await tracked.recordWorktree(tree), tree); assert.deepEqual(await tracked.recordWorktree(tree), tree);
    await closedSessions(offset,4);
    assert.deepEqual(await store.loadWorktree(tree.worktreeBindingId), { binding: tree, retired: false });
    const row = (await pool.query("SELECT project_id,project_profile_id,project_profile_version FROM acp.worktree_bindings WHERE worktree_binding_id=$1", [tree.worktreeBindingId])).rows[0];
    assert.equal(row.project_id, a.packet.projectId); assert.equal(row.project_profile_id, a.packet.projectProfile.id);
    assert.equal(row.project_profile_version, a.packet.projectProfile.version);
    assert.equal((await pool.query("SELECT 1 FROM acp.resource_leases WHERE mission_id=$1", [a.a.missionId])).rowCount, 0);
    assert.equal((await pool.query("SELECT 1 FROM acp.worker_runs WHERE mission_id=$1", [a.a.missionId])).rowCount, 0);
  });
  await check("successful retirement and historical replay discard their sessions while retaining directory reservations",async()=>{
    const parent=await repository(); await store.recordRepository(parent);
    const child=await worktree(parent); await store.recordWorktree(child);
    const actor=await provenance(),offset=sessions.length,tracked=intercepted("ok");
    await tracked.retireWorktree(child.worktreeBindingId,actor,"Exact child retirement.");
    await tracked.retireWorktree(child.worktreeBindingId,actor,"Exact child retirement.");
    await tracked.retireRepository(parent.repositoryBindingId,actor,"Exact parent retirement.");
    await tracked.retireRepository(parent.repositoryBindingId,actor,"Exact parent retirement.");
    await closedSessions(offset,4);
    assert.equal((await store.loadRepository(parent.repositoryBindingId))?.retired,true);
    assert.equal((await store.loadWorktree(child.worktreeBindingId))?.retired,true);
    assert.equal((await pool.query("SELECT 1 FROM acp.filesystem_directory_reservations WHERE binding_id=ANY($1)",[[parent.repositoryBindingId,child.worktreeBindingId]])).rowCount,4);
  });
  await check("SQL and TypeScript reject slash, traversal, device and stream aliases", async () => {
    for (const path of ["C:\\repo/child", "C:\\repo\\..\\child", "C:\\repo\\.\\child", "C:\\repo\\\\child", "C:\\repo\\", "C:\\NUL", "C:\\repo:stream", "C:\\repo."]) {
      assert.equal((await pool.query("SELECT acp.canonical_windows_binding_path($1) AS valid", [path])).rows[0].valid, false, path);
    }
    const invalid = await repository();
    await pool.query("INSERT INTO acp.repositories(repository_id,project_id,provenance_id) VALUES($1,$2,$3)", [invalid.repositoryId,invalid.projectId,invalid.provenanceId]);
    await assert.rejects(pool.query(`INSERT INTO acp.repository_bindings(repository_binding_id,repository_id,project_id,host_identifier,
      owner_session_id,application_version,machine_fingerprint,checkout_path,checkout_identity,common_git_directory_path,common_git_directory_identity,
      observed_at,provenance_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [invalid.repositoryBindingId,invalid.repositoryId,invalid.projectId,f.runtime.hostIdentifier,f.runtime.sessionId,f.runtime.applicationVersion,
      invalid.machineFingerprint,"C:\\repo/child",invalid.checkout.identity,invalid.commonGitDirectory.path,invalid.commonGitDirectory.identity,invalid.observedAt,invalid.provenanceId]), /check constraint/u);
  });
  await check("physical aliases, nested workspaces and cross-role directory collisions cannot create independent targets", async () => {
    const alias = await repository();
    await assert.rejects(store.recordRepository({ ...alias, commonGitDirectory: { ...alias.commonGitDirectory, identity: repo.commonGitDirectory.identity } }), /duplicate key/u);
    assert.equal((await pool.query("SELECT 1 FROM acp.repositories WHERE repository_id=$1", [alias.repositoryId])).rowCount, 0);
    await assert.rejects(store.recordRepository({ ...await repository(), checkout: { path: repo.checkout.path.toLowerCase(), identity: directoryIdentity() } }), /duplicate key/u);
    await assert.rejects(store.recordRepository({ ...await repository(), checkout: tree!.workspace }), /overlaps|duplicate key/u);
    const duplicate = await worktree(repo);
    await assert.rejects(store.recordWorktree({ ...duplicate, workspace: tree!.workspace }), /overlaps|duplicate key/u);
    await assert.rejects(store.recordWorktree({ ...await worktree(repo), workspace: { path: tree!.workspace.path + "\\nested", identity: directoryIdentity() } }), /overlaps/u);
    await assert.rejects(store.recordWorktree({ ...await worktree(repo), workspace: { path: repo.checkout.path + "\\nested", identity: directoryIdentity() } }), /overlaps/u);
    await assert.rejects(store.recordWorktree({ ...await worktree(repo), gitDirectory: { path: "C:\\unrelated\\metadata", identity: directoryIdentity() } }), /linked Git metadata/u);
  });
  await check("concurrent exact records replay but concurrent physical aliases have only one winner", async () => {
    const identical = await repository();
    assert.deepEqual(await Promise.all([store.recordRepository(identical),store.recordRepository(identical)]),[identical,identical]);
    const child = await worktree(repo);
    assert.deepEqual(await Promise.all([store.recordWorktree(child),store.recordWorktree(child)]),[child,child]);
    const left = await repository(), right = { ...await repository(), commonGitDirectory: left.commonGitDirectory };
    const results = await Promise.allSettled([store.recordRepository(left),store.recordRepository(right)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length,1);
    assert.equal(results.filter((r) => r.status === "rejected").length,1);
    assert.equal((await pool.query("SELECT 1 FROM acp.repositories WHERE repository_id=ANY($1)", [[left.repositoryId,right.repositoryId]])).rowCount,1);
  });
  await check("lost commit acknowledgements retain one exact observation and retirement", async () => {
    const offset=sessions.length,recorded = await repository(), losing = intercepted("lost_commit");
    await assert.rejects(losing.recordRepository(recorded), /lost commit/u);
    assert.deepEqual(await store.recordRepository(recorded),recorded);
    const child = await worktree(recorded);
    await assert.rejects(losing.recordWorktree(child), /lost commit/u);
    assert.deepEqual(await store.recordWorktree(child),child);
    const actor = await provenance();
    await assert.rejects(losing.retireWorktree(child.worktreeBindingId,actor,"Retained after lost acknowledgement."), /lost commit/u);
    await store.retireWorktree(child.worktreeBindingId,actor,"Retained after lost acknowledgement.");
    assert.equal((await store.loadWorktree(child.worktreeBindingId))?.retired,true);
    await assert.rejects(losing.retireRepository(recorded.repositoryBindingId,actor,"Repository retirement after lost acknowledgement."),/lost commit/u);
    await store.retireRepository(recorded.repositoryBindingId,actor,"Repository retirement after lost acknowledgement.");
    assert.equal((await store.loadRepository(recorded.repositoryBindingId))?.retired,true);
    assert.equal((await pool.query("SELECT 1 FROM acp.filesystem_directory_reservations WHERE binding_id=ANY($1)", [[recorded.repositoryBindingId,child.worktreeBindingId]])).rowCount,4);
    assert.equal((await pool.query("SELECT 1 FROM acp.repository_binding_retirements WHERE repository_binding_id=$1",[recorded.repositoryBindingId])).rowCount,1);
    assert.equal((await pool.query("SELECT 1 FROM acp.worktree_binding_retirements WHERE worktree_binding_id=$1",[child.worktreeBindingId])).rowCount,1);
    await closedSessions(offset,4);
  });
  await check("authority must remain valid at commit and failed commits release every reservation", async () => {
    const denied = intercepted("close_before_commit"), candidate = await repository(), child = await worktree(repo);
    await assert.rejects(denied.recordRepository(candidate), /authority ended before commit/u);
    assert.equal((await pool.query("SELECT 1 FROM acp.repositories WHERE repository_id=$1",[candidate.repositoryId])).rowCount,0);
    assert.equal(await store.loadRepository(candidate.repositoryBindingId),undefined);
    await assert.rejects(denied.recordWorktree(child), /authority ended before commit/u);
    assert.equal(await store.loadWorktree(child.worktreeBindingId),undefined);
    await assert.rejects(denied.retireRepository(repo.repositoryBindingId,await provenance(),"Rejected at commit."), /authority ended before commit/u);
    await assert.rejects(denied.retireWorktree(tree!.worktreeBindingId,await provenance(),"Rejected at commit."), /authority ended before commit/u);
    assert.equal((await store.loadWorktree(tree!.worktreeBindingId))?.retired,false);
    assert.equal((await pool.query("SELECT 1 FROM acp.filesystem_directory_reservations WHERE binding_id=ANY($1)",[[candidate.repositoryBindingId,child.worktreeBindingId]])).rowCount,0);
    assert.equal((await pool.query("SELECT state FROM acp.worker_host_sessions WHERE host_identifier=$1",[f.runtime.hostIdentifier])).rows[0].state,"active");
  });
  await check("unknown missions, wrong hosts and forged reservations cannot create trusted observations", async () => {
    const wrongHost = new PostgresRepositoryBindingStore(pool,{ ...f.runtime,hostIdentifier:"host:not-this-filesystem" });
    assert.equal(await wrongHost.loadRepository(repo.repositoryBindingId),undefined);
    await assert.rejects(wrongHost.recordRepository(repo),/aliases different/u);
    await assert.rejects(wrongHost.recordWorktree(await worktree(repo)),/exact active repository/u);
    await assert.rejects(store.recordWorktree({ ...await worktree(repo),missionId:createStableId("mission") }),/no rows/u);
    await assert.rejects(pool.query(`INSERT INTO acp.filesystem_directory_reservations(host_identifier,machine_fingerprint,directory_identity,canonical_path,binding_id,role)
      VALUES($1,$2,$3,$4,$5,'workspace')`,[f.runtime.hostIdentifier,repo.machineFingerprint,directoryIdentity(),"C:\\forged",tree!.worktreeBindingId]),/exact persisted binding/u);
  });
  await check("observation identity, project scope, freshness and retirement evidence fail closed", async () => {
    await assert.rejects(store.recordRepository({ ...repo, checkout: { ...repo.checkout, path: "C:\\different" } }), /aliases different/u);
    await assert.rejects(store.recordWorktree({ ...tree!, headRevision: "b".repeat(40) }), /aliases different/u);
    await assert.rejects(store.recordRepository({ ...await repository(), observedAt: "2099-01-01T00:00:00.000Z" }), /fresh observation/u);
    await assert.rejects(store.recordRepository({ ...await repository(), observedAt: "2000-01-01T00:00:00.000Z" }), /fresh observation/u);
    const wrong = await repository(), project = createStableId("project");
    await pool.query("INSERT INTO acp.projects(project_id,display_name) VALUES($1,'Other synthetic project')", [project]);
    await assert.rejects(store.recordRepository({ ...wrong, projectId: project }), /exact project provenance/u);
    const retired = await worktree(repo); await store.recordWorktree(retired);
    const actor = await provenance(); await store.retireWorktree(retired.worktreeBindingId,actor,"No further use.");
    await store.retireWorktree(retired.worktreeBindingId,actor,"No further use.");
    assert.equal((await store.loadWorktree(retired.worktreeBindingId))?.retired, true);
    await assert.rejects(store.retireWorktree(retired.worktreeBindingId,actor,"Different reason."), /aliases different/u);
  });
  await check("binding and reservation history is append-only and prevents lossy downgrade", async () => {
    for (const [table,key] of [["repositories","repository_id"],["repository_bindings","repository_binding_id"],["worktree_bindings","worktree_binding_id"],
      ["filesystem_directory_reservations","binding_id"],["repository_binding_retirements","repository_binding_id"],["worktree_binding_retirements","worktree_binding_id"]]) {
      await assert.rejects(pool.query(`UPDATE acp.${table} SET ${key}=${key}`), /append-only/u);
      await assert.rejects(pool.query(`DELETE FROM acp.${table}`), /append-only/u);
      await assert.rejects(pool.query(`TRUNCATE acp.${table} CASCADE`), /append-only/u);
    }
    const client = await pool.connect();
    try { await client.query("BEGIN"); await assert.rejects(client.query(await readFile(new URL("../../migrations/0013_filesystem_bindings.down.sql",import.meta.url),"utf8")), /retained repository identity history/u); }
    finally { await client.query("ROLLBACK"); client.release(); }
  });
  await check("same-template session replacement rejects old provenance and parent retirement denies new children", async () => {
    const stale = await repository(); await f.replaceOwner(); store = new PostgresRepositoryBindingStore(pool,f.runtime);
    await assert.rejects(store.recordRepository(stale), /current host provenance/u);
    const fresh = await repository(); await store.recordRepository(fresh);
    await store.retireRepository(repo.repositoryBindingId,await provenance(),"Repository no longer selected.");
    assert.equal((await store.loadRepository(repo.repositoryBindingId))?.retired,true);
    assert.equal((await store.loadWorktree(tree!.worktreeBindingId))?.retired,true);
    await assert.rejects(store.recordWorktree(await worktree(repo)), /active repository/u);
    assert.deepEqual(await store.recordRepository(repo),repo); // Historical exact read, not new authority.
  });
  process.stdout.write(`Filesystem binding integration: ${checks} checks passed.\n`);
  if (process.argv[3] === "native") {
    const { runNativeFilesystemBindings } = await import("./filesystem-native-bindings.ts");
    await runNativeFilesystemBindings(pool);
  }
} finally { await pool.end(); }
