import {
  canonicalJsonDigest,
  createWorkerFailureResult,
  parseStableId,
  parseCapabilityGrant,
  parseContextPacket,
  parseWorkerResult,
  type CapabilityGrant,
  type CapabilityRequest,
  type ContextPacket,
  type StableId,
  type WorkerResourceClass as DomainWorkerResourceClass,
  type WorkerResult,
  type WorkerResultStatus,
} from "@acp/domain";
import type { QueryResultRow } from "pg";
import { isDeepStrictEqual } from "node:util";

import type { ConnectionPool } from "./database.ts";
import { withTransaction } from "./database.ts";
import type { WorkerRecoveryAuthority } from "./worker-recovery-store.ts";
import { parseWorkerLaunchIntent, type WorkerLaunchIntent } from "./worker-launch-intent.ts";

export interface CapabilityGrantInsert
  extends Omit<CapabilityGrant, "attemptsUsed"> {
  readonly provenanceId: StableId<"provenance">;
}

export interface ContextPacketInsert {
  readonly packet: ContextPacket;
  readonly provenanceId: StableId<"provenance">;
}

export type WorkerResourceClass = DomainWorkerResourceClass;

export type WorkerHostKind = "operator_laptop" | "vps" | "other";
export type WorkerHostState = "active" | "draining" | "offline";

export interface WorkerHostRegistration {
  readonly hostIdentifier: string;
  readonly hostKind: WorkerHostKind;
  readonly state: WorkerHostState;
  readonly maximumCpuIntensive: number;
  readonly maximumModerateCompute: number;
  readonly maximumLightweightRead: number;
  readonly maximumNetworkBound: number;
  readonly heartbeatTtlSeconds: number;
  readonly provenanceId: StableId<"provenance">;
  readonly transitionProvenanceId: StableId<"provenance">;
}

export interface AvailableWorkerHost {
  readonly hostIdentifier: string;
  readonly hostKind: WorkerHostKind;
  readonly resourceClass: WorkerResourceClass;
  readonly capacity: number;
  readonly activeRuns: number;
  readonly availableSlots: number;
  readonly heartbeatAt: string;
}

export interface WorkerRunStart {
  readonly launchIntent?: WorkerLaunchIntent;
  readonly dispatchGeneration?: number;
  readonly runId: StableId<"run">;
  readonly packet: ContextPacket;
  readonly attemptNumber: number;
  readonly request: CapabilityRequest;
  readonly hostIdentifier: string;
  readonly resourceClass: WorkerResourceClass;
  readonly wallTimeMs: number;
  readonly provenanceId: StableId<"provenance">;
}

export interface StartedWorkerRun {
  readonly launchIntent?: WorkerLaunchIntent;
  readonly runId: StableId<"run">;
  readonly startedAt: string;
  readonly timeoutAt: string;
}

export interface WorkerRunCompletion {
  readonly result: WorkerResult;
  readonly completedAt: string;
  readonly transitionProvenanceId: StableId<"provenance">;
}

export interface AbandonedWorkerRun {
  readonly runId: StableId<"run">;
  readonly missionId: StableId<"mission">;
  readonly nodeId: StableId<"node">;
  readonly contextPacketId: StableId<"contextPacket">;
  readonly attemptNumber: number;
  readonly timeoutAt: string;
  readonly provenanceId: StableId<"provenance">;
}

export type WorkerProcessTerminalState = "exited" | "terminated" | "lost";

export interface WindowsSupervisionScope {
  readonly machineFingerprint: string;
  readonly bootedAt: string;
  readonly sessionId: number;
}
export interface WorkerProcessSupervision {
  readonly kind: "windows_job";
  readonly treeIdentifier: string;
  /** Absent only for historical schema-0007 rows; never infer it from the current host. */
  readonly scope?: WindowsSupervisionScope;
}

export interface WorkerProcessRegistration {
  readonly supervision?: WorkerProcessSupervision;
  readonly workerProcessId: StableId<"workerProcess">;
  readonly runId: StableId<"run">;
  readonly processId: number;
  readonly processStartToken: string;
  readonly startedAt: string;
  readonly purpose: string;
  readonly provenanceId: StableId<"provenance">;
  readonly transitionProvenanceId: StableId<"provenance">;
}

export interface WorkerProcessRecord {
  readonly supervision?: WorkerProcessSupervision;
  readonly workerProcessId: StableId<"workerProcess">;
  readonly runId: StableId<"run">;
  readonly missionId: StableId<"mission">;
  readonly nodeId: StableId<"node">;
  readonly processId: number;
  readonly processStartToken: string;
  readonly purpose: string;
  readonly hostIdentifier: string;
  readonly resourceClass: WorkerResourceClass;
  readonly state: "running" | WorkerProcessTerminalState;
  readonly startedAt: string;
  readonly recordedAt: string;
  readonly deadlineAt: string;
  readonly heartbeatAt: string;
  readonly completedAt?: string;
  readonly exitCode?: number;
  readonly terminationReason?: string;
  readonly provenanceId: StableId<"provenance">;
  readonly transitionProvenanceId: StableId<"provenance">;
}

export interface WorkerProcessCompletion {
  readonly workerProcessId: StableId<"workerProcess">;
  readonly processId: number;
  readonly processStartToken: string;
  readonly state: WorkerProcessTerminalState;
  readonly exitCode?: number;
  readonly terminationReason: string;
  readonly transitionProvenanceId: StableId<"provenance">;
}

export interface WorkerProcessReconciliationCandidate
  extends WorkerProcessRecord {
  readonly reason: "deadline_expired" | "heartbeat_stale" | "owner_handoff";
}

export interface WorkerProcessReconciliationClaim
  extends WorkerProcessReconciliationCandidate {
  readonly reconciliationId: StableId<"reconciliation">;
  readonly reconciliationOwner: string;
  readonly reconciliationClaimedAt: string;
  readonly reconciliationClaimExpiresAt: string;
  readonly reconciliationProvenanceId: StableId<"provenance">;
}

export type WorkerProcessReconciliationObservation =
  | { readonly state: "running" }
  | {
      readonly state: WorkerProcessTerminalState;
      readonly exitCode?: number;
      readonly terminationReason: string;
      readonly transitionProvenanceId: StableId<"provenance">;
    };

export type WorkerProcessReconciliationResult =
  | { readonly state: "busy" }
  | { readonly state: "stale_claim" }
  | { readonly state: "healthy"; readonly heartbeatAt: string }
  | {
      readonly state: "terminalized";
      readonly processState: WorkerProcessTerminalState;
    };

export interface UnjournaledWorkerRun extends AbandonedWorkerRun {
  readonly hostIdentifier: string;
  readonly resourceClass: WorkerResourceClass;
  readonly startedAt: string;
}

export interface WorkerRunProjectionGap extends UnjournaledWorkerRun {
  readonly workerProcessId: StableId<"workerProcess">;
  readonly processState: WorkerProcessTerminalState;
  readonly processCompletedAt: string;
  readonly processExitCode?: number;
  readonly processTerminationReason: string;
}

export interface WorkerRunPersistence {
  loadCapabilityGrant(
    grantId: StableId<"capabilityGrant">,
  ): Promise<CapabilityGrant | undefined>;
  loadContextPacket(
    contextPacketId: StableId<"contextPacket">,
  ): Promise<ContextPacket | undefined>;
  startRun(start: WorkerRunStart): Promise<StartedWorkerRun>;
  completeRun(completion: WorkerRunCompletion): Promise<boolean>;
}

