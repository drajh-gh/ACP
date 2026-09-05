import { createStableId, createWorkerFailureResult, parseContextPacket, parseStableId, type StableId } from "@acp/domain";
import type { Pool, QueryResultRow } from "pg";
import { PostgresDispatchStore, type HostRuntimeRegistration } from "./dispatch-store.ts";
import { withTransaction, type QueryExecutor } from "./database.ts";
import { parseWorkerLaunchIntent, type WorkerLaunchIntent } from "./worker-launch-intent.ts";
import { PostgresWorkerRuntimeStore, type WorkerProcessCompletion } from "./worker-runtime-store.ts";
import type { WorkerRecoveryAuthority } from "./worker-recovery-store.ts";

export interface WorkerLaunchCandidate {
  readonly runId: StableId<"run">;
  readonly workerProcessId: StableId<"workerProcess">;
}
export interface WorkerLaunchClaim extends WorkerLaunchCandidate {
  readonly intent: WorkerLaunchIntent;
  readonly reconciliationId: StableId<"reconciliation">;
  readonly provenanceId: StableId<"provenance">;
  readonly claimedAt: string;
  readonly expiresAt: string;
}
export type WorkerLaunchObservation = { readonly state: "unconfirmed" } | {
  readonly state: "lost" | "terminated";
  readonly sealed: true;
  readonly reason: string;
  readonly exitCode?: number;
  readonly root?: { readonly processId: number; readonly processStartToken: string; readonly startedAt: string };
};
export type PreparedWorkerLaunch = {
  readonly provenanceId: StableId<"provenance">;
  readonly claim?: WorkerLaunchClaim;
};
interface ClaimRow extends QueryResultRow {
  run_id: string; worker_process_id: string; reconciliation_id: string; provenance_id: string;
  directory_path: string; directory_identity: string; supervision_scope: unknown;
  claimed_at_exact: string; expires_at_exact: string; remaining_ms: string | number;
}

/** Native I/O is outside row-lock transactions, but inside one held DB session. */
export class PostgresWorkerLaunchStore {
  private readonly pool: Pool;
  readonly authority: WorkerRecoveryAuthority;
  constructor(pool: Pool, runtime: HostRuntimeRegistration) {
    new PostgresDispatchStore(pool); // Require bounded connection/statement/lock timeouts.
    parseStableId(runtime.sessionId, "workerHostSession");
    if (!runtime.hostIdentifier.trim() || !runtime.applicationVersion.trim()) throw new TypeError("launch runtime identity required");
    this.pool = pool;
    this.authority = { hostIdentifier: runtime.hostIdentifier, sessionId: runtime.sessionId, applicationVersion: runtime.applicationVersion };
  }

  async finishOwnedLaunch(completion: WorkerProcessCompletion & { readonly runId: StableId<"run">; readonly launchSealed: true }): Promise<void> {
    if (completion.launchSealed !== true || !["exited", "terminated"].includes(completion.state)) throw new Error("sealed owner closure required");
    await withTransaction(this.pool, async (client) => {
      await client.query("SELECT acp.lock_worker_launch($1)", [completion.runId]);
      const intent = (await client.query("SELECT * FROM acp.worker_launch_intents WHERE run_id = $1", [completion.runId])).rows[0];
      if (!intent || intent.worker_process_id !== completion.workerProcessId || intent.host_identifier !== this.authority.hostIdentifier
        || intent.owner_session_id !== this.authority.sessionId || intent.application_version !== this.authority.applicationVersion) {
        throw new Error("owner closure does not match its launch authority");
      }
      const existing = (await client.query("SELECT * FROM acp.worker_launch_stops WHERE run_id = $1", [completion.runId])).rows[0];
      if (existing) {
        if (existing.actor_kind !== "owner" || existing.root_process_id !== completion.processId
          || existing.root_process_start_token !== completion.processStartToken || existing.process_state !== completion.state
          || existing.exit_code !== completion.exitCode || existing.provenance_id !== completion.transitionProvenanceId) {
          throw new Error("owner launch stop aliases different evidence");
        }
        return; // Immutable exact receipt may be read after a lost ACK or handoff.
      }
      // Parent locks already held: never finish process -> acquire parent locks.
      const processes = new PostgresWorkerRuntimeStore({ query: client.query.bind(client),
        connect: async () => { throw new Error("owned launch completion must remain in its transaction"); } });
      await processes.finishWorkerProcess(completion);
      const stopped = await processes.loadWorkerProcess(completion.workerProcessId);
      if (!stopped) throw new Error("stopped launch journal disappeared");
      await client.query(`INSERT INTO acp.worker_launch_stops(run_id, actor_kind, owner_session_id, application_version,
        provenance_id, launch_sealed, process_state, reason, exit_code, root_process_id, root_process_start_token, root_started_at)
        VALUES($1,'owner',$2,$3,$4,true,$5,'owner_tree_closed_and_launch_sealed',$6,$7,$8,$9::timestamptz)`,
      [completion.runId, this.authority.sessionId, this.authority.applicationVersion, completion.transitionProvenanceId,
        completion.state, completion.exitCode, completion.processId, completion.processStartToken, stopped.startedAt]);
    });
  }

