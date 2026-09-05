import { parseStableId, type StableId } from "@acp/domain";
import type { Pool, QueryResultRow } from "pg";
import { withTransaction, type QueryExecutor } from "./database.ts";
import { PostgresDispatchStore, type HostRuntimeRegistration } from "./dispatch-store.ts";
import type { WorkerRecoveryAuthority } from "./worker-recovery-store.ts";

export interface FilesystemWriterReservation {
  readonly leaseId: StableId<"lease">;
  readonly runId: StableId<"run">;
  readonly workerProcessId: StableId<"workerProcess">;
  readonly worktreeBindingId: StableId<"worktreeBinding">;
  readonly provenanceId: StableId<"provenance">;
}
/** Historical database snapshot, never proof of present OS fencing or renewed authority. */
export interface FilesystemWriterLease extends FilesystemWriterReservation {
  readonly repositoryBindingId: StableId<"repositoryBinding">;
  readonly hostIdentifier: string;
  readonly ownerSessionId: StableId<"workerHostSession">;
  readonly applicationVersion: string;
  readonly workspaceKey: string;
  readonly physicalWorkspaceKey: string;
  readonly physicalRepositoryKey: string;
  readonly branchKey: string;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
  readonly expiresAt: string;
  readonly revision: number;
  readonly releasedAt: string | null;
  readonly state: "active" | "recovering" | "released";
}

export function parseFilesystemWriterReservation(value: unknown): FilesystemWriterReservation {
  const keys = ["leaseId", "runId", "workerProcessId", "worktreeBindingId", "provenanceId"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length
    || Object.keys(value).some((key) => !keys.includes(key))) throw new TypeError("exact filesystem writer reservation fields required");
  const v = value as Record<string, unknown>;
  return { leaseId: parseStableId(v.leaseId, "lease"), runId: parseStableId(v.runId, "run"),
    workerProcessId: parseStableId(v.workerProcessId, "workerProcess"), worktreeBindingId: parseStableId(v.worktreeBindingId, "worktreeBinding"),
    provenanceId: parseStableId(v.provenanceId, "provenance") };
}