interface GrantRow extends QueryResultRow {
  readonly grant_id: StableId<"capabilityGrant">;
  readonly evaluation_id: StableId<"capabilityGrantEvaluation">;
  readonly mission_id: StableId<"mission">;
  readonly node_id: StableId<"node">;
  readonly project_id: StableId<"project">;
  readonly role: CapabilityGrant["role"];
  readonly resource_class: WorkerResourceClass;
  readonly allowed_operations: readonly string[];
  readonly allowed_resources: readonly string[];
  readonly mode: CapabilityGrant["mode"];
  readonly workspace: string;
  readonly network_destinations: readonly string[];
  readonly valid_from: Date;
  readonly expires_at: Date;
  readonly maximum_attempts: number;
  readonly attempts_used: string | number;
  readonly provenance_id: StableId<"provenance">;
}

interface PacketRow extends QueryResultRow {
  readonly packet: unknown;
  readonly digest: string;
  readonly capability_grant_id: StableId<"capabilityGrant">;
  readonly provenance_id: StableId<"provenance">;
}

interface RunRow extends QueryResultRow {
  readonly run_id: StableId<"run">;
  readonly mission_id: StableId<"mission">;
  readonly node_id: StableId<"node">;
  readonly context_packet_id: StableId<"contextPacket">;
  readonly attempt_number: number;
  readonly state: WorkerResultStatus | "started";
  readonly result: unknown | null;
  readonly started_at: Date;
  readonly timeout_at: Date;
  readonly provenance_id: StableId<"provenance">;
}

interface HostRow extends QueryResultRow {
  readonly host_identifier: string;
  readonly host_kind: WorkerHostKind;
  readonly resource_class: WorkerResourceClass;
  readonly capacity: number;
  readonly active_runs: string | number;
  readonly heartbeat_at: Date;
}

interface ProcessRow extends QueryResultRow {
  readonly supervision_scope?: WindowsSupervisionScope | null;
  readonly claim_remaining_ms?: string | number;
  readonly supervision_kind?: "windows_job" | null;
  readonly tree_identifier?: string | null;
  readonly worker_process_id: StableId<"workerProcess">;
  readonly run_id: StableId<"run">;
  readonly mission_id: StableId<"mission">;
  readonly node_id: StableId<"node">;
  readonly process_id: string | number;
  readonly process_start_token: string;
  readonly purpose: string;
  readonly host_identifier: string;
  readonly resource_class: WorkerResourceClass;
  readonly state: "running" | WorkerProcessTerminalState;
  readonly started_at: Date;
  readonly recorded_at: Date;
  readonly deadline_at: Date;
  readonly heartbeat_at: Date;
  readonly completed_at: Date | null;
  readonly exit_code: number | null;
  readonly termination_reason: string | null;
  readonly provenance_id: StableId<"provenance">;
  readonly transition_provenance_id: StableId<"provenance">;
  readonly reconciliation_reason?: "deadline_expired" | "heartbeat_stale" | "owner_handoff";
  readonly reconciliation_id: StableId<"reconciliation"> | null;
  readonly reconciliation_owner: string | null;
  readonly reconciliation_claimed_at: Date | null;
  readonly reconciliation_claim_expires_at: Date | null;
  readonly reconciliation_provenance_id: StableId<"provenance"> | null;
}

export class PostgresWorkerRuntimeStore implements WorkerRunPersistence {
  private readonly pool: ConnectionPool;

  constructor(pool: ConnectionPool) {
    this.pool = pool;
  }

  async registerHost(host: WorkerHostRegistration): Promise<void> {
    assertHostRegistration(host);
    const result = await this.pool.query(
      `INSERT INTO acp.worker_hosts (
         host_identifier, host_kind, state, maximum_cpu_intensive,
         maximum_moderate_compute, maximum_lightweight_read,
         maximum_network_bound, heartbeat_ttl_seconds, heartbeat_at,
         provenance_id, transition_provenance_id, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, statement_timestamp(), $9, $10,
         statement_timestamp()
       )
       ON CONFLICT (host_identifier) DO UPDATE
       SET state = EXCLUDED.state,
           maximum_cpu_intensive = EXCLUDED.maximum_cpu_intensive,
           maximum_moderate_compute = EXCLUDED.maximum_moderate_compute,
           maximum_lightweight_read = EXCLUDED.maximum_lightweight_read,
           maximum_network_bound = EXCLUDED.maximum_network_bound,
           heartbeat_ttl_seconds = EXCLUDED.heartbeat_ttl_seconds,
           heartbeat_at = statement_timestamp(),
           transition_provenance_id = EXCLUDED.transition_provenance_id,
           updated_at = statement_timestamp()
       WHERE acp.worker_hosts.provenance_id = EXCLUDED.provenance_id
         AND acp.worker_hosts.host_kind = EXCLUDED.host_kind
       RETURNING host_identifier`,
      [
        host.hostIdentifier,
        host.hostKind,
        host.state,
        host.maximumCpuIntensive,
        host.maximumModerateCompute,
        host.maximumLightweightRead,
        host.maximumNetworkBound,
        host.heartbeatTtlSeconds,
        host.provenanceId,
        host.transitionProvenanceId,
      ],
    );
    if (result.rowCount !== 1) {
      throw new Error("worker host identifier aliases different immutable identity");
    }
  }