  async listCandidates(after?: StableId<"workerProcess">, limit = 2): Promise<readonly WorkerLaunchCandidate[]> {
    if (after !== undefined) parseStableId(after, "workerProcess");
    if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new TypeError("launch recovery batch must be 1 to 25");
    const result = await this.pool.query(`SELECT i.run_id, i.worker_process_id FROM acp.worker_launch_intents i
      JOIN acp.worker_runs r USING(run_id) WHERE i.host_identifier = $1 AND r.state = 'started'
        AND ($2::text IS NULL OR i.worker_process_id::text > $2)
        AND (acp.worker_run_owner_retired(r.run_id) OR EXISTS (SELECT 1 FROM acp.worker_launch_revocations WHERE run_id = r.run_id))
        AND (EXISTS (SELECT 1 FROM acp.worker_launch_stops WHERE run_id = r.run_id)
          OR NOT EXISTS (SELECT 1 FROM acp.worker_launch_claims WHERE run_id = r.run_id AND expires_at > clock_timestamp()))
      ORDER BY i.worker_process_id LIMIT $3`, [this.authority.hostIdentifier, after ?? null, limit]);
    return result.rows.map((r) => ({ runId: parseStableId(r.run_id, "run"), workerProcessId: parseStableId(r.worker_process_id, "workerProcess") }));
  }

  async prepare(candidate: WorkerLaunchCandidate): Promise<PreparedWorkerLaunch | undefined> {
    parseStableId(candidate.runId, "run"); parseStableId(candidate.workerProcessId, "workerProcess");
    return withTransaction(this.pool, async (client) => {
      await client.query("SELECT acp.lock_worker_launch($1)", [candidate.runId]);
      const a = this.authority;
      const selected = (await client.query(`SELECT i.*, r.state, acp.worker_run_owner_retired(r.run_id) AS retired
        FROM acp.worker_launch_intents i JOIN acp.worker_runs r USING(run_id)
        WHERE i.run_id = $1 AND i.worker_process_id = $2 AND i.host_identifier = $3
          AND acp.worker_recovery_runtime_live(r.run_id,$3,$4::acp.stable_id,$5)`,
      [candidate.runId, candidate.workerProcessId, a.hostIdentifier, a.sessionId, a.applicationVersion])).rows[0];
      if (!selected || selected.state !== "started") return undefined;
      const revoked = (await client.query("SELECT 1 FROM acp.worker_launch_revocations WHERE run_id = $1", [candidate.runId])).rowCount === 1;
      if (!revoked) {
        if (!selected.retired) return undefined;
        const revocationProvenance = await this.newProvenance(client, candidate.runId);
        if (!revocationProvenance) return undefined;
        await client.query(`INSERT INTO acp.worker_launch_revocations(run_id, owner_session_id, application_version, provenance_id, reason)
          VALUES($1,$2,$3,$4,'original_owner_retired')`, [candidate.runId, a.sessionId, a.applicationVersion, revocationProvenance]);
      }
      const stopped = (await client.query("SELECT 1 FROM acp.worker_launch_stops WHERE run_id = $1", [candidate.runId])).rowCount === 1;
      if (!stopped && (await client.query("SELECT 1 FROM acp.worker_launch_claims WHERE run_id = $1 AND expires_at > clock_timestamp()", [candidate.runId])).rowCount) return undefined;
      const provenanceId = await this.newProvenance(client, candidate.runId);
      if (!provenanceId) return undefined;
      if (stopped) return { provenanceId };
      const reconciliationId = createStableId("reconciliation");
      await client.query(`INSERT INTO acp.worker_launch_claims(reconciliation_id, run_id, owner_session_id, application_version, provenance_id)
        VALUES($1,$2,$3,$4,$5)`, [reconciliationId, candidate.runId, a.sessionId, a.applicationVersion, provenanceId]);
      const row = await this.loadClaim(client, candidate, reconciliationId, false);
      if (!row) throw new Error("launch claim was not persisted with its exact authority");
      return { provenanceId, claim: claimFromRow(row) };
    });
  }

