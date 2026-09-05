import { canonicalJsonDigest, createStableId, parseStableId, parseWorkerResult,
  type StableId, type WorkerResult, type WorkerResourceClass } from "@acp/domain";
import type { Pool, PoolClient } from "pg";
import { PostgresWorkerRuntimeStore, type WorkerHostRegistration } from "./worker-runtime-store.ts";

export interface WorkerDispatchRequest {
  readonly runId: StableId<"run">;
  readonly missionId: StableId<"mission">;
  readonly nodeId: StableId<"node">;
  readonly grantId: StableId<"capabilityGrant">;
  readonly attemptNumber: number;
  readonly applicationVersion: string;
  readonly operation: string;
  readonly resource: string;
  /** Required to opt in to an operator laptop; otherwise only hosted resources. */
  readonly preferredHostIdentifier?: string;
  readonly provenanceId: StableId<"provenance">;
}

export interface HostRuntimeRegistration {
  readonly hostIdentifier: string;
  readonly sessionId: StableId<"workerHostSession">;
  readonly applicationVersion: string;
  readonly bindings: readonly {
    readonly workflowBindingId: StableId<"workflowBinding">;
    readonly templateProvenanceId: StableId<"provenance">;
  }[];
}

export interface DispatchMessage {
  readonly runId: StableId<"run">;
  readonly generation: number;
  readonly hostSessionId: StableId<"workerHostSession">;
}

export interface WorkerAssignment extends DispatchMessage {
  readonly missionId: StableId<"mission">;
  readonly nodeId: StableId<"node">;
  readonly attemptNumber: number;
  readonly grantId: StableId<"capabilityGrant">;
  readonly resourceClass: WorkerResourceClass;
  readonly hostIdentifier: string;
  readonly applicationVersion: string;
  readonly queueName: string;
  readonly workflowId: string;
  readonly templateProvenanceId: StableId<"provenance">;
  readonly contextPacketId: StableId<"contextPacket">;
  readonly packetProvenanceId: StableId<"provenance">;
  readonly operation: string;
  readonly resource: string;
  readonly mode: "read" | "write";
  readonly workspace: string;
}

export type DispatchPreparation =
  | { readonly state: "obsolete" }
  | { readonly state: "reconciliation_required" }
  | { readonly state: "terminal"; readonly result: WorkerResult }
  | { readonly state: "ready"; readonly assignment: WorkerAssignment };

export type EnqueueWorkerAssignment = (client: PoolClient, assignment: WorkerAssignment) => Promise<void>;