  async heartbeatHost(
    hostIdentifier: string,
    transitionProvenanceId: StableId<"provenance">,
  ): Promise<string> {
    if (hostIdentifier.trim().length === 0) {
      throw new TypeError("worker host identifier must not be empty");
    }
    const result = await this.pool.query<{ readonly heartbeat_at: Date }>(
      `UPDATE acp.worker_hosts
       SET heartbeat_at = statement_timestamp(),
           transition_provenance_id = $2,
           updated_at = statement_timestamp()
       WHERE host_identifier = $1 AND state <> 'offline'
       RETURNING heartbeat_at`,
      [hostIdentifier, transitionProvenanceId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("active worker host does not exist");
    return row.heartbeat_at.toISOString();
  }

  async listAvailableHosts(
    resourceClass: WorkerResourceClass,
    limit = 20,
    includeOperatorLaptop = false,
  ): Promise<readonly AvailableWorkerHost[]> {
    assertResourceClass(resourceClass);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new RangeError("worker host limit must be between 1 and 200");
    }
    const result = await this.pool.query<HostRow>(
      `SELECT host.host_identifier, host.host_kind, $1::text AS resource_class,
              capacity.value AS capacity, usage.active_runs,
              host.heartbeat_at
       FROM acp.worker_hosts AS host
       CROSS JOIN LATERAL (
         SELECT CASE $1
           WHEN 'cpu_intensive' THEN host.maximum_cpu_intensive
           WHEN 'moderate_compute' THEN host.maximum_moderate_compute
           WHEN 'lightweight_read' THEN host.maximum_lightweight_read
           WHEN 'network_bound' THEN host.maximum_network_bound
         END AS value
       ) AS capacity
       CROSS JOIN LATERAL (
         SELECT count(*) AS active_runs
         FROM acp.worker_runs AS run
         WHERE run.host_identifier = host.host_identifier
           AND run.resource_class = $1
           AND run.state = 'started'
       ) AS usage
       WHERE host.state = 'active'
         AND ($3::boolean OR host.host_kind <> 'operator_laptop')
         AND host.heartbeat_at +
               make_interval(secs => host.heartbeat_ttl_seconds) >
               statement_timestamp()
         AND usage.active_runs < capacity.value
       ORDER BY
         (usage.active_runs::numeric / capacity.value),
         CASE host.host_kind WHEN 'vps' THEN 0 WHEN 'operator_laptop' THEN 1 ELSE 2 END,
         host.host_identifier
       LIMIT $2`,
      [resourceClass, limit, includeOperatorLaptop],
    );
    return result.rows.map((row) => {
      const activeRuns = Number(row.active_runs);
      return {
        hostIdentifier: row.host_identifier,
        hostKind: row.host_kind,
        resourceClass: row.resource_class,
        capacity: row.capacity,
        activeRuns,
        availableSlots: row.capacity - activeRuns,
        heartbeatAt: row.heartbeat_at.toISOString(),
      };
    });
  }

  async recordCapabilityGrant(grant: CapabilityGrantInsert): Promise<boolean> {
    const parsed = parseCapabilityGrant({ ...grant, attemptsUsed: 0 });
    const inserted = await this.pool.query(
      `INSERT INTO acp.capability_grants (
         grant_id, evaluation_id, mission_id, node_id, project_id, role,
         resource_class, allowed_operations, allowed_resources, mode,
         workspace, network_destinations, valid_from, expires_at,
         maximum_attempts, provenance_id
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11,
         $12::jsonb, $13::timestamptz, $14::timestamptz, $15, $16
       )
       ON CONFLICT (grant_id) DO NOTHING
       RETURNING grant_id`,
      [
        parsed.grantId,
        parsed.evaluationId,
        parsed.missionId,
        parsed.nodeId,
        parsed.projectId,
        parsed.role,
        parsed.resourceClass,
        JSON.stringify(parsed.allowedOperations),
        JSON.stringify(parsed.allowedResources),
        parsed.mode,
        parsed.workspace,
        JSON.stringify(parsed.networkDestinations),
        parsed.validFrom,
        parsed.expiresAt,
        parsed.maximumAttempts,
        grant.provenanceId,
      ],
    );
    if (inserted.rowCount === 1) return true;

    const existing = await this.loadGrantRow(parsed.grantId);
    if (
      existing === undefined ||
      existing.provenance_id !== grant.provenanceId ||
      grantSemanticDigest(grantFromRow(existing)) !== grantSemanticDigest(parsed)
    ) {
      throw new Error("capability grant identifier aliases different terms");
    }
    return false;
  }

  async loadCapabilityGrant(
    grantId: StableId<"capabilityGrant">,
  ): Promise<CapabilityGrant | undefined> {
    const row = await this.loadGrantRow(grantId);
    return row === undefined ? undefined : grantFromRow(row);
  }

  /** @deprecated New packets must use PostgresContextStore.buildAndRecordContextPacket. */
  async recordContextPacket(input: ContextPacketInsert): Promise<boolean> {
    const packet = parseContextPacket(input.packet);
    const inserted = await this.pool.query(
      `INSERT INTO acp.context_packets (
         context_packet_id, mission_id, node_id, schema_version, digest, packet,
         provenance_id, capability_grant_id
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       ON CONFLICT (context_packet_id) DO NOTHING
       RETURNING context_packet_id`,
      [
        packet.contextPacketId,
        packet.missionId,
        packet.nodeId,
        packet.schemaVersion,
        packet.digest,
        JSON.stringify(packet),
        input.provenanceId,
        packet.capabilityGrantId,
      ],
    );
    if (inserted.rowCount === 1) return true;

    const existing = await this.loadPacketRow(packet.contextPacketId);
    if (
      existing === undefined ||
      existing.digest !== packet.digest ||
      existing.capability_grant_id !== packet.capabilityGrantId ||
      existing.provenance_id !== input.provenanceId ||
      parseContextPacket(existing.packet).digest !== packet.digest
    ) {
      throw new Error("context packet identifier aliases different content");
    }
    return false;
  }

  async loadContextPacket(
    contextPacketId: StableId<"contextPacket">,
  ): Promise<ContextPacket | undefined> {
    const row = await this.loadPacketRow(contextPacketId);
    return row === undefined ? undefined : parseContextPacket(row.packet);
  }

  async startRun(start: WorkerRunStart): Promise<StartedWorkerRun> {
    if (!Number.isInteger(start.attemptNumber) || start.attemptNumber < 1) {
      throw new TypeError("worker attempt number must be a positive integer");
    }
    if (start.hostIdentifier.trim().length === 0) {
      throw new TypeError("worker host identifier must not be empty");
    }
    if (
      !Number.isSafeInteger(start.wallTimeMs) ||
      start.wallTimeMs < 1 ||
      start.wallTimeMs > 86_400_000
    ) {
      throw new TypeError("worker wall time must be between 1 and 86400000 ms");
    }
    const packet = parseContextPacket(start.packet);
    if (
      start.request.missionId !== packet.missionId ||
      start.request.nodeId !== packet.nodeId ||
      start.request.projectId !== packet.projectId ||
      start.request.role !== packet.workerRole ||
      start.request.resourceClass !== start.resourceClass
    ) {
      throw new Error("worker capability request does not match its context packet");
    }
    const networkDestination = start.request.networkAccess === "required"
      ? start.request.networkDestination
      : undefined;
    const launchIntent = start.launchIntent === undefined ? undefined : parseWorkerLaunchIntent(start.launchIntent);
    if (launchIntent && (!Number.isInteger(start.dispatchGeneration) || start.dispatchGeneration! < 1)) {
      throw new Error("launch intent requires an exact dispatch generation");
    }
    const sql = `INSERT INTO acp.worker_runs (
         run_id, mission_id, node_id, context_packet_id, attempt_number, state,
         started_at, provenance_id, transition_provenance_id,
         capability_grant_id, host_identifier, resource_class, operation, resource,
         requested_mode, workspace, network_destination, timeout_at${start.dispatchGeneration === undefined ? "" : ", dispatch_generation"}${launchIntent ? ", launch_worker_process_id" : ""}
       ) VALUES (
         $1, $2, $3, $4, $5, 'started', statement_timestamp(), $6, $6,
         $7, $8, $9, $10, $11, $12, $13, $14,
         statement_timestamp() + ($15::double precision * interval '1 millisecond')${start.dispatchGeneration === undefined ? "" : ", $16"}${launchIntent ? ", $17" : ""}
       )
       RETURNING run_id, started_at, timeout_at`;
    const values = [
        start.runId,
        packet.missionId,
        packet.nodeId,
        packet.contextPacketId,
        start.attemptNumber,
        start.provenanceId,
        packet.capabilityGrantId,
        start.hostIdentifier,
        start.resourceClass,
        start.request.operation,
        start.request.resource,
        start.request.mode,
        start.request.workspace,
        networkDestination ?? null,
        start.wallTimeMs,
        ...(start.dispatchGeneration === undefined ? [] : [start.dispatchGeneration]),
        ...(launchIntent ? [launchIntent.workerProcessId] : []),
      ];
    const result = launchIntent === undefined ? await this.pool.query<RunRow>(sql, values)
      : await withTransaction(this.pool, async (client) => {
        const admitted = await client.query<RunRow>(sql, values);
        const inserted = await client.query<{ worker_process_id: string; directory_path: string; directory_identity: string; supervision_scope: unknown }>(
          `INSERT INTO acp.worker_launch_intents(run_id, worker_process_id, protocol, directory_path, directory_identity, supervision_scope)
           VALUES($1, $2, 'windows_fence_v1', $3, $4, $5::jsonb)
           RETURNING worker_process_id, directory_path, directory_identity, supervision_scope`,
          [start.runId, launchIntent.workerProcessId, launchIntent.fence.directory, launchIntent.fence.directoryIdentity, JSON.stringify(launchIntent.fence.scope)]);
        const intentRow = inserted.rows[0];
        if (!intentRow || !isDeepStrictEqual(parseWorkerLaunchIntent({ workerProcessId: intentRow.worker_process_id,
          fence: { directory: intentRow.directory_path, directoryIdentity: intentRow.directory_identity, scope: intentRow.supervision_scope } }),
            launchIntent)) throw new Error("launch intent was not persisted with its exact identity");
        const runRow = admitted.rows[0];
        if (!runRow || runRow.run_id !== start.runId) throw new Error("worker run was not persisted with its exact identity");
        return admitted;
      });
    const row = result.rows[0];
    if (row === undefined || row.run_id !== start.runId) {
      throw new Error("worker run was not persisted with its exact identity");
    }
    return {
      ...(launchIntent === undefined ? {} : { launchIntent }),
      runId: row.run_id,
      startedAt: row.started_at.toISOString(),
      timeoutAt: row.timeout_at.toISOString(),
    };
  }

  async completeRun(completion: WorkerRunCompletion): Promise<boolean> {
    const result = parseWorkerResult(completion.result);
    return withTransaction(this.pool, async (client) => {
      // Match admission/replay ordering before locking the run. The terminal
      // trigger subsequently projects dispatch and node state in this transaction.
      await client.query(`SELECT mission.mission_id FROM acp.missions mission JOIN acp.worker_runs run USING (mission_id)
        WHERE run.run_id = $1 FOR UPDATE OF mission`, [result.runId]);
      await client.query(`SELECT node.node_id FROM acp.mission_nodes node JOIN acp.worker_runs run
        ON run.node_id = node.node_id AND run.mission_id = node.mission_id
        WHERE run.run_id = $1 FOR UPDATE OF node`, [result.runId]);
      const updated = await client.query(
        `UPDATE acp.worker_runs
         SET state = $2, result = $3::jsonb, completed_at = $4::timestamptz,
             transition_provenance_id = $5
         WHERE run_id = $1 AND state = 'started'
         RETURNING run_id`,
        [
          result.runId,
          result.status,
          JSON.stringify(result),
          completion.completedAt,
          completion.transitionProvenanceId,
        ],
      );
      if (updated.rowCount === 1) return true;

      const existing = await client.query<RunRow>(
        `SELECT run_id, mission_id, node_id, context_packet_id, attempt_number,
                state, result, started_at, timeout_at, provenance_id
         FROM acp.worker_runs WHERE run_id = $1 FOR UPDATE`,
        [result.runId],
      );
      const row = existing.rows[0];
      if (row === undefined) throw new Error("worker run does not exist");
      const prior = row.result === null ? undefined : parseWorkerResult(row.result);
      if (prior?.digest !== result.digest) {
        throw new Error("worker run already has a different terminal result");
      }
      return false;
    });
  }

  async listAbandonedRuns(
    at: string,
    limit = 100,
  ): Promise<readonly AbandonedWorkerRun[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new TypeError("abandoned-run limit must be between 1 and 1000");
    }
    const result = await this.pool.query<RunRow>(
      `SELECT run_id, mission_id, node_id, context_packet_id, attempt_number,
              state, result, started_at, timeout_at, provenance_id
       FROM acp.worker_runs
       WHERE state = 'started' AND timeout_at <= $1::timestamptz
       ORDER BY timeout_at, run_id
       LIMIT $2`,
      [at, limit],
    );
    return result.rows.map((row) => ({
      runId: row.run_id,
      missionId: row.mission_id,
      nodeId: row.node_id,
      contextPacketId: row.context_packet_id,
      attemptNumber: row.attempt_number,
      timeoutAt: row.timeout_at.toISOString(),
      provenanceId: row.provenance_id,
    }));
  }

