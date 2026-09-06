import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { createStableId, parseCanonicalTimestamp } from "@acp/domain";
import { PostgresRepositoryBindingStore, PostgresWorktreeReservationStore, PostgresWorktreeProvisionerStore,
  PostgresProvisionerAdmissionStore, PostgresProvisionerJournalStore, type WorktreeProvisionerAttempt } from "@acp/storage";
import { launchRecoveryFixture } from "../../../../packages/storage/test/integration/launch-recovery-fixture.ts";
import { NativeProvisionerExecutor } from "../../src/native-provisioner-executor.ts";
import { snapshotNativeProvisionerPlan } from "../../src/native-provisioner-plan.ts";
import { WindowsProvisionerProcessRunner } from "../../src/windows-provisioner-runner.ts";
import type { OwnedProvisionerHandle } from "../../src/windows-provisioner-process.ts";
import { describeWindowsProvisionerFence } from "../../src/windows-launch-fence.ts";
import { StoppedProvisionerWorktreeVerifier, windowsStoppedProvisionerWorktreeObserver } from "../../src/stopped-provisioner-worktree-verifier.ts";
import { provisionerFixture, metadataSnapshot } from "./provisioner-observation-fixture.ts";
import { gone } from "./native-lease-probe.ts";

const port = Number(process.argv[2]), powershell = process.env.ACP_TEST_PWSH;
assert.ok(process.platform === "win32" && Number.isInteger(port) && port > 1023 && port < 65536);
assert.ok(powershell && isAbsolute(powershell), "outer-owned native fixture and exact PowerShell required");
const configuration = { connectionString: `postgresql://postgres:acp_test_password@127.0.0.1:${port}/acp_test`, max: 4,
  connectionTimeoutMillis: 3000, statement_timeout: 5000, lock_timeout: 2000 };
