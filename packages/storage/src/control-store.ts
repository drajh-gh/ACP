import {
  parseStableId,
  timestampMilliseconds,
  type GlobalRuntimeControl,
  type ProjectRuntimeControl,
  type StableId,
} from "@acp/domain";
import type { QueryResultRow } from "pg";

import type { ConnectionPool } from "./database.ts";
import { acquireEffectAuthorityLock, withTransaction } from "./database.ts";

export interface RuntimeControlSet {
  readonly controlEventId: StableId<"runtimeControlEvent">;
  readonly scope:
    | { readonly type: "global"; readonly id: "global" }
    | { readonly type: "project"; readonly id: StableId<"project"> };
  readonly effectsPaused: boolean;
  readonly reason: string;
  readonly updatedBy: string;
  readonly occurredAt: string;
  readonly expectedUpdatedAt?: string;
  readonly authorizationId?: StableId<"runtimeControlAuthorization">;
  readonly provenanceId: StableId<"provenance">;
}

export interface RuntimeControlAuthorizationInsert {
  readonly authorizationId: StableId<"runtimeControlAuthorization">;
  readonly scope:
    | { readonly type: "global"; readonly id: "global" }
    | { readonly type: "project"; readonly id: StableId<"project"> };
  readonly authorizedBy: string;
  readonly reason: string;
  readonly validFrom: string;
  readonly expiresAt: string;
  readonly provenanceId: StableId<"provenance">;
}

export interface RuntimeControls {
  readonly global: GlobalRuntimeControl;
  readonly project?: ProjectRuntimeControl;
}

interface ControlRow extends QueryResultRow {
  readonly scope_type: "global" | "project";
  readonly scope_id: string;
  readonly effects_paused: boolean;
  readonly reason: string;
  readonly updated_by: string;
  readonly updated_at: Date;
  readonly authorization_id: StableId<"runtimeControlAuthorization"> | null;
}

export class PostgresControlStore {
  private readonly pool: ConnectionPool;

  constructor(pool: ConnectionPool) {
    this.pool = pool;
  }

  async recordAuthorization(
    authorization: RuntimeControlAuthorizationInsert,
  ): Promise<void> {
    parseStableId(authorization.authorizationId, "runtimeControlAuthorization");
    if (authorization.authorizedBy.trim().length === 0) {
      throw new Error("runtime control authorizer must not be empty");
    }
    if (authorization.reason.trim().length === 0) {
      throw new Error("runtime control authorization reason must not be empty");
    }
    const validFrom = timestampMilliseconds(
      authorization.validFrom,
      "runtimeControlAuthorization.validFrom",
    );
    const expiresAt = timestampMilliseconds(
      authorization.expiresAt,
      "runtimeControlAuthorization.expiresAt",
    );
    if (expiresAt <= validFrom) {
      throw new Error("runtime control authorization must expire after it starts");
    }
    await withTransaction(this.pool, async (client) => {
      await acquireEffectAuthorityLock(client);
      await client.query(
        `INSERT INTO acp.runtime_control_authorizations (
         authorization_id, scope_type, scope_id, action, authorized_by,
         reason, valid_from, expires_at, provenance_id
       ) VALUES ($1, $2, $3, 'unpause_effects', $4, $5, $6, $7, $8)`,
      [
        authorization.authorizationId,
        authorization.scope.type,
        authorization.scope.id,
        authorization.authorizedBy,
        authorization.reason,
        authorization.validFrom,
        authorization.expiresAt,
        authorization.provenanceId,
        ],
      );
    });
  }

  async getControls(projectId: StableId<"project">): Promise<RuntimeControls> {
    const result = await this.pool.query<ControlRow>(
      `SELECT scope_type, scope_id, effects_paused, reason, updated_by,
              updated_at, authorization_id
       FROM acp.runtime_controls
       WHERE (scope_type = 'global' AND scope_id = 'global')
          OR (scope_type = 'project' AND scope_id = $1)`,
      [projectId],
    );
    const global = result.rows.find((row) => row.scope_type === "global");
    if (global === undefined) throw new Error("global runtime control is missing");
    const project = result.rows.find((row) => row.scope_type === "project");
    return {
      global: mapGlobalControl(global),
      ...(project === undefined ? {} : { project: mapProjectControl(project) }),
    };
  }