  async recordWorkerProcessFromRun(
    registration: WorkerProcessRegistration,
  ): Promise<WorkerProcessRecord> {
    assertWorkerProcessIdentity(
      registration.processId,
      registration.processStartToken,
    );
    if (registration.purpose.trim().length === 0) {
      throw new TypeError("worker process purpose must not be empty");
    }
    const startedAt = parseTimestamp(registration.startedAt, "worker process start");
    const inserted = await this.pool.query<ProcessRow>(
      `INSERT INTO acp.worker_processes (
         worker_process_id, run_id, mission_id, node_id, process_id,
         process_start_token, purpose, host_identifier, resource_class, state,
         started_at, deadline_at, heartbeat_at, provenance_id,
         transition_provenance_id${registration.supervision === undefined ? "" : ", supervision_kind, tree_identifier, supervision_scope"}
       )
       SELECT $1, run.run_id, run.mission_id, run.node_id, $3, $4, $5,
              run.host_identifier, run.resource_class, 'running',
              $6::timestamptz, run.timeout_at, statement_timestamp(),
              $7::acp.stable_id, $8::acp.stable_id${registration.supervision === undefined ? "" : ", $9, $10, $11::jsonb"}
       FROM acp.worker_runs AS run
       WHERE run.run_id = $2
         AND run.state = 'started'
         AND run.provenance_id = $7::acp.stable_id
         AND statement_timestamp() < run.timeout_at
       ON CONFLICT (worker_process_id) DO NOTHING
       RETURNING *`,
      [
        registration.workerProcessId,
        registration.runId,
        registration.processId,
        registration.processStartToken,
        registration.purpose,
        startedAt,
        registration.provenanceId,
        registration.transitionProvenanceId,
        ...(registration.supervision === undefined ? [] : [registration.supervision.kind, registration.supervision.treeIdentifier,
          JSON.stringify(registration.supervision.scope ?? null)]),
      ],
    );
    const row = inserted.rows[0];
    if (row !== undefined) return processFromRow(row);

    const existing = await this.loadProcessRow(registration.workerProcessId);
    if (
      existing === undefined ||
      existing.run_id !== registration.runId ||
      Number(existing.process_id) !== registration.processId ||
      existing.process_start_token !== registration.processStartToken ||
      existing.purpose !== registration.purpose ||
      existing.started_at.toISOString() !== startedAt ||
      existing.provenance_id !== registration.provenanceId ||
      existing.transition_provenance_id !== registration.transitionProvenanceId
      || (existing.supervision_kind ?? undefined) !== registration.supervision?.kind
      || (existing.tree_identifier ?? undefined) !== registration.supervision?.treeIdentifier
      || canonicalJsonDigest(existing.supervision_scope ? { ...existing.supervision_scope } : null)
        !== canonicalJsonDigest(registration.supervision?.scope ? { ...registration.supervision.scope } : null)
    ) {
      throw new Error(
        "worker process was not persisted or its identifier aliases another process",
      );
    }
    return processFromRow(existing);
  }

  async loadWorkerProcess(workerProcessId: StableId<"workerProcess">): Promise<WorkerProcessRecord | undefined> {
    const row = await this.loadProcessRow(workerProcessId);
    return row === undefined ? undefined : processFromRow(row);
  }

  async heartbeatWorkerProcess(
    workerProcessId: StableId<"workerProcess">,
    processId: number,
    processStartToken: string,
  ): Promise<string> {
    assertWorkerProcessIdentity(processId, processStartToken);
    const result = await this.pool.query<{ readonly heartbeat_at: Date }>(
      `UPDATE acp.worker_processes
       SET heartbeat_at = statement_timestamp()
       WHERE worker_process_id = $1
         AND process_id = $2
         AND process_start_token = $3
         AND state = 'running'
         AND (
           reconciliation_id IS NULL
           OR heartbeat_at > reconciliation_claimed_at
         )
         AND statement_timestamp() < deadline_at
       RETURNING heartbeat_at`,
      [workerProcessId, processId, processStartToken],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("matching live worker process does not exist");
    }
    return row.heartbeat_at.toISOString();
  }

