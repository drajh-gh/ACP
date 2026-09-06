import type { QueryResult, QueryResultRow } from "pg";
import type { ConnectionPool, QueryExecutor } from "./database.ts";

/** Opt-in physical-session containment. Never replays callbacks or resolves uncertain COMMITs. */
export async function withIsolatedTransaction<T>(
  pool: ConnectionPool,
  action: (client: QueryExecutor) => Promise<T>,
): Promise<T> {
  const physical = await pool.connect();
  let connectionFailure: Error | undefined;
  const failed = (error: Error) => { connectionFailure ??= error; };
  physical.on?.("error", failed);
  const client: QueryExecutor = {
    async query<R extends QueryResultRow>(sql: string, values?: unknown[]): Promise<QueryResult<R>> {
      if (connectionFailure) throw connectionFailure;
      const result = await physical.query<R>(sql, values);
      if (connectionFailure) throw connectionFailure;
      return result;
    },
  };
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* Physical discard resolves uncertain session state. */ }
    throw error;
  } finally {
    // Preserve the error listener until physical discard, including on success.
    // A lost COMMIT remains uncertain. In particular, never retry a heartbeat here.
    try { physical.release(true); } finally { physical.off?.("error", failed); }
  }
}
