import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventEmitter } from "node:events";

import {
  contextPacketSchemaVersion,
  createContextPacket,
  createStableId,
  createWorkerResult,
  workerResultOutputSchemaId,
  workerResultSchemaVersion,
  type ContextPacket,
} from "@acp/domain";
import type { QueryResult, QueryResultRow } from "pg";

import type { ConnectionPool, TransactionClient } from "../src/database.ts";
import { PostgresWorkerRuntimeStore } from "../src/worker-runtime-store.ts";

type Response =
  | { readonly rows?: readonly QueryResultRow[]; readonly rowCount?: number }
  | Error;

class ScriptedPool extends EventEmitter implements ConnectionPool, TransactionClient {
  readonly queries: { readonly text: string; readonly values: readonly unknown[] }[] = [];
  private readonly responses: Response[];

  constructor(responses: Response[]) {
    super();
    this.responses = responses;
  }

  async connect(): Promise<TransactionClient> {
    return this;
  }

  releasedBroken = false;
  release(broken?: boolean | Error): void { this.releasedBroken = Boolean(broken); }

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<R>> {
    this.queries.push({ text, values });
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
      return queryResult<R>([]);
    }
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    if (response === undefined) throw new Error(`No scripted response for ${text}`);
    return queryResult<R>((response.rows ?? []) as readonly R[], response.rowCount);
  }
}