  async finishWorkerProcess(
    completion: WorkerProcessCompletion,
  ): Promise<boolean> {
    assertWorkerProcessCompletion(completion);
    const updated = await this.pool.query<ProcessRow>(
      `UPDATE acp.worker_processes
       SET state = $4,
           heartbeat_at = statement_timestamp(),
           completed_at = statement_timestamp(),
           exit_code = $5,
           termination_reason = $6,
           transition_provenance_id = $7
       WHERE worker_process_id = $1
         AND process_id = $2
         AND process_start_token = $3
         AND state = 'running'
         AND (
           reconciliation_id IS NULL
           OR heartbeat_at > reconciliation_claimed_at
         )
       RETURNING *`,
      [
        completion.workerProcessId,
        completion.processId,
        completion.processStartToken,
        completion.state,
        completion.exitCode ?? null,
        completion.terminationReason,
        completion.transitionProvenanceId,
      ],
    );
    if (updated.rowCount === 1) return true;

    const existing = await this.loadProcessRow(completion.workerProcessId);
    if (
      existing === undefined ||
      Number(existing.process_id) !== completion.processId ||
      existing.process_start_token !== completion.processStartToken ||
      existing.state !== completion.state ||
      existing.exit_code !== (completion.exitCode ?? null) ||
      existing.termination_reason !== completion.terminationReason ||
      existing.transition_provenance_id !== completion.transitionProvenanceId
    ) {
      throw new Error("worker process already has a different terminal state");
    }
    return false;
  }

  async listWorkerProcessesNeedingReconciliation(
    hostIdentifier: string,
    staleAfterSeconds: number,
    limit = 100,
  ): Promise<readonly WorkerProcessReconciliationCandidate[]> {
    assertHostAndBoundedQuery(hostIdentifier, staleAfterSeconds, limit);
    const result = await this.pool.query<ProcessRow>(
      `SELECT process.*,
              CASE
                WHEN process.deadline_at <= statement_timestamp()
                  THEN 'deadline_expired'
                ELSE 'heartbeat_stale'
              END AS reconciliation_reason
       FROM acp.worker_processes AS process
       WHERE process.host_identifier = $1
         AND process.state = 'running'
         AND (
           process.deadline_at <= statement_timestamp()
           OR process.heartbeat_at + make_interval(secs => $2) <=
                statement_timestamp()
         )
       ORDER BY process.deadline_at, process.heartbeat_at,
                process.worker_process_id
       LIMIT $3`,
      [hostIdentifier, staleAfterSeconds, limit],
    );
    return result.rows.map((row) => ({
      ...processFromRow(row),
      reason: row.reconciliation_reason ?? "heartbeat_stale",
    }));
  }

  async claimWorkerProcessesNeedingReconciliation(input: {
    readonly workerProcessId?: StableId<"workerProcess">;
    readonly hostIdentifier: string;
    readonly staleAfterSeconds: number;
    readonly claimTtlSeconds: number;
    readonly limit?: number;
    readonly reconciliationId: StableId<"reconciliation">;
    readonly reconciliationOwner: string;
    readonly reconciliationProvenanceId: StableId<"provenance">;
  }): Promise<readonly WorkerProcessReconciliationClaim[]> {
    const limit = input.limit ?? 100;
    if (input.workerProcessId !== undefined) parseStableId(input.workerProcessId, "workerProcess");
    assertHostAndBoundedQuery(
      input.hostIdentifier,
      input.staleAfterSeconds,
      limit,
    );
    if (
      !Number.isSafeInteger(input.claimTtlSeconds) ||
      input.claimTtlSeconds < 5 ||
      input.claimTtlSeconds > 300
    ) {
      throw new TypeError("process reconciliation claim TTL must be between 5 and 300 seconds");
    }
    if (input.reconciliationOwner.trim().length === 0) {
      throw new TypeError("process reconciliation owner must not be empty");
    }
    const result = await this.pool.query<ProcessRow>(
      `WITH candidates AS (
         SELECT process.worker_process_id,
                CASE
                  WHEN process.deadline_at <= statement_timestamp()
                    THEN 'deadline_expired'
                  WHEN acp.worker_run_handed_off(process.run_id) THEN 'owner_handoff'
                  ELSE 'heartbeat_stale'
                END AS reconciliation_reason
         FROM acp.worker_processes AS process
         WHERE process.host_identifier = $1
           ${input.workerProcessId === undefined ? "" : "AND process.worker_process_id = $8"}
           AND process.state = 'running'
           AND (
             process.deadline_at <= statement_timestamp()
             OR process.heartbeat_at + make_interval(secs => $2) <=
                  statement_timestamp()
             OR acp.worker_run_handed_off(process.run_id)
           )
           AND (
             process.reconciliation_id IS NULL
             OR process.reconciliation_claim_expires_at <= statement_timestamp()
           )
         ORDER BY process.deadline_at, process.heartbeat_at,
                  process.worker_process_id
         FOR UPDATE SKIP LOCKED
         LIMIT $3
       )
       UPDATE acp.worker_processes AS process
       SET reconciliation_id = $4,
           reconciliation_owner = $5,
           reconciliation_claimed_at = statement_timestamp(),
           reconciliation_claim_expires_at = statement_timestamp() +
             ($6::double precision * interval '1 second'),
           reconciliation_provenance_id = $7
       FROM candidates
       WHERE process.worker_process_id = candidates.worker_process_id
       RETURNING process.*, candidates.reconciliation_reason`,
      [
        input.hostIdentifier,
        input.staleAfterSeconds,
        limit,
        input.reconciliationId,
        input.reconciliationOwner,
        input.claimTtlSeconds,
        input.reconciliationProvenanceId,
        ...(input.workerProcessId === undefined ? [] : [input.workerProcessId]),
      ],
    );
    return result.rows.map((row) => {
      if (
        row.reconciliation_id === null ||
        row.reconciliation_owner === null ||
        row.reconciliation_claimed_at === null ||
        row.reconciliation_claim_expires_at === null ||
        row.reconciliation_provenance_id === null
      ) {
        throw new Error("database returned an incomplete reconciliation claim");
      }
      return {
        ...processFromRow(row),
        reason: row.reconciliation_reason ?? "heartbeat_stale",
        reconciliationId: row.reconciliation_id,
        reconciliationOwner: row.reconciliation_owner,
        reconciliationClaimedAt: row.reconciliation_claimed_at.toISOString(),
        reconciliationClaimExpiresAt:
          row.reconciliation_claim_expires_at.toISOString(),
        reconciliationProvenanceId: row.reconciliation_provenance_id,
      };
    });
  }

