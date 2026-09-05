import { createStableId, parseStableId, type StableId } from "@acp/domain";
import type { Pool } from "pg";
import { PostgresDispatchStore, type DispatchMessage, type HostRuntimeRegistration } from "./dispatch-store.ts";
import { withTransaction } from "./database.ts";
import { PostgresWorkerRuntimeStore, type WorkerProcessReconciliationClaim } from "./worker-runtime-store.ts";

export interface WorkerRecoveryCandidate {
  readonly workerProcessId: StableId<"workerProcess">;
  readonly runId: StableId<"run">;
  readonly processState: string;
}
export interface WorkerRecoveryAuthority {
  readonly hostIdentifier: string;
  readonly sessionId: StableId<"workerHostSession">;
  readonly applicationVersion: string;
}
export type WorkerHandoffOutcome = "handed_off" | "pending" | "terminal" | "obsolete";

/** Recovery is bound to a live daemon, not the interrupted execution's actor. */
export class PostgresWorkerRecoveryStore {
  private readonly pool: Pool;
  readonly authority: WorkerRecoveryAuthority;
  constructor(pool: Pool, runtime: HostRuntimeRegistration) {
    // The same explicit connection/statement/lock bounds as dispatch admission.
    new PostgresDispatchStore(pool);
    parseStableId(runtime.sessionId, "workerHostSession");
    if (!runtime.hostIdentifier.trim() || !runtime.applicationVersion.trim()) throw new TypeError("recovery runtime identity is required");
    this.pool = pool;
    this.authority = { hostIdentifier: runtime.hostIdentifier, sessionId: runtime.sessionId, applicationVersion: runtime.applicationVersion };
  }

  /** Only the original dispatch consumer may voluntarily yield its exact run. */
  async handoff(message: DispatchMessage): Promise<WorkerHandoffOutcome> {
    parseStableId(message.runId, "run"); parseStableId(message.hostSessionId, "workerHostSession");
    if (!Number.isSafeInteger(message.generation) || message.generation < 1) throw new TypeError("invalid handoff generation");
    if (message.hostSessionId !== this.authority.sessionId) return "obsolete";
    const result = await this.pool.query("SELECT acp.handoff_worker_run($1,$2,$3,$4,$5) AS outcome",
      [message.runId, message.generation, this.authority.hostIdentifier, this.authority.sessionId, this.authority.applicationVersion]);
    const outcome = result.rows[0]?.outcome;
    if (!["handed_off", "pending", "terminal", "obsolete"].includes(outcome)) throw new Error("invalid durable handoff outcome");
    return outcome as WorkerHandoffOutcome;
  }

  async listCandidates(after?: StableId<"workerProcess">, limit = 5): Promise<readonly WorkerRecoveryCandidate[]> {
    if (after !== undefined) parseStableId(after, "workerProcess");
    if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new TypeError("recovery batch must be 1 to 25 processes");
    const result = await this.pool.query(`SELECT p.worker_process_id, p.run_id, p.state
      FROM acp.worker_processes p JOIN acp.worker_runs r USING (run_id)
      WHERE p.host_identifier = $1 AND r.state = 'started' AND p.supervision_kind = 'windows_job'
        AND acp.worker_run_recovery_eligible(r.run_id)
        AND ($2::text IS NULL OR p.worker_process_id::text > $2)
        AND (p.state <> 'running' OR ((p.deadline_at <= clock_timestamp()
          OR p.heartbeat_at + interval '15 seconds' <= clock_timestamp() OR acp.worker_run_handed_off(r.run_id))
          AND (p.reconciliation_id IS NULL OR p.reconciliation_claim_expires_at <= clock_timestamp())))
      ORDER BY p.worker_process_id LIMIT $3`, [this.authority.hostIdentifier, after ?? null, limit]);
    return result.rows.map((row) => ({ workerProcessId: parseStableId(row.worker_process_id, "workerProcess"),
      runId: parseStableId(row.run_id, "run"), processState: row.state as string }));
  }

  /** Each process gets a fresh same-binding provenance; no mixed-binding bulk claim. */
  async prepare(candidate: WorkerRecoveryCandidate): Promise<{ readonly provenanceId: StableId<"provenance">;
    readonly claim?: WorkerProcessReconciliationClaim } | undefined> {
    return withTransaction(this.pool, async (client) => {
      const a = this.authority;
      // Match the dispatch lock order. Retiring/replacing this session cannot
      // race provenance selection or claim creation inside this transaction.
      await client.query("SELECT host_identifier FROM acp.worker_host_sessions WHERE host_identifier = $1 FOR SHARE", [a.hostIdentifier]);
      await client.query("SELECT host_identifier FROM acp.worker_hosts WHERE host_identifier = $1 FOR SHARE", [a.hostIdentifier]);
      const provenanceId = createStableId("provenance");
      const inserted = await client.query(`INSERT INTO acp.runtime_provenance
        SELECT (jsonb_populate_record(NULL::acp.runtime_provenance, to_jsonb(t) || jsonb_build_object(
          'provenance_id', $1::text, 'context_packet_schema_version', p.schema_version::text,
          'context_packet_digest', p.digest::text, 'recorded_at', clock_timestamp()))).*
        FROM acp.worker_runs r JOIN acp.missions m USING (mission_id)
        JOIN acp.context_packets p USING (context_packet_id)
        JOIN acp.worker_host_runtimes h ON h.host_identifier = r.host_identifier AND h.workflow_binding_id = m.workflow_binding_id
        JOIN acp.runtime_provenance t ON t.provenance_id = h.template_provenance_id
        WHERE r.run_id = $2::acp.stable_id AND r.host_identifier = $3 AND r.state = 'started'
          AND h.session_id = $4::acp.stable_id AND h.application_version = $5
          AND acp.worker_run_recovery_eligible(r.run_id)
          AND acp.worker_recovery_runtime_live(r.run_id, $3, $4::acp.stable_id, $5)
          AND acp.runtime_provenance_matches_context(t.provenance_id, r.mission_id)
          AND EXISTS (SELECT 1 FROM acp.worker_processes wp WHERE wp.worker_process_id = $6::acp.stable_id AND wp.run_id = r.run_id)
        RETURNING provenance_id`, [provenanceId, candidate.runId, a.hostIdentifier, a.sessionId, a.applicationVersion, candidate.workerProcessId]);
      if (inserted.rowCount !== 1) return undefined;
      if (candidate.processState !== "running") return { provenanceId };
      const store = new PostgresWorkerRuntimeStore({ query: client.query.bind(client),
        connect: async () => { throw new Error("recovery claim must use its existing transaction"); } });
      const claims = await store.claimWorkerProcessesNeedingReconciliation({ workerProcessId: candidate.workerProcessId,
        hostIdentifier: a.hostIdentifier, staleAfterSeconds: 15, claimTtlSeconds: 20, limit: 1,
        reconciliationId: createStableId("reconciliation"), reconciliationOwner: a.sessionId,
        reconciliationProvenanceId: provenanceId });
      return claims[0] ? { provenanceId, claim: claims[0] } : undefined;
    });
  }
}
