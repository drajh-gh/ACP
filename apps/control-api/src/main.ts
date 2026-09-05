import { Pool } from "pg";
import { asConnectionPool, PostgresCounterpartMissionStore } from "@acp/storage";

import { parseControlApiConfig } from "./config.ts";
import { createControlApiServer } from "./http-server.ts";

const config = parseControlApiConfig(process.env);
const pool = new Pool({ connectionString: config.databaseUrl });
const persistence = new PostgresCounterpartMissionStore(
  asConnectionPool(pool),
  config.runtimeProvenanceId,
);
const server = createControlApiServer({
  persistence,
  bearerToken: config.bearerToken,
  allowedHosts: config.allowedHosts,
  allowedOrigins: config.allowedOrigins,
  allowedPluginVersions: config.allowedPluginVersions,
  trustedProxyAddresses: config.trustedProxyAddresses,
  requireForwardedHttps: config.requireForwardedHttps,
});

server.listen(config.port, config.hostname, () => {
  process.stdout.write(
    `ACP control API listening on ${config.hostname}:${config.port}\n`,
  );
});

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
  await pool.end();
}

process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