describe("PostgresWorkerRuntimeStore", () => {
  it("registers and heartbeats a host with database time", async () => {
    const heartbeatAt = new Date("2026-09-04T12:00:00.000Z");
    const pool = new ScriptedPool([
      { rows: [{ host_identifier: "host:test" }], rowCount: 1 },
      { rows: [{ heartbeat_at: heartbeatAt }], rowCount: 1 },
    ]);
    const store = new PostgresWorkerRuntimeStore(pool);
    const provenanceId = createStableId("provenance");

    await store.registerHost({
      hostIdentifier: "host:test",
      hostKind: "operator_laptop",
      state: "active",
      maximumCpuIntensive: 1,
      maximumModerateCompute: 2,
      maximumLightweightRead: 4,
      maximumNetworkBound: 3,
      heartbeatTtlSeconds: 60,
      provenanceId,
      transitionProvenanceId: provenanceId,
    });
    assert.equal(
      await store.heartbeatHost("host:test", provenanceId),
      heartbeatAt.toISOString(),
    );
    assert.match(pool.queries[0]?.text ?? "", /ON CONFLICT \(host_identifier\)/u);
    assert.match(pool.queries[0]?.text ?? "", /statement_timestamp\(\)/u);
    assert.match(pool.queries[1]?.text ?? "", /state <> 'offline'/u);
  });

  it("lists only live hosts with remaining class capacity", async () => {
    const pool = new ScriptedPool([{ rows: [{
      host_identifier: "host:vps",
      host_kind: "vps",
      resource_class: "cpu_intensive",
      capacity: 2,
      active_runs: "1",
      heartbeat_at: new Date("2026-09-04T12:00:00.000Z"),
    }] }]);
    const store = new PostgresWorkerRuntimeStore(pool);

    const hosts = await store.listAvailableHosts("cpu_intensive");

    assert.deepEqual(hosts, [{
      hostIdentifier: "host:vps",
      hostKind: "vps",
      resourceClass: "cpu_intensive",
      capacity: 2,
      activeRuns: 1,
      availableSlots: 1,
      heartbeatAt: "2026-09-04T12:00:00.000Z",
    }]);
    assert.match(pool.queries[0]?.text ?? "", /heartbeat_ttl_seconds/u);
    assert.match(pool.queries[0]?.text ?? "", /usage\.active_runs < capacity\.value/u);
  });

  it("rejects a tampered packet before database access", async () => {
    const packet = packetFor();
    const pool = new ScriptedPool([]);
    const store = new PostgresWorkerRuntimeStore(pool);

    await assert.rejects(
      store.recordContextPacket({
        packet: { ...packet, nextAction: "Tampered." },
        provenanceId: createStableId("provenance"),
      }),
      /digest does not match/,
    );
    assert.equal(pool.queries.length, 0);
  });

  it("persists the exact capability request and server-timed run start", async () => {
    const packet = packetFor();
    const startedAt = new Date("2026-09-04T12:00:00.000Z");
    const timeoutAt = new Date("2026-09-04T12:05:00.000Z");
    const runId = createStableId("run");
    const pool = new ScriptedPool([{ rows: [{
      run_id: runId,
      started_at: startedAt,
      timeout_at: timeoutAt,
    }] }]);
    const store = new PostgresWorkerRuntimeStore(pool);

    const started = await store.startRun({
      runId,
      packet,
      attemptNumber: 1,
      request: {
        missionId: packet.missionId,
        nodeId: packet.nodeId,
        projectId: packet.projectId,
        role: packet.workerRole,
        resourceClass: "lightweight_read",
        operation: "repository.inspect",
        resource: "repository:acp",
        mode: "read",
        workspace: "C:/workspace/acp",
        networkAccess: "none",
        at: startedAt.toISOString(),
      },
      hostIdentifier: "host:test",
      resourceClass: "lightweight_read",
      wallTimeMs: 300_000,
      provenanceId: createStableId("provenance"),
    });

    assert.equal(started.startedAt, startedAt.toISOString());
    assert.match(pool.queries[0]?.text ?? "", /statement_timestamp\(\)/u);
    assert.deepEqual(pool.queries[0]?.values.slice(8, 14), [
      "lightweight_read",
      "repository.inspect",
      "repository:acp",
      "read",
      "C:/workspace/acp",
      null,
    ]);
    assert.equal(pool.queries[0]?.values[14], 300_000);
  });

  it("persists a terminal result transactionally", async () => {
    const packet = packetFor();
    const runId = createStableId("run");
    const result = createWorkerResult({
      schemaVersion: workerResultSchemaVersion,
      runId,
      missionId: packet.missionId,
      nodeId: packet.nodeId,
      projectId: packet.projectId,
      contextPacketId: packet.contextPacketId,
      contextPacketDigest: packet.digest,
      attemptNumber: 1,
      workerRole: packet.workerRole,
      status: "succeeded",
      conclusion: "Inspection completed.",
      evidenceIds: [],
      claimsProduced: [],
      challengedClaimIds: [],
      artifactIds: [],
      findings: [],
      proposedEffects: [],
      risks: [],
      unresolvedQuestions: [],
      suggestedNextNodeTypes: [],
      resourceUsage: { wallMilliseconds: 10, outputBytes: 100 },
      modelUsage: { inputTokens: 20, outputTokens: 5, cachedInputTokens: 0 },
    });
    const pool = new ScriptedPool([{ rows: [{ mission_id: packet.missionId }] }, { rows: [{ node_id: packet.nodeId }] },
      { rows: [{ run_id: runId }], rowCount: 1 }]);
    const store = new PostgresWorkerRuntimeStore(pool);

    assert.equal(await store.completeRun({
      result,
      completedAt: "2026-09-04T12:00:10.000Z",
      transitionProvenanceId: createStableId("provenance"),
    }), true);
    assert.deepEqual(
      pool.queries.map((query) => query.text.trim().split(/\s+/u)[0]),
      ["BEGIN", "SELECT", "SELECT", "UPDATE", "COMMIT"],
    );
  });

  it("journals a worker process from the authoritative active run", async () => {
    const process = processRow();
    const pool = new ScriptedPool([{ rows: [process], rowCount: 1 }]);
    const store = new PostgresWorkerRuntimeStore(pool);

    const recorded = await store.recordWorkerProcessFromRun({
      workerProcessId: process.worker_process_id,
      runId: process.run_id,
      processId: Number(process.process_id),
      processStartToken: process.process_start_token,
      startedAt: process.started_at.toISOString(),
      purpose: process.purpose,
      provenanceId: process.provenance_id,
      transitionProvenanceId: process.transition_provenance_id,
    });

    assert.equal(recorded.deadlineAt, process.deadline_at.toISOString());
    assert.equal(recorded.hostIdentifier, "host:vps");
    assert.match(pool.queries[0]?.text ?? "", /SELECT \$1, run\.run_id/u);
    assert.match(pool.queries[0]?.text ?? "", /\$6::timestamptz/u);
    assert.match(pool.queries[0]?.text ?? "", /statement_timestamp\(\) < run\.timeout_at/u);
  });

  it("heartbeats only the matching live process before its deadline", async () => {
    const process = processRow();
    const heartbeatAt = new Date("2026-09-04T12:00:02.000Z");
    const pool = new ScriptedPool([{ rows: [{ heartbeat_at: heartbeatAt }] }]);
    const store = new PostgresWorkerRuntimeStore(pool);

    assert.equal(await store.heartbeatWorkerProcess(
      process.worker_process_id,
      Number(process.process_id),
      process.process_start_token,
    ), heartbeatAt.toISOString());
    assert.match(pool.queries[0]?.text ?? "", /process_start_token = \$3/u);
    assert.match(pool.queries[0]?.text ?? "", /statement_timestamp\(\) < deadline_at/u);
  });

  it("finishes a worker process idempotently with exact process identity", async () => {
    const process = {
      ...processRow(),
      state: "exited",
      completed_at: new Date("2026-09-04T12:00:03.000Z"),
      heartbeat_at: new Date("2026-09-04T12:00:03.000Z"),
      exit_code: 0,
      termination_reason: "transport completed",
    } as const;
    const pool = new ScriptedPool([
      { rows: [], rowCount: 0 },
      { rows: [process] },
    ]);
    const store = new PostgresWorkerRuntimeStore(pool);

    assert.equal(await store.finishWorkerProcess({
      workerProcessId: process.worker_process_id,
      processId: Number(process.process_id),
      processStartToken: process.process_start_token,
      state: "exited",
      exitCode: 0,
      terminationReason: "transport completed",
      transitionProvenanceId: process.transition_provenance_id,
    }), false);
    assert.match(pool.queries[0]?.text ?? "", /AND state = 'running'/u);
    assert.match(pool.queries[0]?.text ?? "", /heartbeat_at > reconciliation_claimed_at/u);
    assert.match(pool.queries[1]?.text ?? "", /worker_process_id = \$1/u);
  });

  it("rejects contradictory worker process terminal outcomes", async () => {
    const process = processRow();
    const pool = new ScriptedPool([]);
    const store = new PostgresWorkerRuntimeStore(pool);
    const common = {
      workerProcessId: process.worker_process_id,
      processId: Number(process.process_id),
      processStartToken: process.process_start_token,
      terminationReason: "observed terminal",
      transitionProvenanceId: process.transition_provenance_id,
    } as const;

    await assert.rejects(
      store.finishWorkerProcess({ ...common, state: "exited" }),
      /requires an exit code/u,
    );
    await assert.rejects(
      store.finishWorkerProcess({ ...common, state: "lost", exitCode: 1 }),
      /cannot have an exit code/u,
    );
    assert.equal(pool.queries.length, 0);
  });

  it("finds stale processes and started runs missing a process journal", async () => {
    const process = {
      ...processRow(),
      reconciliation_reason: "heartbeat_stale",
    } as const;
    const run = {
      run_id: process.run_id,
      mission_id: process.mission_id,
      node_id: process.node_id,
      context_packet_id: createStableId("contextPacket"),
      attempt_number: 1,
      state: "started",
      result: null,
      started_at: process.started_at,
      timeout_at: process.deadline_at,
      provenance_id: process.provenance_id,
      host_identifier: process.host_identifier,
      resource_class: process.resource_class,
    } as const;
    const pool = new ScriptedPool([{ rows: [process] }, { rows: [run] }]);
    const store = new PostgresWorkerRuntimeStore(pool);

    const stale = await store.listWorkerProcessesNeedingReconciliation(
      "host:vps",
      30,
    );
    const unjournaled = await store.listUnjournaledRuns("host:vps", 5);

    assert.equal(stale[0]?.reason, "heartbeat_stale");
    assert.equal(unjournaled[0]?.runId, process.run_id);
    assert.match(pool.queries[0]?.text ?? "", /make_interval\(secs => \$2\)/u);
    assert.match(pool.queries[1]?.text ?? "", /NOT EXISTS/u);
  });

  it("atomically claims stale processes with an expiring host-bound claim", async () => {
    const reconciliationId = createStableId("reconciliation");
    const claimedAt = new Date("2026-09-04T12:01:00.000Z");
    const claimExpiresAt = new Date("2026-09-04T12:02:00.000Z");
    const process = {
      ...processRow(),
      reconciliation_reason: "deadline_expired",
      reconciliation_id: reconciliationId,
      reconciliation_owner: "supervisor:vps:1",
      reconciliation_claimed_at: claimedAt,
      reconciliation_claim_expires_at: claimExpiresAt,
      reconciliation_provenance_id: createStableId("provenance"),
    } as const;
    const pool = new ScriptedPool([{ rows: [process] }]);
    const store = new PostgresWorkerRuntimeStore(pool);

    const claims = await store.claimWorkerProcessesNeedingReconciliation({
      hostIdentifier: "host:vps",
      staleAfterSeconds: 30,
      claimTtlSeconds: 60,
      limit: 10,
      reconciliationId,
      reconciliationOwner: "supervisor:vps:1",
      reconciliationProvenanceId: process.reconciliation_provenance_id,
    });

    assert.equal(claims[0]?.reconciliationId, reconciliationId);
    assert.equal(claims[0]?.reason, "deadline_expired");
    assert.match(pool.queries[0]?.text ?? "", /FOR UPDATE SKIP LOCKED/u);
    assert.match(pool.queries[0]?.text ?? "", /reconciliation_claim_expires_at/u);
  });

  it("holds a session lock while acting on one exact live process claim", async () => {
    const reconciliationId = createStableId("reconciliation");
    const process = {
      ...processRow(),
      reconciliation_reason: "heartbeat_stale",
      reconciliation_id: reconciliationId,
      reconciliation_owner: "supervisor:vps:1",
      reconciliation_claimed_at: new Date("2026-09-04T12:01:00.000Z"),
      reconciliation_claim_expires_at: new Date("2026-09-04T12:02:00.000Z"),
      reconciliation_provenance_id: createStableId("provenance"),
    } as const;
    const pool = new ScriptedPool([
      { rows: [{ acquired: true }] },
      { rows: [process] },
      { rows: [{ heartbeat_at: new Date("2026-09-04T12:01:10.000Z") }] },
      { rows: [{ pg_advisory_unlock: true }] },
    ]);
    const store = new PostgresWorkerRuntimeStore(pool);

    const result = await store.reconcileClaimedWorkerProcess(
      process.worker_process_id,
      reconciliationId,
      async () => ({ state: "running" }),
    );

    assert.deepEqual(result, {
      state: "healthy",
      heartbeatAt: "2026-09-04T12:01:10.000Z",
    });
    assert.match(pool.queries[0]?.text ?? "", /pg_try_advisory_lock/u);
    assert.match(pool.queries[1]?.text ?? "", /heartbeat_at <= process\.reconciliation_claimed_at/u);
    assert.match(pool.queries[2]?.text ?? "", /reconciliation_owner = \$5/u);
    assert.match(pool.queries[2]?.text ?? "", /reconciliation_claimed_at = \$7::timestamptz/u);
    assert.match(pool.queries[3]?.text ?? "", /pg_advisory_unlock/u);
  });

  it("terminalizes a claimed process on the held session with exact claim fencing", async () => {
    const reconciliationId = createStableId("reconciliation");
    const process = {
      ...processRow(),
      reconciliation_reason: "deadline_expired",
      reconciliation_id: reconciliationId,
      reconciliation_owner: "supervisor:vps:1",
      reconciliation_claimed_at: new Date("2026-09-04T12:01:00.000Z"),
      reconciliation_claim_expires_at: new Date("2026-09-04T12:02:00.000Z"),
      claimed_at_exact: "2026-09-04 12:01:00.000123+00",
      expires_at_exact: "2026-09-04 12:02:00.000123+00",
      reconciliation_provenance_id: createStableId("provenance"),
    } as const;
    const pool = new ScriptedPool([
      { rows: [{ acquired: true }] },
      { rows: [process] },
      { rows: [{ worker_process_id: process.worker_process_id }], rowCount: 1 },
      { rows: [{ pg_advisory_unlock: true }] },
    ]);
    const store = new PostgresWorkerRuntimeStore(pool);

    const result = await store.reconcileClaimedWorkerProcess(
      process.worker_process_id,
      reconciliationId,
      async () => ({
        state: "terminated",
        terminationReason: "deadline exceeded; process tree stopped",
        transitionProvenanceId: process.reconciliation_provenance_id,
      }),
    );

    assert.deepEqual(result, {
      state: "terminalized",
      processState: "terminated",
    });
    assert.match(pool.queries[2]?.text ?? "", /reconciliation_id = \$4/u);
    assert.match(pool.queries[2]?.text ?? "", /reconciliation_claimed_at = \$11::timestamptz/u);
    assert.match(pool.queries[2]?.text ?? "", /reconciliation_claim_expires_at > clock_timestamp/u);
    assert.equal(pool.queries[2]?.values[10], process.claimed_at_exact);
    assert.equal(pool.queries[2]?.values[11], process.expires_at_exact);
  });

  it("aborts OS observation on database session loss and destroys the broken connection", async () => {
    const row = { ...processRow(), reconciliation_id: createStableId("reconciliation"), reconciliation_owner: "host:recover",
      reconciliation_provenance_id: createStableId("provenance"), reconciliation_claimed_at: new Date(),
      reconciliation_claim_expires_at: new Date(Date.now() + 20000), claim_remaining_ms: 20000 };
    const pool = new ScriptedPool([{ rows: [{ acquired: true }] }, { rows: [row] }]);
    let signal: AbortSignal | undefined;
    let cleanupFinished = false;
    await assert.rejects(new PostgresWorkerRuntimeStore(pool).reconcileClaimedWorkerProcess(row.worker_process_id, row.reconciliation_id,
      async (_claim, observedSignal) => { signal = observedSignal;
        const cleanup = new Promise<{ state: "running" }>((resolve) => {
          observedSignal.addEventListener("abort", () => setTimeout(() => { cleanupFinished = true; resolve({ state: "running" }); }, 20), { once: true });
        });
        pool.emit("error", new Error("synthetic connection loss")); return await cleanup; }), /observation unconfirmed/);
    assert.equal(signal?.aborted, true); assert.equal(pool.releasedBroken, true);
    assert.equal(cleanupFinished, true);
    assert.equal(pool.queries.length, 2); assert.equal(pool.listenerCount("error"), 0);
  });

  it("bounds a stalled observer by the remaining database claim lease", async () => {
    const row = { ...processRow(), reconciliation_id: createStableId("reconciliation"), reconciliation_owner: "host:recover",
      reconciliation_provenance_id: createStableId("provenance"), reconciliation_claimed_at: new Date(),
      reconciliation_claim_expires_at: new Date(Date.now() + 1020), claim_remaining_ms: 1020 };
    const pool = new ScriptedPool([{ rows: [{ acquired: true }] }, { rows: [row] }, { rows: [{ pg_advisory_unlock: true }] }]);
    let signal: AbortSignal | undefined;
    await assert.rejects(new PostgresWorkerRuntimeStore(pool).reconcileClaimedWorkerProcess(row.worker_process_id, row.reconciliation_id,
      async (_claim, observedSignal) => { signal = observedSignal; return await new Promise((resolve) => {
        observedSignal.addEventListener("abort", () => resolve({ state: "running" }), { once: true });
      }); }), /observation unconfirmed/);
    assert.equal(signal?.aborted, true); assert.equal(pool.releasedBroken, false);
    assert.equal(pool.queries.length, 3);
  });

  it("rolls back an ambiguously acknowledged recovery BEGIN before releasing its session", async () => {
    const row = { ...processRow(), reconciliation_id: createStableId("reconciliation"), reconciliation_owner: "host:recover",
      reconciliation_provenance_id: createStableId("provenance"), reconciliation_claimed_at: new Date(),
      reconciliation_claim_expires_at: new Date(Date.now() + 20000), claim_remaining_ms: 20000 };
    const pool = new ScriptedPool([{ rows: [{ acquired: true }] }, { rows: [row] }, { rows: [{ pg_advisory_unlock: true }] }]);
    const query = pool.query.bind(pool);
    pool.query = async <R extends QueryResultRow = QueryResultRow>(sql: string, values: readonly unknown[] = []) => {
      const result = await query<R>(sql, values);
      if (sql === "BEGIN") throw new Error("synthetic lost BEGIN acknowledgement");
      return result;
    };
    await assert.rejects(new PostgresWorkerRuntimeStore(pool).reconcileClaimedWorkerProcess(row.worker_process_id, row.reconciliation_id,
      async () => ({ state: "lost", terminationReason: "Synthetic absence.", transitionProvenanceId: row.reconciliation_provenance_id }),
      { hostIdentifier: row.host_identifier, sessionId: createStableId("workerHostSession"), applicationVersion: "recovery-v1" }), /lost BEGIN acknowledgement/);
    assert.deepEqual(pool.queries.slice(2).map((q) => q.text === "BEGIN" || q.text === "ROLLBACK" ? q.text : "unlock"), ["BEGIN", "ROLLBACK", "unlock"]);
    assert.equal(pool.releasedBroken, false);
  });

  it("requires a terminal observation after a process deadline", async () => {
    const reconciliationId = createStableId("reconciliation");
    const process = {
      ...processRow(),
      reconciliation_reason: "deadline_expired",
      reconciliation_id: reconciliationId,
      reconciliation_owner: "supervisor:vps:1",
      reconciliation_claimed_at: new Date("2026-09-04T12:01:00.000Z"),
      reconciliation_claim_expires_at: new Date("2026-09-04T12:02:00.000Z"),
      reconciliation_provenance_id: createStableId("provenance"),
    } as const;
    const pool = new ScriptedPool([
      { rows: [{ acquired: true }] },
      { rows: [process] },
      { rows: [{ pg_advisory_unlock: true }] },
    ]);
    const store = new PostgresWorkerRuntimeStore(pool);

    await assert.rejects(
      store.reconcileClaimedWorkerProcess(
        process.worker_process_id,
        reconciliationId,
        async () => ({ state: "running" }),
      ),
      /requires a terminal observation/u,
    );
    assert.equal(pool.queries.length, 3);
  });

  it("finds terminal processes whose run projection is still started", async () => {
    const process = processRow();
    const completedAt = new Date("2026-09-04T12:01:00.000Z");
    const pool = new ScriptedPool([{ rows: [{
      run_id: process.run_id,
      mission_id: process.mission_id,
      node_id: process.node_id,
      context_packet_id: createStableId("contextPacket"),
      attempt_number: 1,
      state: "started",
      result: null,
      started_at: process.started_at,
      timeout_at: process.deadline_at,
      provenance_id: process.provenance_id,
      host_identifier: process.host_identifier,
      resource_class: process.resource_class,
      worker_process_id: process.worker_process_id,
      process_state: "exited",
      process_completed_at: completedAt,
      process_exit_code: 0,
      process_termination_reason: "transport completed",
    }] }]);
    const store = new PostgresWorkerRuntimeStore(pool);

    const gaps = await store.listWorkerRunProjectionGaps("host:vps");

    assert.equal(gaps[0]?.processState, "exited");
    assert.equal(gaps[0]?.processExitCode, 0);
    assert.match(pool.queries[0]?.text ?? "", /process\.state <> 'running'/u);
  });
});