  async observe(claim: WorkerLaunchClaim, observer: (persisted: WorkerLaunchClaim, signal: AbortSignal) => Promise<WorkerLaunchObservation>,
    signal: AbortSignal): Promise<"stopped" | "busy" | "stale_claim"> {
    parseStableId(claim.runId, "run"); parseStableId(claim.workerProcessId, "workerProcess"); parseStableId(claim.reconciliationId, "reconciliation");
    if (signal.aborted) return "stale_claim";
    const client = await this.pool.connect(), controller = new AbortController(), failed = Promise.withResolvers<never>();
    void failed.promise.catch(() => {});
    let broken = false, acquired = false, acquisitionPending = false, transaction = false;
    let timer: NodeJS.Timeout | undefined, observing: Promise<WorkerLaunchObservation> | undefined;
    const abort = () => { controller.abort(); failed.reject(new Error("launch observation authority ended")); };
    const connectionFailed = () => { broken = true; abort(); };
    client.on("error", connectionFailed); signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      acquisitionPending = true; // Session locks survive a lost statement acknowledgement.
      const lock = await client.query("SELECT pg_try_advisory_lock(hashtextextended('acp:worker-launch-reconciliation:' || $1,0)) AS acquired", [claim.workerProcessId]);
      if (typeof lock.rows[0]?.acquired !== "boolean") throw new Error("launch lock acquisition unconfirmed");
      acquisitionPending = false;
      acquired = lock.rows[0]?.acquired === true;
      if (!acquired) return "busy";
      const row = await this.loadClaim(client, claim, claim.reconciliationId, true);
      if (!row || controller.signal.aborted) return "stale_claim";
      const remaining = Math.min(14000, Math.floor(Number(row.remaining_ms)));
      if (!Number.isFinite(remaining) || remaining <= 0) return "stale_claim";
      timer = setTimeout(abort, remaining);
      observing = Promise.resolve().then(() => observer(claimFromRow(row), controller.signal));
      const observation = await Promise.race([observing, failed.promise]);
      if (controller.signal.aborted || observation.state === "unconfirmed") throw new Error("launch stop remains unconfirmed");
      transaction = true; // Even a lost BEGIN acknowledgement needs rollback.
      await client.query("BEGIN");
      await client.query("SELECT acp.lock_worker_launch($1)", [claim.runId]);
      const current = await this.loadClaim(client, claim, claim.reconciliationId, true);
      if (!current || controller.signal.aborted) return "stale_claim";
      const persisted = claimFromRow(current);
      await client.query(`INSERT INTO acp.worker_launch_stops(run_id, actor_kind, owner_session_id, application_version,
        provenance_id, reconciliation_id, launch_sealed, process_state, reason, exit_code, root_process_id, root_process_start_token, root_started_at)
        VALUES($1,'recovery',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz)`,
      [persisted.runId, this.authority.sessionId, this.authority.applicationVersion, persisted.provenanceId, persisted.reconciliationId,
        observation.sealed, observation.state, observation.reason, observation.exitCode ?? null, observation.root?.processId ?? null,
        observation.root?.processStartToken ?? null, observation.root?.startedAt ?? null]);
      if (controller.signal.aborted) throw new Error("launch observation lease expired before commit");
      await client.query("COMMIT"); transaction = false;
      return "stopped";
    } finally {
      if (acquisitionPending) broken = true;
      if (timer) clearTimeout(timer);
      controller.abort(); signal.removeEventListener("abort", abort);
      try {
        if (observing) {
          let cleanupTimer: NodeJS.Timeout | undefined;
          try { await Promise.race([observing.then(() => {}, () => {}), new Promise<never>((_resolve, reject) => {
            cleanupTimer = setTimeout(() => reject(new Error("launch inspector cleanup unconfirmed")), 2000);
          })]); } finally { if (cleanupTimer) clearTimeout(cleanupTimer); }
        }
        if (transaction && !broken) await client.query("ROLLBACK");
        if (acquired && !broken) {
          const unlocked = await client.query("SELECT pg_advisory_unlock(hashtextextended('acp:worker-launch-reconciliation:' || $1,0)) AS released", [claim.workerProcessId]);
          if (unlocked.rows[0]?.released !== true) throw new Error("launch session lock release unconfirmed");
        }
      } catch (error) { broken = true; throw error; }
      finally { client.off("error", connectionFailed); client.release(broken); }
    }
  }

  async recover(runId: StableId<"run">, provenanceId: StableId<"provenance">): Promise<"recovered" | "already_terminal" | "pending"> {
    parseStableId(runId, "run"); parseStableId(provenanceId, "provenance");
    return withTransaction(this.pool, async (client) => {
      await client.query("SELECT acp.lock_worker_launch($1)", [runId]);
      const run = (await client.query("SELECT * FROM acp.worker_runs WHERE run_id = $1 AND host_identifier = $2", [runId, this.authority.hostIdentifier])).rows[0];
      if (!run) return "pending";
      if (run.state !== "started") return "already_terminal";
      const a = this.authority;
      const fact = (await client.query(`SELECT packet.packet, clock_timestamp() AS observed_at,
        (m.state = 'cancelled' OR n.state = 'cancelled' OR acp.worker_cancellation_requested(m.mission_id,n.graph_revision)) AS cancelled
        FROM acp.worker_runs r JOIN acp.context_packets packet ON packet.context_packet_id = r.context_packet_id
          JOIN acp.missions m ON m.mission_id = r.mission_id JOIN acp.mission_nodes n ON n.node_id = r.node_id
          JOIN acp.worker_launch_revocations rev ON rev.run_id = r.run_id
        WHERE r.run_id = $1 AND acp.worker_launch_recovery_actor_valid(r.run_id,$2,$3,$4,rev.revoked_at)
          AND EXISTS (SELECT 1 FROM acp.worker_launch_stops WHERE run_id = r.run_id)
          AND NOT EXISTS (SELECT 1 FROM acp.worker_processes WHERE run_id = r.run_id AND state = 'running')`,
      [runId, provenanceId, a.sessionId, a.applicationVersion])).rows[0];
      if (!fact) return "pending";
      const observedAt = fact.observed_at as Date;
      const result = createWorkerFailureResult({ runId, packet: parseContextPacket(fact.packet), attemptNumber: run.attempt_number as number,
        status: fact.cancelled ? "cancelled" : "failed", code: fact.cancelled ? "terminated" : observedAt >= run.timeout_at ? "timeout" : "terminated",
        conclusion: "The prior worker launch is permanently sealed and its owned tree is stopped. No success was inferred.",
        wallMilliseconds: Math.max(0, observedAt.getTime() - (run.started_at as Date).getTime()) });
      await client.query("UPDATE acp.worker_runs SET state=$2, result=$3::jsonb, completed_at=$4::timestamptz, transition_provenance_id=$5 WHERE run_id=$1",
        [runId, result.status, JSON.stringify(result), observedAt.toISOString(), provenanceId]);
      return "recovered";
    });
  }

  private async newProvenance(client: QueryExecutor, runId: StableId<"run">): Promise<StableId<"provenance"> | undefined> {
    const a = this.authority;
    const row = (await client.query("SELECT acp.make_worker_launch_recovery_provenance($1,$2,$3,$4) AS id", [runId, a.hostIdentifier, a.sessionId, a.applicationVersion])).rows[0];
    return row?.id ? parseStableId(row.id, "provenance") : undefined;
  }

  private async loadClaim(client: QueryExecutor, candidate: WorkerLaunchCandidate, reconciliationId: StableId<"reconciliation">, held: boolean): Promise<ClaimRow | undefined> {
    const a = this.authority;
    const result = await client.query<ClaimRow>(`SELECT i.*, c.reconciliation_id, c.provenance_id,
      c.claimed_at::text AS claimed_at_exact, c.expires_at::text AS expires_at_exact,
      extract(epoch FROM (c.expires_at-clock_timestamp())) * 1000 AS remaining_ms
      FROM acp.worker_launch_claims c JOIN acp.worker_launch_intents i USING(run_id) JOIN acp.worker_runs r USING(run_id)
      WHERE c.reconciliation_id=$1 AND c.run_id=$2 AND i.worker_process_id=$3 AND i.host_identifier=$4
        AND c.owner_session_id=$5 AND c.application_version=$6 AND r.state='started' AND c.expires_at > clock_timestamp()
        AND NOT EXISTS (SELECT 1 FROM acp.worker_launch_stops WHERE run_id=r.run_id)
        AND acp.worker_recovery_runtime_live(r.run_id,$4,$5,$6)
        ${held ? "AND acp.worker_launch_claim_held(r.run_id,c.reconciliation_id,c.provenance_id)" : ""}`,
    [reconciliationId, candidate.runId, candidate.workerProcessId, a.hostIdentifier, a.sessionId, a.applicationVersion]);
    return result.rows[0];
  }
}

function claimFromRow(row: ClaimRow): WorkerLaunchClaim {
  return { runId: parseStableId(row.run_id, "run"), workerProcessId: parseStableId(row.worker_process_id, "workerProcess"),
    reconciliationId: parseStableId(row.reconciliation_id, "reconciliation"), provenanceId: parseStableId(row.provenance_id, "provenance"),
    claimedAt: row.claimed_at_exact, expiresAt: row.expires_at_exact,
    intent: parseWorkerLaunchIntent({ workerProcessId: row.worker_process_id,
      fence: { directory: row.directory_path, directoryIdentity: row.directory_identity, scope: row.supervision_scope } }) };
}