  async reconcileClaimedWorkerProcess(
    workerProcessId: StableId<"workerProcess">,
    reconciliationId: StableId<"reconciliation">,
    observe: (
      claim: WorkerProcessReconciliationClaim,
      signal: AbortSignal,
    ) => Promise<WorkerProcessReconciliationObservation>,
    authority?: WorkerRecoveryAuthority,
  ): Promise<WorkerProcessReconciliationResult> {
    const client = await this.pool.connect();
    let acquired = false;
    let broken = false;
    let transaction = false;
    const controller = new AbortController();
    const connectionFailed = () => { broken = true; controller.abort(new Error("recovery database session lost")); };
    client.on?.("error", connectionFailed);
    let observationTimer: NodeJS.Timeout | undefined;
    let observing: Promise<WorkerProcessReconciliationObservation> | undefined;
    try {
      const lock = await client.query<{ readonly acquired: boolean }>(
        `SELECT pg_try_advisory_lock(
           hashtextextended('acp:worker-process-reconciliation:' || $1, 0)
         ) AS acquired`,
        [workerProcessId],
      );
      acquired = lock.rows[0]?.acquired === true;
      if (!acquired) return { state: "busy" };

      const current = await client.query<ProcessRow & { claimed_at_exact: string; expires_at_exact: string }>(
        `SELECT process.*, process.reconciliation_claimed_at::text AS claimed_at_exact,
                process.reconciliation_claim_expires_at::text AS expires_at_exact,
                extract(epoch FROM (process.reconciliation_claim_expires_at - clock_timestamp())) * 1000 AS claim_remaining_ms,
                CASE
                  WHEN process.deadline_at <= statement_timestamp()
                    THEN 'deadline_expired'
                  WHEN acp.worker_run_handed_off(process.run_id) THEN 'owner_handoff'
                  ELSE 'heartbeat_stale'
                END AS reconciliation_reason
         FROM acp.worker_processes AS process
         WHERE process.worker_process_id = $1
           AND process.reconciliation_id = $2
           AND process.state = 'running'
           AND process.reconciliation_claim_expires_at > statement_timestamp()
           ${authority === undefined ? "" : `AND acp.worker_run_recovery_eligible(process.run_id)
             AND process.reconciliation_owner = $4::text
             AND acp.worker_recovery_runtime_live(process.run_id, $3, $4::acp.stable_id, $5)`}
           AND (
             process.deadline_at <= statement_timestamp()
             OR process.heartbeat_at <= process.reconciliation_claimed_at
           )`,
        [workerProcessId, reconciliationId, ...(authority === undefined ? [] : [authority.hostIdentifier, authority.sessionId, authority.applicationVersion])],
      );
      const row = current.rows[0];
      if (
        row === undefined ||
        row.reconciliation_id === null ||
        row.reconciliation_owner === null ||
        row.reconciliation_claimed_at === null ||
        row.reconciliation_claim_expires_at === null ||
        row.reconciliation_provenance_id === null
      ) {
        return { state: "stale_claim" };
      }
      const claim: WorkerProcessReconciliationClaim = {
        ...processFromRow(row),
        reason: row.reconciliation_reason ?? "heartbeat_stale",
        reconciliationId: row.reconciliation_id,
        reconciliationOwner: row.reconciliation_owner,
        reconciliationClaimedAt: row.reconciliation_claimed_at.toISOString(),
        reconciliationClaimExpiresAt:
          row.reconciliation_claim_expires_at.toISOString(),
        reconciliationProvenanceId: row.reconciliation_provenance_id,
      };
      const budget = Math.min(14000, Number(row.claim_remaining_ms ?? 15000) - 1000);
      if (!Number.isFinite(budget) || budget <= 0 || controller.signal.aborted) return { state: "stale_claim" };
      observationTimer = setTimeout(() => controller.abort(new Error("recovery observation deadline elapsed")), budget);
      const aborted = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("process recovery observation unconfirmed")), { once: true });
      });
      observing = observe(claim, controller.signal);
      const observation = await Promise.race([aborted, observing]);
      if (controller.signal.aborted) throw new Error("process recovery observation unconfirmed");
      if (authority !== undefined) {
        // Never hold row locks through native I/O. After inspection, fence
        // session retirement and host state changes before the final statement.
        transaction = true; // BEGIN may execute even when its acknowledgement is lost.
        await client.query("BEGIN");
        await client.query("SELECT host_identifier FROM acp.worker_host_sessions WHERE host_identifier = $1 FOR SHARE", [authority.hostIdentifier]);
        await client.query("SELECT host_identifier FROM acp.worker_hosts WHERE host_identifier = $1 FOR SHARE", [authority.hostIdentifier]);
        await client.query("SELECT worker_process_id FROM acp.worker_processes WHERE worker_process_id = $1 FOR UPDATE", [workerProcessId]);
      }
      if (controller.signal.aborted) throw new Error("process recovery observation unconfirmed");
      if (observation.state === "running") {
        if (claim.reason === "deadline_expired") {
          throw new Error(
            "deadline-expired reconciliation requires a terminal observation",
          );
        }
        const heartbeat = await client.query<{ readonly heartbeat_at: Date }>(
          `UPDATE acp.worker_processes
           SET heartbeat_at = statement_timestamp()
           WHERE worker_process_id = $1
             AND process_id = $2
             AND process_start_token = $3
             AND state = 'running'
             AND reconciliation_id = $4
             AND reconciliation_owner = $5
             AND reconciliation_provenance_id = $6
             AND reconciliation_claimed_at = $7::timestamptz
             AND reconciliation_claim_expires_at = $8::timestamptz
             AND reconciliation_claim_expires_at > clock_timestamp()
             ${authority === undefined ? "" : "AND acp.worker_recovery_runtime_live(run_id, $9, $10::acp.stable_id, $11)"}
           RETURNING heartbeat_at`,
          [
            claim.workerProcessId,
            claim.processId,
            claim.processStartToken,
            claim.reconciliationId,
            claim.reconciliationOwner,
            claim.reconciliationProvenanceId,
            row.claimed_at_exact ?? claim.reconciliationClaimedAt,
            row.expires_at_exact ?? claim.reconciliationClaimExpiresAt,
            ...(authority === undefined ? [] : [authority.hostIdentifier, authority.sessionId, authority.applicationVersion]),
          ],
        );
        const heartbeatAt = heartbeat.rows[0]?.heartbeat_at;
        if (transaction) { await client.query("COMMIT"); transaction = false; }
        if (heartbeatAt === undefined) return { state: "stale_claim" };
        return { state: "healthy", heartbeatAt: heartbeatAt.toISOString() };
      }

      const completion: WorkerProcessCompletion = {
        workerProcessId: claim.workerProcessId,
        processId: claim.processId,
        processStartToken: claim.processStartToken,
        state: observation.state,
        ...(observation.exitCode === undefined
          ? {}
          : { exitCode: observation.exitCode }),
        terminationReason: observation.terminationReason,
        transitionProvenanceId: observation.transitionProvenanceId,
      };
      assertWorkerProcessCompletion(completion);
      const terminal = await client.query(
        `UPDATE acp.worker_processes
         SET state = $7,
             heartbeat_at = statement_timestamp(),
             completed_at = statement_timestamp(),
             exit_code = $8,
             termination_reason = $9,
             transition_provenance_id = $10
         WHERE worker_process_id = $1
           AND process_id = $2
           AND process_start_token = $3
           AND state = 'running'
           AND reconciliation_id = $4
           AND reconciliation_owner = $5
           AND reconciliation_provenance_id = $6
           AND reconciliation_claimed_at = $11::timestamptz
           AND reconciliation_claim_expires_at = $12::timestamptz
           AND reconciliation_claim_expires_at > clock_timestamp()
           ${authority === undefined ? "" : "AND acp.worker_recovery_runtime_live(run_id, $13, $14::acp.stable_id, $15)"}
         RETURNING worker_process_id`,
        [
          claim.workerProcessId,
          claim.processId,
          claim.processStartToken,
          claim.reconciliationId,
          claim.reconciliationOwner,
          claim.reconciliationProvenanceId,
          completion.state,
          completion.exitCode ?? null,
          completion.terminationReason,
          completion.transitionProvenanceId,
          row.claimed_at_exact ?? claim.reconciliationClaimedAt,
          row.expires_at_exact ?? claim.reconciliationClaimExpiresAt,
          ...(authority === undefined ? [] : [authority.hostIdentifier, authority.sessionId, authority.applicationVersion]),
        ],
      );
      if (transaction) { await client.query("COMMIT"); transaction = false; }
      if (terminal.rowCount !== 1) return { state: "stale_claim" };
      return { state: "terminalized", processState: completion.state };
    } finally {
      if (observationTimer) clearTimeout(observationTimer);
      controller.abort();
      try {
        // A native inspector resolves only after its helper closes. Do not let
        // shutdown overtake that owned-process cleanup after DB loss or expiry.
        if (observing !== undefined) {
          let cleanupTimer: NodeJS.Timeout | undefined;
          try {
            await Promise.race([observing.then(() => {}, () => {}), new Promise<never>((_resolve, reject) => {
              cleanupTimer = setTimeout(() => reject(new Error("process recovery observer cleanup unconfirmed")), 2000);
            })]);
          } finally { if (cleanupTimer) clearTimeout(cleanupTimer); }
        }
        if (transaction && !broken) await client.query("ROLLBACK");
        if (acquired && !broken) {
          await client.query(
            `SELECT pg_advisory_unlock(
               hashtextextended('acp:worker-process-reconciliation:' || $1, 0)
             )`,
            [workerProcessId],
          );
        }
      } catch (error) {
        broken = true; throw error;
      } finally {
        client.off?.("error", connectionFailed);
        client.release(broken);
      }
    }
  }

  /** A diagnostic gap is only a hint. Recheck ownership and stop evidence under admission locks. */
  async recoverStoppedRun(input: { readonly runId: StableId<"run">; readonly hostIdentifier: string;
    readonly transitionProvenanceId: StableId<"provenance">; readonly authority: WorkerRecoveryAuthority }): Promise<"recovered" | "already_terminal" | "pending"> {
    parseStableId(input.runId, "run"); parseStableId(input.transitionProvenanceId, "provenance");
    if (input.hostIdentifier !== input.authority.hostIdentifier) throw new TypeError("recovery authority host mismatch");
    return withTransaction(this.pool, async (client) => {
      await client.query(`SELECT m.mission_id FROM acp.missions m JOIN acp.worker_runs r USING (mission_id)
        WHERE r.run_id = $1 AND r.host_identifier = $2 FOR UPDATE OF m`, [input.runId, input.hostIdentifier]);
      await client.query(`SELECT n.node_id FROM acp.mission_nodes n JOIN acp.worker_runs r ON r.node_id = n.node_id
        WHERE r.run_id = $1 AND r.host_identifier = $2 FOR UPDATE OF n`, [input.runId, input.hostIdentifier]);
      const locked = await client.query<RunRow>("SELECT * FROM acp.worker_runs WHERE run_id = $1 AND host_identifier = $2 FOR UPDATE", [input.runId, input.hostIdentifier]);
      const run = locked.rows[0]; if (!run) return "pending";
      if (run.state !== "started") return "already_terminal";
      await client.query("SELECT host_identifier FROM acp.worker_host_sessions WHERE host_identifier = $1 FOR SHARE", [input.hostIdentifier]);
      await client.query("SELECT host_identifier FROM acp.worker_hosts WHERE host_identifier = $1 FOR SHARE", [input.hostIdentifier]);
      const facts = await client.query(`SELECT p.packet, clock_timestamp() AS observed_at,
        (m.state = 'cancelled' OR n.state = 'cancelled' OR acp.worker_cancellation_requested(m.mission_id, n.graph_revision)) AS cancelled
        FROM acp.worker_runs r JOIN acp.context_packets p USING (context_packet_id)
        JOIN acp.missions m ON m.mission_id = r.mission_id JOIN acp.mission_nodes n ON n.node_id = r.node_id
        WHERE r.run_id = $1 AND acp.worker_run_recovery_eligible(r.run_id)
          AND to_jsonb(r) ->> 'launch_worker_process_id' IS NULL
          AND acp.worker_recovery_runtime_live(r.run_id, $2, $3::acp.stable_id, $4)
          AND EXISTS (SELECT 1 FROM acp.worker_processes wp WHERE wp.run_id = r.run_id AND wp.supervision_kind = 'windows_job' AND wp.state <> 'running')
          AND NOT EXISTS (SELECT 1 FROM acp.worker_processes wp WHERE wp.run_id = r.run_id AND wp.state = 'running')`,
      [input.runId, input.hostIdentifier, input.authority.sessionId, input.authority.applicationVersion]);
      const fact = facts.rows[0]; if (!fact) return "pending";
      const observedAt = fact.observed_at as Date;
      const result = createWorkerFailureResult({ runId: input.runId, packet: parseContextPacket(fact.packet), attemptNumber: run.attempt_number,
        status: fact.cancelled ? "cancelled" : "failed", code: fact.cancelled ? "terminated" : observedAt >= run.timeout_at ? "timeout" : "terminated",
        conclusion: "The prior worker owner ended without a durable result; its recorded process tree is stopped. No success was inferred.",
        wallMilliseconds: Math.max(0, observedAt.getTime() - run.started_at.getTime()) });
      await client.query(`UPDATE acp.worker_runs SET state = $2, result = $3::jsonb,
        completed_at = $4::timestamptz, transition_provenance_id = $5 WHERE run_id = $1`,
      [input.runId, result.status, JSON.stringify(result), observedAt.toISOString(), input.transitionProvenanceId]);
      return "recovered";
    });
  }

  async listUnjournaledRuns(
    hostIdentifier: string,
    spawnGraceSeconds: number,
    limit = 100,
  ): Promise<readonly UnjournaledWorkerRun[]> {
    assertHostAndBoundedQuery(hostIdentifier, spawnGraceSeconds, limit);
    const result = await this.pool.query<RunRow & {
      readonly host_identifier: string;
      readonly resource_class: WorkerResourceClass;
    }>(
      `SELECT run_id, mission_id, node_id, context_packet_id, attempt_number,
              state, result, started_at, timeout_at, provenance_id,
              host_identifier, resource_class
       FROM acp.worker_runs AS run
       WHERE run.host_identifier = $1
         AND run.state = 'started'
         AND run.started_at + make_interval(secs => $2) <=
               statement_timestamp()
         AND NOT EXISTS (
           SELECT 1 FROM acp.worker_processes AS process
           WHERE process.run_id = run.run_id
         )
       ORDER BY run.started_at, run.run_id
       LIMIT $3`,
      [hostIdentifier, spawnGraceSeconds, limit],
    );
    return result.rows.map((row) => ({
      runId: row.run_id,
      missionId: row.mission_id,
      nodeId: row.node_id,
      contextPacketId: row.context_packet_id,
      attemptNumber: row.attempt_number,
      startedAt: row.started_at.toISOString(),
      timeoutAt: row.timeout_at.toISOString(),
      hostIdentifier: row.host_identifier,
      resourceClass: row.resource_class,
      provenanceId: row.provenance_id,
    }));
  }

  async listWorkerRunProjectionGaps(
    hostIdentifier: string,
    limit = 100,
  ): Promise<readonly WorkerRunProjectionGap[]> {
    if (hostIdentifier.trim().length === 0) {
      throw new TypeError("worker host identifier must not be empty");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new TypeError("projection-gap limit must be between 1 and 1000");
    }
    const result = await this.pool.query<RunRow & {
      readonly host_identifier: string;
      readonly resource_class: WorkerResourceClass;
      readonly worker_process_id: StableId<"workerProcess">;
      readonly process_state: WorkerProcessTerminalState;
      readonly process_completed_at: Date;
      readonly process_exit_code: number | null;
      readonly process_termination_reason: string;
    }>(
      `SELECT run.run_id, run.mission_id, run.node_id, run.context_packet_id,
              run.attempt_number, run.state, run.result, run.started_at,
              run.timeout_at, run.provenance_id, run.host_identifier,
              run.resource_class, process.worker_process_id,
              process.state AS process_state,
              process.completed_at AS process_completed_at,
              process.exit_code AS process_exit_code,
              process.termination_reason AS process_termination_reason
       FROM acp.worker_runs AS run
       JOIN acp.worker_processes AS process ON process.run_id = run.run_id
       WHERE run.host_identifier = $1
         AND run.state = 'started'
         AND process.state <> 'running'
       ORDER BY process.completed_at, run.run_id
       LIMIT $2`,
      [hostIdentifier, limit],
    );
    return result.rows.map((row) => ({
      runId: row.run_id,
      missionId: row.mission_id,
      nodeId: row.node_id,
      contextPacketId: row.context_packet_id,
      attemptNumber: row.attempt_number,
      startedAt: row.started_at.toISOString(),
      timeoutAt: row.timeout_at.toISOString(),
      hostIdentifier: row.host_identifier,
      resourceClass: row.resource_class,
      provenanceId: row.provenance_id,
      workerProcessId: row.worker_process_id,
      processState: row.process_state,
      processCompletedAt: row.process_completed_at.toISOString(),
      ...(row.process_exit_code === null
        ? {}
        : { processExitCode: row.process_exit_code }),
      processTerminationReason: row.process_termination_reason,
    }));
  }

  private async loadGrantRow(
    grantId: StableId<"capabilityGrant">,
  ): Promise<GrantRow | undefined> {
    const result = await this.pool.query<GrantRow>(
      `SELECT g.grant_id, g.evaluation_id, g.mission_id, g.node_id, g.project_id,
              g.role, g.resource_class, g.allowed_operations,
              g.allowed_resources,
              g.mode, g.workspace, g.network_destinations,
              g.valid_from, g.expires_at, g.maximum_attempts,
              g.provenance_id, count(uses.run_id)::text AS attempts_used
       FROM acp.capability_grants AS g
       LEFT JOIN acp.capability_grant_uses AS uses
         ON uses.grant_id = g.grant_id
       WHERE g.grant_id = $1
       GROUP BY g.grant_id`,
      [grantId],
    );
    return result.rows[0];
  }

  private async loadPacketRow(
    contextPacketId: StableId<"contextPacket">,
  ): Promise<PacketRow | undefined> {
    const result = await this.pool.query<PacketRow>(
      `SELECT packet, digest, capability_grant_id, provenance_id
       FROM acp.context_packets WHERE context_packet_id = $1`,
      [contextPacketId],
    );
    return result.rows[0];
  }

  private async loadProcessRow(
    workerProcessId: StableId<"workerProcess">,
  ): Promise<ProcessRow | undefined> {
    const result = await this.pool.query<ProcessRow>(
      `SELECT * FROM acp.worker_processes WHERE worker_process_id = $1`,
      [workerProcessId],
    );
    return result.rows[0];
  }
}