export class PostgresDispatchStore {
  private readonly pool: Pool;
  constructor(pool: Pool) {
    for (const [key, maximum] of [["connectionTimeoutMillis", 10_000], ["statement_timeout", 10_000],
      ["lock_timeout", 5_000]] as const) {
      const value = pool.options[key];
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maximum) {
        throw new TypeError(`dispatch pool ${key} must be explicitly bounded from 1 to ${maximum} ms`);
      }
    }
    this.pool = pool;
  }

  async registerRuntime(input: HostRuntimeRegistration, host?: WorkerHostRegistration): Promise<void> {
    nonblank(input.hostIdentifier); nonblank(input.applicationVersion);
    if (host && host.hostIdentifier !== input.hostIdentifier) throw new TypeError("host/runtime identity mismatch");
    parseStableId(input.sessionId, "workerHostSession");
    if (input.bindings.length < 1 || input.bindings.length > 100
        || new Set(input.bindings.map((b) => b.workflowBindingId)).size !== input.bindings.length) {
      throw new TypeError("host runtime requires 1 to 100 unique bindings");
    }
    for (const binding of input.bindings) {
      parseStableId(binding.workflowBindingId, "workflowBinding");
      parseStableId(binding.templateProvenanceId, "provenance");
    }
    await this.transaction(async (client) => {
      // Serialize first registration as well as replacement. Avoid INSERT upsert:
      // its BEFORE INSERT trigger would issue a nonce before UPDATE validation.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('acp-host-session:' || $1, 0))", [input.hostIdentifier]);
      const current = await client.query("SELECT session_id FROM acp.worker_host_sessions WHERE host_identifier = $1 FOR UPDATE", [input.hostIdentifier]);
      const registerHost = async () => {
        if (host) await new PostgresWorkerRuntimeStore({ query: client.query.bind(client),
          connect: async () => { throw new Error("host registration must stay in the owned transaction"); } }).registerHost(host);
      };
      if (current.rowCount) {
        // Fence against the incumbent's OLD TTL before applying replacement
        // configuration; shortening TTL cannot manufacture an expired session.
        await client.query(`UPDATE acp.worker_host_sessions SET session_id = $2, application_version = $3,
          state = 'active', heartbeat_at = statement_timestamp() WHERE host_identifier = $1`,
        [input.hostIdentifier, input.sessionId, input.applicationVersion]);
        await registerHost();
      } else {
        await registerHost();
        await client.query(`INSERT INTO acp.worker_host_sessions (host_identifier, session_id, application_version, state)
          VALUES ($1, $2, $3, 'active')`, [input.hostIdentifier, input.sessionId, input.applicationVersion]);
      }
      for (const binding of input.bindings) {
        const inserted = await client.query(`INSERT INTO acp.worker_host_runtimes (host_identifier,
          application_version, session_id, workflow_binding_id, template_provenance_id)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (host_identifier, application_version, workflow_binding_id, session_id)
          DO UPDATE SET heartbeat_at = statement_timestamp()
          WHERE acp.worker_host_runtimes.template_provenance_id = EXCLUDED.template_provenance_id
          RETURNING host_identifier`, [input.hostIdentifier, input.applicationVersion, input.sessionId,
          binding.workflowBindingId, binding.templateProvenanceId]);
        if (inserted.rowCount !== 1) throw new Error("runtime binding aliases a different template");
      }
    });
  }

  async heartbeatRuntime(host: string, session: StableId<"workerHostSession">): Promise<boolean> {
    return this.transaction(async (client) => {
      const current = await client.query(`UPDATE acp.worker_host_sessions SET heartbeat_at = statement_timestamp()
        WHERE host_identifier = $1 AND session_id = $2 AND state = 'active' RETURNING host_identifier`, [host, session]);
      if (!current.rowCount) return false;
      await client.query(`UPDATE acp.worker_host_runtimes SET heartbeat_at = statement_timestamp()
        WHERE host_identifier = $1 AND session_id = $2`, [host, session]);
      return true;
    });
  }

  async closeRuntime(host: string, session: StableId<"workerHostSession">): Promise<void> {
    await this.pool.query(`UPDATE acp.worker_host_sessions SET state = 'closed'
      WHERE host_identifier = $1 AND session_id = $2 AND state = 'active'`, [host, session]);
  }

  /** Bounded local cancellation bridge; draining hosts may finish admitted work. */
  async cancellationRequests(runIds: readonly StableId<"run">[], host: string,
    session: StableId<"workerHostSession">): Promise<readonly StableId<"run">[]> {
    if (runIds.length > 100) throw new TypeError("cancellation query is limited to 100 runs");
    if (!runIds.length) return [];
    for (const runId of runIds) parseStableId(runId, "run");
    const result = await this.pool.query(`SELECT requested.run_id FROM unnest($1::text[]) requested(run_id)
      LEFT JOIN acp.worker_dispatches d ON d.run_id::text = requested.run_id
      LEFT JOIN acp.missions m ON m.mission_id = d.mission_id
      LEFT JOIN acp.mission_nodes n ON n.node_id = d.node_id
      LEFT JOIN acp.capability_grants g ON g.grant_id = d.grant_id
      LEFT JOIN acp.worker_host_sessions s ON s.host_identifier = $2
      LEFT JOIN acp.worker_hosts h ON h.host_identifier = $2
      WHERE d.run_id IS NULL OR d.state NOT IN ('assigned', 'running')
        OR acp.worker_cancellation_requested(d.mission_id, n.graph_revision)
        OR m.state IN ('cancelled', 'failed', 'complete_for_scope')
        OR n.state NOT IN ('runnable', 'running') OR g.expires_at <= statement_timestamp()
        OR s.session_id IS DISTINCT FROM $3 OR s.state IS DISTINCT FROM 'active'
        OR h.state = 'offline'
        OR least(s.heartbeat_at, h.heartbeat_at) + make_interval(secs => h.heartbeat_ttl_seconds) <= statement_timestamp()`,
    [runIds, host, session]);
    return result.rows.map((row) => parseStableId(row.run_id, "run"));
  }

  async request(input: WorkerDispatchRequest): Promise<void> {
    const request = {
      runId: parseStableId(input.runId, "run"), missionId: parseStableId(input.missionId, "mission"),
      nodeId: parseStableId(input.nodeId, "node"), grantId: parseStableId(input.grantId, "capabilityGrant"),
      attemptNumber: input.attemptNumber, applicationVersion: nonblank(input.applicationVersion),
      operation: nonblank(input.operation), resource: nonblank(input.resource),
      preferredHostIdentifier: input.preferredHostIdentifier === undefined ? null : nonblank(input.preferredHostIdentifier),
      provenanceId: parseStableId(input.provenanceId, "provenance"),
    };
    if (!Number.isSafeInteger(request.attemptNumber) || request.attemptNumber < 1 || request.attemptNumber > 2147483647) {
      throw new TypeError("dispatch attempt must be a positive PostgreSQL integer");
    }
    const digest = canonicalJsonDigest(request);
    await this.transaction(async (client) => {
      await lockNode(client, request.missionId, request.nodeId);
      const existing = await client.query("SELECT request_digest FROM acp.worker_dispatches WHERE run_id = $1", [request.runId]);
      if (existing.rows[0]) {
        if (existing.rows[0].request_digest !== digest) throw new Error("dispatch run ID aliases different request terms");
        return;
      }
      await client.query(`INSERT INTO acp.worker_dispatches (run_id, mission_id, node_id, grant_id,
        attempt_number, application_version, operation, resource, preferred_host_identifier, provenance_id, request_digest)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [request.runId, request.missionId, request.nodeId, request.grantId, request.attemptNumber,
        request.applicationVersion, request.operation, request.resource, request.preferredHostIdentifier,
        request.provenanceId, digest]);
    });
  }

  async listPending(limit = 25): Promise<readonly StableId<"run">[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("dispatch sweep limit must be 1 to 100");
    const rows = await this.pool.query(`SELECT d.run_id FROM acp.worker_dispatches d
      LEFT JOIN acp.worker_dispatch_assignments a ON a.run_id = d.run_id AND a.generation = d.generation
      LEFT JOIN acp.worker_hosts h ON h.host_identifier = a.host_identifier
      LEFT JOIN acp.worker_host_sessions s ON s.host_identifier = a.host_identifier
      JOIN acp.mission_nodes n ON n.node_id = d.node_id
      JOIN acp.missions m ON m.mission_id = d.mission_id
      JOIN acp.capability_grants g ON g.grant_id = d.grant_id
      WHERE d.next_assignment_attempt_at <= statement_timestamp() AND (d.state = 'pending' OR (d.state = 'assigned' AND (a.expires_at <= statement_timestamp()
        OR acp.worker_cancellation_requested(d.mission_id, n.graph_revision)
        OR m.state IN ('complete_for_scope', 'failed', 'cancelled') OR g.expires_at <= statement_timestamp()
        OR h.state <> 'active' OR s.state <> 'active' OR s.session_id <> a.host_session_id
        OR NOT EXISTS (SELECT 1 FROM acp.worker_host_runtimes runtime WHERE runtime.host_identifier = a.host_identifier
          AND runtime.session_id = a.host_session_id AND runtime.template_provenance_id = a.template_provenance_id
          AND runtime.application_version = d.application_version
          AND runtime.heartbeat_at + make_interval(secs => h.heartbeat_ttl_seconds) > statement_timestamp())
        OR least(h.heartbeat_at, s.heartbeat_at) + make_interval(secs => h.heartbeat_ttl_seconds) <= statement_timestamp())))
      ORDER BY d.next_assignment_attempt_at, d.created_at, d.run_id LIMIT $1`, [limit]);
    return rows.rows.map((row) => row.run_id as StableId<"run">);
  }

  async assign(runId: StableId<"run">, enqueue: EnqueueWorkerAssignment, ttlMilliseconds = 60_000): Promise<WorkerAssignment | undefined> {
    if (!Number.isSafeInteger(ttlMilliseconds) || ttlMilliseconds < 1000 || ttlMilliseconds > 300_000) {
      throw new TypeError("assignment TTL must be 1000 to 300000 ms");
    }
    return this.transaction(async (client) => {
      const identity = await client.query("SELECT mission_id, node_id FROM acp.worker_dispatches WHERE run_id = $1", [runId]);
      if (!identity.rows[0]) throw new Error("dispatch does not exist");
      await lockNode(client, identity.rows[0].mission_id, identity.rows[0].node_id);
      const locked = await client.query(`SELECT d.*, m.workflow_binding_id, m.state AS mission_state,
        n.state AS node_state, g.resource_class, g.expires_at AS grant_expires_at,
        acp.worker_cancellation_requested(d.mission_id, n.graph_revision) AS cancellation_requested,
        g.expires_at <= statement_timestamp() AS grant_expired,
        g.valid_from <= statement_timestamp() AS grant_started
        FROM acp.worker_dispatches d JOIN acp.missions m USING (mission_id)
        JOIN acp.mission_nodes n ON n.node_id = d.node_id JOIN acp.capability_grants g ON g.grant_id = d.grant_id
        WHERE d.run_id = $1 FOR UPDATE OF d`, [runId]);
      const d = locked.rows[0]!;
      if (!['pending', 'assigned'].includes(d.state as string)) return undefined;
      if (d.cancellation_requested || ['complete_for_scope', 'failed', 'cancelled'].includes(d.mission_state as string)) {
        await client.query("UPDATE acp.worker_dispatches SET state = 'cancelled', reason = 'Mission is terminal or cancellation was requested.' WHERE run_id = $1", [runId]);
        await finishUnstartedNode(client, d.mission_id, d.node_id, d.provenance_id, "cancelled");
        return undefined;
      }
      if (d.grant_expired || ['succeeded', 'failed', 'cancelled'].includes(d.node_state as string)) {
        await client.query("UPDATE acp.worker_dispatches SET state = 'blocked', reason = 'Grant expired or node is terminal.' WHERE run_id = $1", [runId]);
        await finishUnstartedNode(client, d.mission_id, d.node_id, d.provenance_id, "needs_input");
        return undefined;
      }
      await client.query(`UPDATE acp.worker_dispatches SET next_assignment_attempt_at = statement_timestamp() + interval '5 seconds'
        WHERE run_id = $1`, [runId]);
      if (d.mission_state !== 'executing' || !d.grant_started || !['runnable', 'running'].includes(d.node_state as string)) return undefined;
      let previousHost: string | null = null;
      if (d.state === 'assigned') {
        const current = await loadAssignment(client, runId, d.generation as number);
        const live = await assignmentLive(client, runId, d.generation as number);
        if (live) return current;
        previousHost = current.hostIdentifier;
      }
      // No locks are taken in reverse order: mission -> node -> dispatch -> host.
      const hosts = await client.query(`SELECT h.host_identifier FROM acp.worker_hosts h
        JOIN acp.worker_host_sessions s USING (host_identifier)
        JOIN acp.worker_host_runtimes r ON r.host_identifier = h.host_identifier AND r.session_id = s.session_id
        WHERE h.state = 'active' AND s.state = 'active' AND r.application_version = $1
          AND r.workflow_binding_id = $2
          AND least(h.heartbeat_at, s.heartbeat_at, r.heartbeat_at) + make_interval(secs => h.heartbeat_ttl_seconds) > statement_timestamp()
          AND ($3::text IS NULL OR h.host_identifier = $3)
          AND (h.host_kind <> 'operator_laptop' OR h.host_identifier = $3)
          AND acp.worker_host_load(h.host_identifier, $4) - CASE WHEN h.host_identifier = $5 THEN 1 ELSE 0 END < acp.worker_host_capacity(h, $4)
        ORDER BY acp.worker_host_load(h.host_identifier, $4), h.host_identifier LIMIT 20`,
      [d.application_version, d.workflow_binding_id, d.preferred_host_identifier, d.resource_class, previousHost]);
      for (const candidate of hosts.rows) {
        const session = await client.query("SELECT session_id FROM acp.worker_host_sessions WHERE host_identifier = $1 FOR SHARE SKIP LOCKED", [candidate.host_identifier]);
        if (!session.rowCount) continue;
        const host = await client.query("SELECT * FROM acp.worker_hosts WHERE host_identifier = $1 FOR UPDATE SKIP LOCKED", [candidate.host_identifier]);
        if (!host.rowCount) continue;
        const capacity = await client.query(`SELECT acp.worker_host_load(host_identifier, $2) - CASE WHEN host_identifier = $3 THEN 1 ELSE 0 END < acp.worker_host_capacity(h, $2) AS available
          FROM acp.worker_hosts h WHERE host_identifier = $1`, [candidate.host_identifier, d.resource_class, previousHost]);
        if (!capacity.rows[0]?.available) continue;
        const assignment = await client.query(`INSERT INTO acp.worker_dispatch_assignments (run_id, generation,
          host_identifier, host_session_id, template_provenance_id, context_packet_id, packet_provenance_id,
          queue_name, workflow_id, expires_at)
          SELECT $1::acp.stable_id, $2::integer, r.host_identifier, r.session_id, r.template_provenance_id, $3::acp.stable_id, $4::acp.stable_id,
            acp.host_worker_queue(r.host_identifier, $5, r.session_id), 'worker:' || ($1::acp.stable_id)::text || ':assignment:' || ($2::integer)::text,
            least(statement_timestamp() + ($6::double precision * interval '1 millisecond'), $7::timestamptz - interval '1 millisecond')
          FROM acp.worker_host_runtimes r JOIN acp.worker_host_sessions s USING (host_identifier)
          WHERE r.host_identifier = $8 AND r.application_version = $9 AND r.workflow_binding_id = $10
            AND r.session_id = s.session_id AND s.state = 'active' RETURNING generation`,
        [runId, Number(d.generation) + 1, createStableId("contextPacket"), createStableId("provenance"),
          d.resource_class, ttlMilliseconds, d.grant_expires_at, candidate.host_identifier,
          d.application_version, d.workflow_binding_id]);
        if (!assignment.rowCount) continue;
        await client.query("UPDATE acp.worker_dispatches SET state = 'assigned', generation = $2 WHERE run_id = $1", [runId, Number(d.generation) + 1]);
        const selected = await loadAssignment(client, runId, Number(d.generation) + 1);
        // Required: DBOS enqueue on this SAME open PostgreSQL transaction. Failure
        // rolls back both assignment/reservation and DBOS workflow creation.
        await enqueue(client, selected);
        return selected;
      }
      return undefined;
    });
  }

  async prepare(message: DispatchMessage, host: string, applicationVersion: string, localSessionId: StableId<"workerHostSession">): Promise<DispatchPreparation> {
    if (message.hostSessionId !== localSessionId) return { state: "obsolete" };
    return this.transaction(async (client) => {
      const identity = await client.query("SELECT mission_id, node_id FROM acp.worker_dispatches WHERE run_id = $1", [message.runId]);
      if (!identity.rows[0]) return { state: "obsolete" };
      await lockNode(client, identity.rows[0].mission_id, identity.rows[0].node_id);
      const d = (await client.query("SELECT * FROM acp.worker_dispatches WHERE run_id = $1 FOR UPDATE", [message.runId])).rows[0]!;
      if (d.generation !== message.generation || d.application_version !== applicationVersion) return { state: "obsolete" };
      const assignment = await loadAssignment(client, message.runId, message.generation);
      if (assignment.hostIdentifier !== host || assignment.hostSessionId !== message.hostSessionId) return { state: "obsolete" };
      const run = (await client.query("SELECT state, result FROM acp.worker_runs WHERE run_id = $1", [message.runId])).rows[0];
      if (run) return run.state === 'started' ? { state: "reconciliation_required" }
        : { state: "terminal", result: parseWorkerResult(run.result) };
      if (d.state !== 'assigned' || !(await assignmentLive(client, message.runId, message.generation))) return { state: "obsolete" };
      const node = await client.query(`UPDATE acp.mission_nodes n SET state = 'running', started_at = statement_timestamp(), completed_at = NULL,
        transition_provenance_id = $3 WHERE n.node_id = $1 AND n.mission_id = $2 AND n.state = 'runnable'
        AND EXISTS (SELECT 1 FROM acp.missions m WHERE m.mission_id = n.mission_id AND m.state = 'executing')
        AND NOT acp.worker_cancellation_requested(n.mission_id, n.graph_revision)
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(n.dependencies) dep(id)
          LEFT JOIN acp.mission_nodes prior ON prior.node_id::text = dep.id AND prior.mission_id = n.mission_id
          WHERE prior.node_id IS NULL OR prior.state <> 'succeeded') RETURNING node_id`,
      [assignment.nodeId, assignment.missionId, assignment.templateProvenanceId]);
      if (!node.rowCount) {
        const active = await client.query(`SELECT 1 FROM acp.mission_nodes n JOIN acp.missions m USING (mission_id)
          WHERE n.node_id = $1 AND n.state = 'running' AND m.state = 'executing'
            AND NOT acp.worker_cancellation_requested(n.mission_id, n.graph_revision)
            AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(n.dependencies) dep(id)
              LEFT JOIN acp.mission_nodes prior ON prior.node_id::text = dep.id AND prior.mission_id = n.mission_id
              WHERE prior.node_id IS NULL OR prior.state <> 'succeeded')`, [assignment.nodeId]);
        if (!active.rowCount) return { state: "obsolete" };
      }
      return { state: "ready", assignment };
    });
  }

  async blockUnstarted(message: DispatchMessage, reason: string): Promise<boolean> {
    nonblank(reason);
    return this.transaction(async (client) => {
      const identity = (await client.query("SELECT mission_id, node_id FROM acp.worker_dispatches WHERE run_id = $1", [message.runId])).rows[0];
      if (!identity) return false;
      await lockNode(client, identity.mission_id, identity.node_id);
      const result = await client.query(`UPDATE acp.worker_dispatches SET state = 'blocked', reason = $3
        WHERE run_id = $1 AND generation = $2 AND state = 'assigned'
          AND EXISTS (SELECT 1 FROM acp.worker_dispatch_assignments a WHERE a.run_id = $1
            AND a.generation = $2 AND a.host_session_id = $4)
          AND NOT EXISTS (SELECT 1 FROM acp.worker_runs WHERE run_id = $1) RETURNING provenance_id`,
      [message.runId, message.generation, reason.slice(0, 1000), message.hostSessionId]);
      if (result.rowCount !== 1) return false;
      await finishUnstartedNode(client, identity.mission_id, identity.node_id, result.rows[0]!.provenance_id, "needs_input");
      return true;
    });
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); const result = await operation(client); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
}

async function finishUnstartedNode(client: PoolClient, missionId: string, nodeId: string, provenanceId: string,
  state: "needs_input" | "cancelled"): Promise<void> {
  await client.query(`UPDATE acp.mission_nodes SET state = $4, completed_at = statement_timestamp(),
    transition_provenance_id = $3 WHERE mission_id = $1 AND node_id = $2 AND state IN ('runnable', 'running')`,
  [missionId, nodeId, provenanceId, state]);
}

async function lockNode(client: PoolClient, missionId: string, nodeId: string): Promise<void> {
  await client.query("SELECT mission_id FROM acp.missions WHERE mission_id = $1 FOR UPDATE", [missionId]);
  const node = await client.query("SELECT node_id FROM acp.mission_nodes WHERE mission_id = $1 AND node_id = $2 FOR UPDATE", [missionId, nodeId]);
  if (!node.rowCount) throw new Error("dispatch mission/node does not exist");
}

async function assignmentLive(client: PoolClient, runId: string, generation: number): Promise<boolean> {
  const result = await client.query(`SELECT 1 FROM acp.worker_dispatch_assignments a
    JOIN acp.worker_dispatches d ON d.run_id = a.run_id AND d.generation = a.generation
    JOIN acp.worker_hosts h ON h.host_identifier = a.host_identifier
    JOIN acp.worker_host_sessions s ON s.host_identifier = h.host_identifier AND s.session_id = a.host_session_id
    JOIN acp.worker_host_runtimes r ON r.host_identifier = h.host_identifier AND r.session_id = s.session_id
      AND r.template_provenance_id = a.template_provenance_id AND r.application_version = d.application_version
    WHERE a.run_id = $1 AND a.generation = $2 AND h.state = 'active' AND s.state = 'active'
      AND a.expires_at > statement_timestamp()
      AND least(h.heartbeat_at, s.heartbeat_at, r.heartbeat_at) + make_interval(secs => h.heartbeat_ttl_seconds) > statement_timestamp()`, [runId, generation]);
  return result.rowCount === 1;
}

async function loadAssignment(client: PoolClient, runId: string, generation: number): Promise<WorkerAssignment> {
  const result = await client.query(`SELECT d.*, a.*, g.resource_class, g.mode, g.workspace FROM acp.worker_dispatches d
    JOIN acp.worker_dispatch_assignments a USING (run_id) JOIN acp.capability_grants g ON g.grant_id = d.grant_id
    WHERE d.run_id = $1 AND a.generation = $2`, [runId, generation]);
  const row = result.rows[0];
  if (!row) throw new Error("worker assignment does not exist");
  return {
    runId: row.run_id, generation: row.generation, hostSessionId: row.host_session_id,
    missionId: row.mission_id, nodeId: row.node_id, attemptNumber: row.attempt_number,
    grantId: row.grant_id, resourceClass: row.resource_class, hostIdentifier: row.host_identifier,
    applicationVersion: row.application_version, queueName: row.queue_name, workflowId: row.workflow_id,
    templateProvenanceId: row.template_provenance_id, contextPacketId: row.context_packet_id,
    packetProvenanceId: row.packet_provenance_id, operation: row.operation, resource: row.resource,
    mode: row.mode, workspace: row.workspace,
  } as WorkerAssignment;
}

function nonblank(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw new TypeError("bounded nonblank value required");
  return value;
}