/** Storage only: no Git mutation, process launch, provisioning or expiry-based takeover. */
export class PostgresFilesystemWriterStore {
  private readonly pool: Pool;
  readonly authority: WorkerRecoveryAuthority;
  constructor(pool: Pool, runtime: HostRuntimeRegistration) {
    new PostgresDispatchStore(pool);
    parseStableId(runtime.sessionId, "workerHostSession");
    if (!runtime.hostIdentifier.trim() || !runtime.applicationVersion.trim()) throw new TypeError("filesystem writer runtime identity required");
    this.pool = pool;
    this.authority = { hostIdentifier: runtime.hostIdentifier, sessionId: runtime.sessionId, applicationVersion: runtime.applicationVersion };
  }
  /** Exact retries only read history. They never renew an old or released lease. */
  async reserve(value: FilesystemWriterReservation): Promise<FilesystemWriterLease> {
    const input = parseFilesystemWriterReservation(value), a = this.authority;
    return withTransaction(this.pool, async (client) => {
      await client.query("SELECT acp.lock_filesystem_writer($1,$2)", [input.runId, input.worktreeBindingId]);
      const existing = (await client.query("SELECT * FROM acp.filesystem_writer_lease_status WHERE lease_id=$1 OR run_id=$2", [input.leaseId, input.runId])).rows[0];
      if (existing) {
        if (existing.lease_id !== input.leaseId || existing.run_id !== input.runId || existing.worker_process_id !== input.workerProcessId
          || existing.worktree_binding_id !== input.worktreeBindingId || existing.provenance_id !== input.provenanceId
          || existing.host_identifier !== a.hostIdentifier || existing.owner_session_id !== a.sessionId || existing.application_version !== a.applicationVersion) {
          throw new Error("filesystem writer reservation aliases different ownership");
        }
        return leaseFromRow(existing);
      }
      await client.query(`INSERT INTO acp.filesystem_writer_leases(lease_id,run_id,worker_process_id,worktree_binding_id,
        host_identifier,owner_session_id,application_version,provenance_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [input.leaseId,input.runId,input.workerProcessId,input.worktreeBindingId,a.hostIdentifier,a.sessionId,a.applicationVersion,input.provenanceId]);
      return this.required(client, input.leaseId);
    });
  }
  async load(leaseId: StableId<"lease">): Promise<FilesystemWriterLease | undefined> {
    parseStableId(leaseId, "lease");
    const row = (await this.pool.query("SELECT * FROM acp.filesystem_writer_lease_status WHERE lease_id=$1 AND host_identifier=$2", [leaseId,this.authority.hostIdentifier])).rows[0];
    return row ? leaseFromRow(row) : undefined;
  }
  /** A failed or uncertain renewal must be treated as lost authority by future OS consumers. */
  async heartbeat(leaseId: StableId<"lease">): Promise<FilesystemWriterLease> {
    parseStableId(leaseId, "lease"); const a = this.authority;
    return withTransaction(this.pool, async (client) => {
      const l = await this.required(client, leaseId);
      await client.query("SELECT acp.lock_filesystem_writer($1,$2)", [l.runId,l.worktreeBindingId]);
      const renewed = await client.query(`UPDATE acp.filesystem_writer_leases SET heartbeat_at=clock_timestamp()
        WHERE lease_id=$1 AND host_identifier=$2 AND owner_session_id=$3 AND application_version=$4 AND released_at IS NULL RETURNING lease_id`,
      [leaseId,a.hostIdentifier,a.sessionId,a.applicationVersion]);
      if (renewed.rowCount !== 1) throw new Error("filesystem writer heartbeat lacks its exact unreleased owner");
      return this.required(client, leaseId);
    });
  }
  /** Only terminal, durably sealed/stopped runs can release; exact retries are historical reads. */
  async release(leaseId: StableId<"lease">): Promise<FilesystemWriterLease> {
    parseStableId(leaseId, "lease"); const a = this.authority;
    return withTransaction(this.pool, async (client) => {
      const l = await this.required(client, leaseId);
      await client.query("SELECT acp.lock_filesystem_writer($1,$2)", [l.runId,l.worktreeBindingId]);
      await client.query("SELECT 1 FROM acp.filesystem_writer_leases WHERE lease_id=$1 FOR UPDATE", [leaseId]);
      const existing = (await client.query("SELECT 1 FROM acp.filesystem_writer_releases WHERE lease_id=$1", [leaseId])).rows[0];
      if (!existing) {
        const provenance = (await client.query("SELECT acp.make_filesystem_writer_release_provenance($1,$2,$3,$4) AS id",
          [leaseId,a.hostIdentifier,a.sessionId,a.applicationVersion])).rows[0]?.id as unknown;
        if (!provenance) throw new Error("filesystem writer release requires a stopped terminal run and current runtime");
        await client.query(`INSERT INTO acp.filesystem_writer_releases(lease_id,run_id,host_identifier,owner_session_id,application_version,provenance_id)
          VALUES($1,$2,$3,$4,$5,$6)`, [leaseId,l.runId,a.hostIdentifier,a.sessionId,a.applicationVersion,parseStableId(provenance,"provenance")]);
      }
      return this.required(client, leaseId);
    });
  }
  private async required(client: QueryExecutor, leaseId: StableId<"lease">): Promise<FilesystemWriterLease> {
    const row = (await client.query("SELECT * FROM acp.filesystem_writer_lease_status WHERE lease_id=$1 AND host_identifier=$2", [leaseId,this.authority.hostIdentifier])).rows[0];
    if (!row) throw new Error("filesystem writer lease not found on this host");
    return leaseFromRow(row);
  }
}
function leaseFromRow(row: QueryResultRow): FilesystemWriterLease {
  const input = parseFilesystemWriterReservation({ leaseId: row.lease_id, runId: row.run_id, workerProcessId: row.worker_process_id,
    worktreeBindingId: row.worktree_binding_id, provenanceId: row.provenance_id });
  if (!["active","recovering","released"].includes(row.state as string) || !Number.isInteger(row.revision) || (row.revision as number) < 1) {
    throw new Error("invalid filesystem writer lease projection");
  }
  return { ...input, repositoryBindingId: parseStableId(row.repository_binding_id,"repositoryBinding"),
    hostIdentifier: row.host_identifier as string, ownerSessionId: parseStableId(row.owner_session_id,"workerHostSession"),
    applicationVersion: row.application_version as string, workspaceKey: row.workspace_key as string,
    physicalWorkspaceKey: row.physical_workspace_key as string, physicalRepositoryKey: row.physical_repository_key as string, branchKey: row.branch_key as string,
    acquiredAt: (row.acquired_at as Date).toISOString(), heartbeatAt: (row.heartbeat_at as Date).toISOString(), expiresAt: (row.expires_at as Date).toISOString(),
    releasedAt: row.released_at === null ? null : (row.released_at as Date).toISOString(), revision: row.revision as number,
    state: row.state as FilesystemWriterLease["state"] };
}
