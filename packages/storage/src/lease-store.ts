import type { StableId } from "@acp/domain";
import type { QueryResultRow } from "pg";

import type { ConnectionPool } from "./database.ts";
import { acquireEffectAuthorityLock, withTransaction } from "./database.ts";

export type WriterLeaseState = "active" | "recovering" | "released" | "expired";

export interface LeaseInsert {
  readonly leaseId: StableId<"lease">;
  readonly leaseKey: string;
  readonly missionId: StableId<"mission">;
  readonly nodeId: StableId<"node">;
  readonly ownerRunId: StableId<"run">;
  readonly state: "active" | "recovering";
  readonly ttlSeconds: number;
  readonly recoveryState: Readonly<Record<string, unknown>>;
}

export interface WriterLease {
  readonly leaseId: StableId<"lease">;
  readonly leaseKey: string;
  readonly ownerRunId: StableId<"run">;
  readonly fencingToken: string;
  readonly state: WriterLeaseState;
  readonly expiresAt: Date;
  readonly heartbeatAt: Date;
}

interface LeaseRow extends QueryResultRow {
  readonly lease_id: StableId<"lease">;
  readonly lease_key: string;
  readonly owner_run_id: StableId<"run">;
  readonly fencing_token: string;
  readonly state: WriterLeaseState;
  readonly expires_at: Date;
  readonly heartbeat_at: Date;
}

const canonicalLeaseKey =
  /^[a-z][a-z0-9._-]*:[a-z0-9][a-z0-9._:/@-]*$/u;

export class PostgresLeaseStore {
  private readonly pool: ConnectionPool;
  private readonly maximumTtlSeconds: number;

  constructor(pool: ConnectionPool, maximumTtlSeconds = 3_600) {
    if (!Number.isSafeInteger(maximumTtlSeconds) || maximumTtlSeconds < 1) {
      throw new RangeError("maximum lease TTL must be a positive integer");
    }
    this.pool = pool;
    this.maximumTtlSeconds = maximumTtlSeconds;
  }

  async acquire(lease: LeaseInsert): Promise<WriterLease | undefined> {
    if (!canonicalLeaseKey.test(lease.leaseKey)) {
      throw new TypeError("leaseKey must be a canonical lowercase resource key");
    }
    this.assertTtl(lease.ttlSeconds);

    return withTransaction(this.pool, async (client) => {
      await acquireEffectAuthorityLock(client);
      await client.query(
        `UPDATE acp.resource_leases
         SET state = 'expired', released_at = statement_timestamp()
         WHERE lease_key = $1
           AND state IN ('active', 'recovering')
           AND expires_at <= statement_timestamp()`,
        [lease.leaseKey],
      );
      const result = await client.query<LeaseRow>(
        `INSERT INTO acp.resource_leases (
           lease_id, lease_key, mission_id, node_id, owner_run_id, state,
           acquired_at, expires_at, heartbeat_at, recovery_state
         ) VALUES (
           $1, $2, $3, $4, $5, $6, statement_timestamp(),
           statement_timestamp() + ($7 * interval '1 second'),
           statement_timestamp(), $8::jsonb
         )
         ON CONFLICT (lease_key) WHERE state IN ('active', 'recovering')
         DO NOTHING
         RETURNING lease_id, lease_key, owner_run_id, fencing_token, state,
                   expires_at, heartbeat_at`,
        [
          lease.leaseId,
          lease.leaseKey,
          lease.missionId,
          lease.nodeId,
          lease.ownerRunId,
          lease.state,
          lease.ttlSeconds,
          JSON.stringify(lease.recoveryState),
        ],
      );
      return result.rows[0] === undefined ? undefined : mapLease(result.rows[0]);
    });
  }

  async heartbeat(
    leaseId: StableId<"lease">,
    ownerRunId: StableId<"run">,
    fencingToken: string,
    ttlSeconds: number,
  ): Promise<WriterLease | undefined> {
    assertFencingToken(fencingToken);
    this.assertTtl(ttlSeconds);

    return withTransaction(this.pool, async (client) => {
      await acquireEffectAuthorityLock(client);
      await client.query(
        `UPDATE acp.resource_leases
         SET state = 'expired', released_at = statement_timestamp()
         WHERE lease_id = $1 AND owner_run_id = $2 AND fencing_token = $3
           AND state IN ('active', 'recovering')
           AND expires_at <= statement_timestamp()`,
        [leaseId, ownerRunId, fencingToken],
      );
      const result = await client.query<LeaseRow>(
        `UPDATE acp.resource_leases
         SET heartbeat_at = statement_timestamp(),
             expires_at = statement_timestamp() + ($4 * interval '1 second')
         WHERE lease_id = $1 AND owner_run_id = $2 AND fencing_token = $3
           AND state IN ('active', 'recovering')
           AND expires_at > statement_timestamp()
         RETURNING lease_id, lease_key, owner_run_id, fencing_token, state,
                   expires_at, heartbeat_at`,
        [leaseId, ownerRunId, fencingToken, ttlSeconds],
      );
      return result.rows[0] === undefined ? undefined : mapLease(result.rows[0]);
    });
  }

  async release(
    leaseId: StableId<"lease">,
    ownerRunId: StableId<"run">,
    fencingToken: string,
  ): Promise<boolean> {
    assertFencingToken(fencingToken);
    return withTransaction(this.pool, async (client) => {
      await acquireEffectAuthorityLock(client);
      const result = await client.query(
        `UPDATE acp.resource_leases
       SET state = 'released', released_at = statement_timestamp()
       WHERE lease_id = $1 AND owner_run_id = $2 AND fencing_token = $3
         AND state IN ('active', 'recovering')`,
        [leaseId, ownerRunId, fencingToken],
      );
      return result.rowCount === 1;
    });
  }

  private assertTtl(ttlSeconds: number): void {
    if (
      !Number.isSafeInteger(ttlSeconds) ||
      ttlSeconds < 1 ||
      ttlSeconds > this.maximumTtlSeconds
    ) {
      throw new RangeError(
        `lease TTL must be between 1 and ${this.maximumTtlSeconds} seconds`,
      );
    }
  }
}

function assertFencingToken(value: string): void {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new TypeError("fencing token must be a positive decimal integer");
  }
}

function mapLease(row: LeaseRow): WriterLease {
  return {
    leaseId: row.lease_id,
    leaseKey: row.lease_key,
    ownerRunId: row.owner_run_id,
    fencingToken: row.fencing_token,
    state: row.state,
    expiresAt: row.expires_at,
    heartbeatAt: row.heartbeat_at,
  };
}
