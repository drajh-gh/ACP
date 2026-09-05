import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { QueryResult, QueryResultRow } from "pg";

import type { ConnectionPool, QueryExecutor } from "./database.ts";

const upMigrationPattern = /^(?<version>\d{4})_(?<name>.+)\.sql$/;
const migrationLockKey = "acp:schema-migrations";

export interface MigrationFile {
  readonly version: string;
  readonly name: string;
  readonly path: string;
  readonly checksumSha256: string;
  readonly downChecksumSha256: string;
  readonly sql: string;
  readonly downSql: string;
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

export async function loadMigrations(directory: string): Promise<MigrationFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const migrations: MigrationFile[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || entry.name.endsWith(".down.sql")) continue;
    const match = upMigrationPattern.exec(entry.name);
    if (match?.groups === undefined) continue;
    const version = match.groups.version;
    const name = match.groups.name;
    if (version === undefined || name === undefined) continue;
    const path = join(directory, entry.name);
    const sql = await readFile(path, "utf8");
    const downPath = path.replace(/\.sql$/, ".down.sql");
    let downSql: string;
    try {
      downSql = await readFile(downPath, "utf8");
    } catch (error) {
      throw new Error(`Missing down migration for ${basename(path)}`, { cause: error });
    }
    migrations.push({
      version,
      name,
      path,
      checksumSha256: createHash("sha256").update(sql).digest("hex"),
      downChecksumSha256: createHash("sha256").update(downSql).digest("hex"),
      sql,
      downSql,
    });
  }

  migrations.sort((left, right) => left.version.localeCompare(right.version));
  const duplicates = migrations.filter(
    (migration, index) => migrations[index - 1]?.version === migration.version,
  );
  if (duplicates.length > 0) {
    throw new Error(`Duplicate migration version: ${duplicates[0]?.version}`);
  }
  return migrations;
}

export async function applyMigrations(
  pool: ConnectionPool,
  directory: string,
): Promise<MigrationResult> {
  const migrations = await loadMigrations(directory);
  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  await withMigrationSession(pool, async (client) => {
    for (const migration of migrations) {
      const recorded = await findRecordedMigration(client, migration.version);
      if (recorded !== undefined) {
        if (recorded.checksum_sha256 !== migration.checksumSha256) {
          throw new Error(
            `Applied migration ${migration.version} has a different checksum`,
          );
        }
        if (recorded.down_checksum_sha256 !== migration.downChecksumSha256) {
          throw new Error(
            `Applied down migration ${migration.version} has a different checksum`,
          );
        }
        alreadyApplied.push(migration.version);
        continue;
      }

      await client.query("BEGIN");
      await client.query(migration.sql);
      await client.query(
        `INSERT INTO acp.schema_migrations (
             version, name, checksum_sha256, down_checksum_sha256
           ) VALUES ($1, $2, $3, $4)`,
        [
          migration.version,
          migration.name,
          migration.checksumSha256,
          migration.downChecksumSha256,
        ],
      );
      await client.query("COMMIT");
      applied.push(migration.version);
    }
  });

  return { applied, alreadyApplied };
}

export async function rollbackMigrations(
  pool: ConnectionPool,
  directory: string,
): Promise<readonly string[]> {
  const migrations = (await loadMigrations(directory)).reverse();
  const rolledBack: string[] = [];

  await withMigrationSession(pool, async (client) => {
    for (const migration of migrations) {
      const recorded = await findRecordedMigration(client, migration.version);
      if (recorded === undefined) continue;
      if (recorded.checksum_sha256 !== migration.checksumSha256) {
        throw new Error(`Applied migration ${migration.version} has a different checksum`);
      }
      if (recorded.down_checksum_sha256 !== migration.downChecksumSha256) {
        throw new Error(
          `Applied down migration ${migration.version} has a different checksum`,
        );
      }

      await client.query("BEGIN");
      await client.query("DELETE FROM acp.schema_migrations WHERE version = $1", [
        migration.version,
      ]);
      await client.query(migration.downSql);
      await client.query("COMMIT");
      rolledBack.push(migration.version);
    }
  });

  return rolledBack;
}

async function withMigrationSession<T>(pool: ConnectionPool, operation: (client: QueryExecutor) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let failure: Error | undefined;
  const failed = (error: Error) => { failure ??= error; };
  client.on?.("error", failed);
  const guarded: QueryExecutor = { async query<R extends QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>> {
    if (failure) throw failure;
    const result = await client.query<R>(text, values);
    if (failure) throw failure;
    return result;
  } };
  try {
    // Keep the existing namespace so old and new runners still serialize.
    await guarded.query("SELECT pg_advisory_lock(hashtext($1))", [migrationLockKey]);
    return await operation(guarded);
  } finally {
    // Migrations are infrequent and always use a disposable physical session.
    // Closing it rolls back an uncertain/open transaction and releases every
    // reentrant session lock. Never pool it or issue cleanup SQL after failure.
    try { client.release(true); }
    finally { client.off?.("error", failed); }
  }
}

async function findRecordedMigration(
  client: QueryExecutor,
  version: string,
): Promise<{
  readonly checksum_sha256: string;
  readonly down_checksum_sha256: string;
} | undefined> {
  const schema = await client.query<{ readonly exists: boolean }>(
    "SELECT to_regclass('acp.schema_migrations') IS NOT NULL AS exists",
  );
  if (schema.rows[0]?.exists !== true) return undefined;

  const result = await client.query<{
    readonly checksum_sha256: string;
    readonly down_checksum_sha256: string;
  }>(
    `SELECT checksum_sha256, down_checksum_sha256
     FROM acp.schema_migrations WHERE version = $1`,
    [version],
  );
  return result.rows[0];
}