  async setControl(update: RuntimeControlSet): Promise<void> {
    if (
      !update.effectsPaused &&
      update.authorizationId === undefined
    ) {
      throw new Error("unpausing effects requires an authorization reference");
    }
    if (update.effectsPaused && update.authorizationId !== undefined) {
      throw new Error("pausing effects must not consume an unpause authorization");
    }
    if (update.authorizationId !== undefined) {
      parseStableId(update.authorizationId, "runtimeControlAuthorization");
    }

    await withTransaction(this.pool, async (client) => {
      await acquireEffectAuthorityLock(client);
      const existing = await client.query<ControlRow>(
        `SELECT scope_type, scope_id, effects_paused, reason, updated_by,
                updated_at, authorization_id
         FROM acp.runtime_controls
         WHERE scope_type = $1 AND scope_id = $2
         FOR UPDATE`,
        [update.scope.type, update.scope.id],
      );
      const current = existing.rows[0];
      if (current !== undefined) {
        if (update.expectedUpdatedAt === undefined) {
          throw new Error("updating an existing control requires its current timestamp");
        }
        if (current.updated_at.toISOString() !== update.expectedUpdatedAt) {
          throw new Error("runtime control changed since it was read");
        }
        if (Date.parse(update.occurredAt) <= current.updated_at.getTime()) {
          throw new Error("runtime control event time must advance monotonically");
        }
      } else {
        if (update.scope.type !== "project") {
          throw new Error("global runtime control is missing");
        }
      }

      await client.query(
        `INSERT INTO acp.runtime_control_events (
           control_event_id, scope_type, scope_id, previous_effects_paused,
           effects_paused, reason, updated_by, authorization_id, occurred_at,
           provenance_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          update.controlEventId,
          update.scope.type,
          update.scope.id,
          current?.effects_paused ?? null,
          update.effectsPaused,
          update.reason,
          update.updatedBy,
          update.authorizationId ?? null,
          update.occurredAt,
          update.provenanceId,
        ],
      );

      await client.query(
        "SELECT set_config('acp.runtime_control_event_id', $1, true)",
        [update.controlEventId],
      );

      if (current !== undefined) {
        await client.query(
          `UPDATE acp.runtime_controls
           SET effects_paused = $3, reason = $4, updated_by = $5,
               updated_at = $6, authorization_id = $7,
               last_control_event_id = $8
           WHERE scope_type = $1 AND scope_id = $2`,
          [
            update.scope.type,
            update.scope.id,
            update.effectsPaused,
            update.reason,
            update.updatedBy,
            update.occurredAt,
            update.authorizationId ?? null,
            update.controlEventId,
          ],
        );
      } else {
        await client.query(
          `INSERT INTO acp.runtime_controls (
             scope_type, scope_id, effects_paused, reason, updated_by,
             updated_at, authorization_id, last_control_event_id
           ) VALUES ('project', $1, $2, $3, $4, $5, $6, $7)`,
          [
            update.scope.id,
            update.effectsPaused,
            update.reason,
            update.updatedBy,
            update.occurredAt,
            update.authorizationId ?? null,
            update.controlEventId,
          ],
        );
      }
    });
  }
}

function mapGlobalControl(row: ControlRow): GlobalRuntimeControl {
  if (row.scope_type !== "global" || row.scope_id !== "global") {
    throw new Error("invalid global runtime control row");
  }
  return {
    scopeType: "global",
    scopeId: "global",
    effectsPaused: row.effects_paused,
    reason: row.reason,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at.toISOString(),
    ...(row.authorization_id === null
      ? {}
      : {
          authorizationId: parseStableId(
            row.authorization_id,
            "runtimeControlAuthorization",
          ),
        }),
  };
}

function mapProjectControl(row: ControlRow): ProjectRuntimeControl {
  if (row.scope_type !== "project") throw new Error("invalid project control row");
  return {
    scopeType: "project",
    scopeId: row.scope_id as StableId<"project">,
    effectsPaused: row.effects_paused,
    reason: row.reason,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at.toISOString(),
    ...(row.authorization_id === null
      ? {}
      : {
          authorizationId: parseStableId(
            row.authorization_id,
            "runtimeControlAuthorization",
          ),
        }),
  };
}