function grantFromRow(row: GrantRow): CapabilityGrant {
  return parseCapabilityGrant({
    grantId: row.grant_id,
    evaluationId: row.evaluation_id,
    missionId: row.mission_id,
    nodeId: row.node_id,
    projectId: row.project_id,
    role: row.role,
    resourceClass: row.resource_class,
    allowedOperations: row.allowed_operations,
    allowedResources: row.allowed_resources,
    mode: row.mode,
    workspace: row.workspace,
    networkDestinations: row.network_destinations,
    validFrom: row.valid_from.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    maximumAttempts: row.maximum_attempts,
    attemptsUsed: Number(row.attempts_used),
  });
}

function grantSemanticDigest(grant: CapabilityGrant): string {
  const { attemptsUsed: _attemptsUsed, ...terms } = grant;
  return canonicalJsonDigest(terms);
}

function assertHostRegistration(host: WorkerHostRegistration): void {
  if (host.hostIdentifier.trim().length === 0) {
    throw new TypeError("worker host identifier must not be empty");
  }
  for (const [label, value] of [
    ["maximumCpuIntensive", host.maximumCpuIntensive],
    ["maximumModerateCompute", host.maximumModerateCompute],
    ["maximumLightweightRead", host.maximumLightweightRead],
    ["maximumNetworkBound", host.maximumNetworkBound],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`${label} must be a positive integer`);
    }
  }
  if (
    !Number.isSafeInteger(host.heartbeatTtlSeconds) ||
    host.heartbeatTtlSeconds < 5 ||
    host.heartbeatTtlSeconds > 300
  ) {
    throw new TypeError("heartbeatTtlSeconds must be between 5 and 300");
  }
}

