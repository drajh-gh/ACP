import type { Pool, QueryResult, QueryResultRow } from "pg";

export interface QueryExecutor {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

export function asConnectionPool(pool: Pool): ConnectionPool {
  return pool;
}

export interface ConnectionPool extends QueryExecutor {
  connect(): Promise<TransactionClient>;
}

export interface TransactionClient extends QueryExecutor {
  release(error?: Error | boolean): void;
  on?(event: "error", listener: (error: Error) => void): unknown;
  off?(event: "error", listener: (error: Error) => void): unknown;
}

export async function withTransaction<T>(
  pool: ConnectionPool,
  operation: (client: QueryExecutor) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function acquireEffectAuthorityLock(
  client: QueryExecutor,
): Promise<void> {
  await client.query("SELECT acp.acquire_effect_authority_lock()");
}