function packetFor(): ContextPacket {
  return createContextPacket({
    contextPacketId: createStableId("contextPacket"),
    schemaVersion: contextPacketSchemaVersion,
    missionId: createStableId("mission"),
    nodeId: createStableId("node"),
    projectId: createStableId("project"),
    nodeType: "diagnosis",
    workerRole: "diagnosis",
    objective: "Inspect one repository.",
    nonGoals: ["No mutation."],
    completionScope: "Return a structured result.",
    projectProfile: { id: createStableId("projectProfile"), version: "1.0.0" },
    workflow: { id: createStableId("workflow"), version: "1.0.0" },
    policy: { id: createStableId("policy"), version: "1.0.0" },
    completionContract: {
      id: createStableId("completionContract"),
      version: "1.0.0",
    },
    lifecycle: {
      mission: { state: "executing" },
      deployments: [],
      acceptance: { state: "not_required" },
      effects: [],
      businessCompletion: { state: "not_required" },
    },
    behavioralContract: {},
    acceptanceCriteria: ["Result is schema-valid."],
    sourceAuthorityRules: {},
    evidence: [],
    activeClaimIds: [],
    conflicts: [],
    unresolvedQuestions: [],
    previousResultRefs: [],
    approvalIds: [],
    capabilityGrantId: createStableId("capabilityGrant"),
    requiredOutputSchema: workerResultOutputSchemaId,
    nextAction: "Inspect.",
    retryCount: 0,
    limits: {
      wallTimeMs: 300_000,
      maximumTurns: 3,
      maximumOutputBytes: 32_768,
    },
  });
}