const pool = new Pool(configuration), readPool = new Pool({ ...configuration, max: 1, options: "-c default_transaction_read_only=on" });
const abort = new AbortController(), pids = new Set<number>(), handles: OwnedProvisionerHandle[] = [], callbackErrors: unknown[] = [];
const report = (pid: number, purpose: string) => { pids.add(pid); process.stdout.write(`Owned PID ${pid}: ${purpose}\n`); };
async function witnessed<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); } catch (error) { callbackErrors.push(error); throw error; }
}
let gitFixture: Awaited<ReturnType<typeof provisionerFixture>> | undefined;
try {
  const g = await provisionerFixture(); gitFixture = g;
  const fenceDirectory = join(g.root, "fence"); await mkdir(fenceDirectory);
  // Test setup creates this worktree BEFORE the plan/capsule. The provisioner
  // only echoes its plan; no positive result may attribute creation to it.
  await g.git(g.checkout, "worktree", "add", "-b", g.input.branchRef.slice(11), g.input.workspacePath, g.input.baseRevision);
  const metadata = await metadataSnapshot(g.repository.commonGitDirectory.path);
  const f = await launchRecoveryFixture(pool, "host:stopped-provisioner-pg", "0021"), originalRuntime = f.runtime;
  const registry = new PostgresRepositoryBindingStore(pool, originalRuntime), holds = new PostgresWorktreeReservationStore(pool, originalRuntime),
    plans = new PostgresWorktreeProvisionerStore(pool, originalRuntime), journal = new PostgresProvisionerJournalStore(pool, originalRuntime),
    admissions = new PostgresProvisionerAdmissionStore(pool, originalRuntime);
  const assignment = await f.assignment(undefined, g.input.workspacePath, true), reservationId = createStableId("worktreeReservation");
  const repository = { ...g.repository, projectId: assignment.packet.projectId, provenanceId: assignment.a.packetProvenanceId };
  await registry.recordRepository(repository);
  await holds.reserve({ reservationId, repositoryBindingId: repository.repositoryBindingId, missionId: assignment.a.missionId,
    nodeId: assignment.a.nodeId, graphRevision: "launch-recovery-check", workspacePath: g.input.workspacePath,
    branchRef: g.input.branchRef, provenanceId: assignment.a.packetProvenanceId });
  const native = new WindowsProvisionerProcessRunner(plans.authority, {
    runnerPath: fileURLToPath(new URL("./synthetic-provisioner-plan-runner.ts", import.meta.url)), powershellExecutable: powershell, onSpawn: report,
  });
  let physicallyClosed = false, accepted = 0, go = 0, stops = 0, plan: WorktreeProvisionerAttempt;
  const executor = new NativeProvisionerExecutor(plans, admissions, { authority: journal.authority, async recordStop(value) {
    return witnessed(async () => {
      assert.equal(physicallyClosed, true, "original physical close precedes durable stop"); stops++;
      for (const pid of pids) await gone(pid, 5000);
      assert.match(await readFile(join(fenceDirectory, plan.attemptId + ".provision"), "utf8"), /\nsealed\n$/u);
      return journal.recordStop(value);
    });
  } }, { authority: native.authority, async start(value, signal) {
    return witnessed(async () => {
      const handle = await native.start(value, signal); handles.push(handle);
      void handle.closed.then(() => { physicallyClosed = true; }, () => {});
      const ready = handle.ready.then(session => ({ ...session, async acceptAdmission(ack) {
        return witnessed(async () => {
          const rows = await pool.query(`SELECT p.root_process_id=$2 AND p.root_process_start_token=$3
            AND p.supervision_scope=c.supervision_scope AND a.challenge_nonce=$4 AND a.challenge_epoch=1
            AND c.owner_kind='provisioner' AND c.process_id=p.root_process_id
            AND c.process_start_token=p.root_process_start_token AS exact
            FROM acp.worktree_provisioner_processes p JOIN acp.worktree_provisioner_admissions a USING(attempt_id)
            JOIN acp.windows_native_root_claims c ON c.owner_id=p.attempt_id WHERE p.attempt_id=$1`,
          [value.attemptId, session.request.root.processId, session.request.root.processStartToken, session.request.challenge.nonce]);
          assert.equal(rows.rows[0]?.exact, true, "exact committed admission and root claim before native acceptance");
          accepted++; return session.acceptAdmission(ack);
        });
      }, go() { go++; session.go(); } }));
      void ready.catch(() => {}); return { ...handle, ready };
    });
  } });
  const parent = await describeWindowsProvisionerFence(g.parent, abort.signal, { onSpawn: report });
  const hold = await holds.heartbeat(reservationId);
  const times = (await pool.query(`SELECT to_jsonb(clock_timestamp()) AS at,
    to_jsonb(least(clock_timestamp()+interval '18 seconds',expires_at-interval '500 milliseconds')) AS deadline
    FROM acp.worktree_reservations WHERE reservation_id=$1`, [reservationId])).rows[0];
  plan = snapshotNativeProvisionerPlan(await plans.plan({ attemptId: createStableId("worktreeProvisionerAttempt"), reservationId,
    reservationRevision: hold.revision, baseRevision: g.input.baseRevision,
    reportedParent: { path: g.parent, identity: parent.directoryIdentity, observedAt: times.at as string },
    fencePlan: { namespace: "acp-worktree-provisioner-v1", directory: fenceDirectory }, deadlineAt: times.deadline as string }));
  const result = await executor.run({ attemptId: plan.attemptId, signal: abort.signal });
  assert.deepEqual(callbackErrors, []); assert.equal(result.state, "stop_recorded");
  assert.equal(result.authorityLost, false); assert.equal(result.goAttempted, true);
  assert.equal(accepted, 1); assert.equal(go, 1); assert.equal(stops, 1); assert.equal(physicallyClosed, true);
  const actualStop = await handles[0]!.closed;
  assert.equal(actualStop.observation.state, "terminated");
  assert.equal("exitCode" in actualStop.observation && actualStop.observation.exitCode, 0);
  assert.deepEqual(result.state === "stop_recorded" && result.stop.observation, actualStop.observation);
  assert.deepEqual(await metadataSnapshot(g.repository.commonGitDirectory.path), metadata, "echo capsule changed no Git metadata");

  await registry.retireRepository(repository.repositoryBindingId, assignment.a.packetProvenanceId, "Disposable historical verification fixture.");
  await f.dispatches.closeRuntime(originalRuntime.hostIdentifier, originalRuntime.sessionId);
  assert.equal((await pool.query("SELECT state FROM acp.worker_host_sessions WHERE session_id=$1", [originalRuntime.sessionId])).rows[0]?.state, "closed");
  await f.replaceOwner();
  assert.notEqual(f.runtime.sessionId, originalRuntime.sessionId);
  assert.equal(f.runtime.hostIdentifier, originalRuntime.hostIdentifier);
  // The current head is replaced; immutable session history, not a second closed
  // head row, retains the original identity after replacement.
  assert.equal((await pool.query("SELECT 1 FROM acp.worker_host_session_history WHERE session_id=$1", [originalRuntime.sessionId])).rowCount, 1);
  assert.equal((await pool.query("SELECT 1 FROM acp.worker_host_sessions WHERE session_id=$1", [originalRuntime.sessionId])).rowCount, 0);
  assert.equal((await pool.query("SELECT state FROM acp.worker_host_sessions WHERE session_id=$1", [f.runtime.sessionId])).rows[0]?.state, "active");
  assert.equal((await readPool.query("SHOW transaction_read_only")).rows[0]?.transaction_read_only, "on");
  const readPlans = new PostgresWorktreeProvisionerStore(readPool, f.runtime), readJournal = new PostgresProvisionerJournalStore(readPool, f.runtime),
    readRegistry = new PostgresRepositoryBindingStore(readPool, f.runtime), reader = windowsStoppedProvisionerWorktreeObserver({ ...g.options, onSpawn: report });
  const historicalPlan = snapshotNativeProvisionerPlan(await readPlans.load(plan.attemptId)), retainedJournal = await readJournal.load(plan.attemptId);
  assert.equal(historicalPlan.state, "recovering"); assert.equal(retainedJournal?.state, "stop_recorded");
  let observations = 0;
  const verifier = new StoppedProvisionerWorktreeVerifier(readPlans, readJournal, readRegistry, { async observe(...args) {
    return witnessed(async () => {
      observations++; assert.equal(physicallyClosed, true); assert.ok(stops === 1);
      assert.equal((await readPool.query("SHOW transaction_read_only")).rows[0]?.transaction_read_only, "on");
      return reader.observe(...args);
    });
  } });
  async function retainedState() {
    const data: Record<string, unknown> = {};
    for (const [table, key, value] of [
      ["worktree_provisioner_attempts", "attempt_id", plan.attemptId], ["worktree_provisioner_processes", "attempt_id", plan.attemptId],
      ["worktree_provisioner_admissions", "attempt_id", plan.attemptId], ["worktree_provisioner_stops", "attempt_id", plan.attemptId],
      ["windows_native_root_claims", "owner_id", plan.attemptId], ["worktree_reservations", "reservation_id", reservationId],
      ["filesystem_exclusion_keys", "reservation_id", reservationId], ["worktree_bindings", "mission_id", plan.missionId],
      ["worker_runs", "mission_id", plan.missionId], ["mission_events", "mission_id", plan.missionId],
      ["repository_bindings", "repository_binding_id", repository.repositoryBindingId],
      ["repository_binding_retirements", "repository_binding_id", repository.repositoryBindingId],
    ] as const) {
      const rows = (await pool.query(`SELECT to_jsonb(r) AS row FROM acp.${table} r WHERE ${key}=$1 ORDER BY to_jsonb(r)::text`, [value])).rows;
      assert.ok(rows.length < 50); data[table] = rows.map(row => row.row);
    }
    return data;
  }
  const before = await retainedState();
  for (const name of ["worktree_provisioner_attempts", "worktree_provisioner_processes", "worktree_provisioner_admissions", "worktree_provisioner_stops",
    "windows_native_root_claims", "worktree_reservations", "repository_binding_retirements"]) assert.equal((before[name] as unknown[]).length, 1);
  assert.equal((before.filesystem_exclusion_keys as unknown[]).length, 4);
  assert.deepEqual(before.worktree_bindings, []); assert.deepEqual(before.worker_runs, []);
  const observed = await verifier.verify({ attemptId: plan.attemptId, signal: abort.signal });
  assert.deepEqual(callbackErrors, []); assert.equal(observed.state, "observed");
  if (observed.state !== "observed") assert.fail("real retained PostgreSQL/native observation unavailable");
  assert.equal(observed.scope, "observation_only"); assert.equal(observed.kind, "stopped_provisioner_worktree");
  assert.deepEqual(Object.keys(observed).sort(), ["attempt", "kind", "repository", "scope", "state", "stop", "worktree"]);
  assert.deepEqual(observed.attempt, historicalPlan); assert.ok(retainedJournal?.stop);
  assert.deepEqual(observed.stop, { ...retainedJournal.stop, recordedAt: parseCanonicalTimestamp(retainedJournal.stop.recordedAt) });
  assert.equal(observed.stop.ownerSessionId, originalRuntime.sessionId); assert.equal(observed.repository.retired, true);
  assert.deepEqual(observed.repository.binding, repository);
  assert.deepEqual(observed.worktree.parent, { path: g.parent, identity: parent.directoryIdentity });
  assert.deepEqual(observed.worktree.checkout, repository.checkout); assert.deepEqual(observed.worktree.commonGitDirectory, repository.commonGitDirectory);
  assert.equal(observed.worktree.workspace.path, plan.workspacePath); assert.equal(observed.worktree.branchRef, plan.branchRef);
  assert.equal(observed.worktree.headRevision, plan.baseRevision); assert.ok(Object.isFrozen(observed.worktree));
  assert.equal(observations, 1);
  assert.deepEqual(await verifier.verify({ attemptId: createStableId("worktreeProvisionerAttempt"), signal: abort.signal }), { state: "unconfirmed" });
  assert.equal(observations, 1, "unknown database attempt cannot invoke native reads");
  assert.deepEqual(await retainedState(), before, "verification must not mutate retained lifecycle or exclusion history");
  assert.deepEqual(await metadataSnapshot(g.repository.commonGitDirectory.path), metadata);
  process.stdout.write("PASS real PostgreSQL stopped-worktree observation: retired original owner, replacement read-only session, exact native metadata; all retained exclusion unchanged.\n");
} finally {
  abort.abort(); await Promise.allSettled(handles.map(handle => handle.terminate()));
  try { for (const pid of pids) await gone(pid, 5000); await gitFixture?.dispose(); }
  finally { await Promise.all([pool.end(), readPool.end()]); }
}