function assertResourceClass(value: string): asserts value is WorkerResourceClass {
  if (![
    "cpu_intensive",
    "moderate_compute",
    "lightweight_read",
    "network_bound",
  ].includes(value)) {
    throw new TypeError("unknown worker resource class");
  }
}

function assertWorkerProcessIdentity(
  processId: number,
  processStartToken: string,
): void {
  if (!Number.isSafeInteger(processId) || processId < 1) {
    throw new TypeError("worker process id must be a positive safe integer");
  }
  if (processStartToken.trim().length === 0) {
    throw new TypeError("worker process start token must not be empty");
  }
}

function assertWorkerProcessCompletion(
  completion: WorkerProcessCompletion,
): void {
  assertWorkerProcessIdentity(
    completion.processId,
    completion.processStartToken,
  );
  if (completion.terminationReason.trim().length === 0) {
    throw new TypeError("worker process termination reason must not be empty");
  }
  if (
    completion.exitCode !== undefined &&
    (!Number.isSafeInteger(completion.exitCode) ||
      completion.exitCode < -2_147_483_648 ||
      completion.exitCode > 2_147_483_647)
  ) {
    throw new TypeError("worker process exit code must be a 32-bit integer");
  }
  if (completion.state === "exited" && completion.exitCode === undefined) {
    throw new TypeError("exited worker process requires an exit code");
  }
  if (completion.state === "lost" && completion.exitCode !== undefined) {
    throw new TypeError("lost worker process cannot have an exit code");
  }
}

function parseTimestamp(value: string, label: string): string {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.valueOf())) {
    throw new TypeError(`${label} must be an ISO timestamp`);
  }
  return timestamp.toISOString();
}

function assertHostAndBoundedQuery(
  hostIdentifier: string,
  seconds: number,
  limit: number,
): void {
  if (hostIdentifier.trim().length === 0) {
    throw new TypeError("worker host identifier must not be empty");
  }
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 86_400) {
    throw new TypeError("reconciliation interval must be between 1 and 86400 seconds");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new TypeError("reconciliation limit must be between 1 and 1000");
  }
}

function processFromRow(row: ProcessRow): WorkerProcessRecord {
  const processId = Number(row.process_id);
  if (!Number.isSafeInteger(processId) || processId < 1) {
    throw new Error("database returned an unsafe worker process id");
  }
  return {
    workerProcessId: row.worker_process_id,
    ...(row.supervision_kind === undefined || row.supervision_kind === null ? {} : {
      supervision: { kind: row.supervision_kind, treeIdentifier: row.tree_identifier!,
        ...(row.supervision_scope == null ? {} : { scope: row.supervision_scope }) },
    }),
    runId: row.run_id,
    missionId: row.mission_id,
    nodeId: row.node_id,
    processId,
    processStartToken: row.process_start_token,
    purpose: row.purpose,
    hostIdentifier: row.host_identifier,
    resourceClass: row.resource_class,
    state: row.state,
    startedAt: row.started_at.toISOString(),
    recordedAt: row.recorded_at.toISOString(),
    deadlineAt: row.deadline_at.toISOString(),
    heartbeatAt: row.heartbeat_at.toISOString(),
    ...(row.completed_at === null
      ? {}
      : { completedAt: row.completed_at.toISOString() }),
    ...(row.exit_code === null ? {} : { exitCode: row.exit_code }),
    ...(row.termination_reason === null
      ? {}
      : { terminationReason: row.termination_reason }),
    provenanceId: row.provenance_id,
    transitionProvenanceId: row.transition_provenance_id,
  };
}