function processRow() {
  const provenanceId = createStableId("provenance");
  return {
    worker_process_id: createStableId("workerProcess"),
    run_id: createStableId("run"),
    mission_id: createStableId("mission"),
    node_id: createStableId("node"),
    process_id: 1234,
    process_start_token: "1234:2026-09-04T12:00:01.000Z",
    purpose: "Codex worker transport",
    host_identifier: "host:vps",
    resource_class: "lightweight_read",
    state: "running",
    started_at: new Date("2026-09-04T12:00:01.000Z"),
    recorded_at: new Date("2026-09-04T12:00:01.500Z"),
    deadline_at: new Date("2026-09-04T12:05:00.000Z"),
    heartbeat_at: new Date("2026-09-04T12:00:01.000Z"),
    completed_at: null,
    exit_code: null,
    termination_reason: null,
    provenance_id: provenanceId,
    transition_provenance_id: provenanceId,
    reconciliation_id: null,
    reconciliation_owner: null,
    reconciliation_claimed_at: null,
    reconciliation_claim_expires_at: null,
    reconciliation_provenance_id: null,
  } as const;
}

function queryResult<R extends QueryResultRow>(
  rows: readonly R[],
  rowCount = rows.length,
): QueryResult<R> {
  return {
    rows: [...rows],
    rowCount,
    command: "SCRIPTED",
    oid: 0,
    fields: [],
  };
}
