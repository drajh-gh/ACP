import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Pool, type QueryResult, type QueryResultRow } from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createStableId, type StableId } from "@acp/domain";
import { PostgresCounterpartMissionStore, type ConnectionPool, type CounterpartMissionCreation } from "@acp/storage";
import { createControlApiServer } from "../../src/http-server.ts";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("owned database port required");
const pool = new Pool({ connectionString: `postgresql://postgres:acp_test_password@127.0.0.1:${port}/acp_test`,
  max: 4, connectionTimeoutMillis: 3000, statement_timeout: 5000, lock_timeout: 2000 });
const projectId = "prj_00000000-0000-4000-8000-000000000001" as StableId<"project">;
const provenanceId = "prv_00000000-0000-4000-8000-000000000001" as StableId<"provenance">;
const workflowId = "wfl_00000000-0000-4000-8000-000000000001" as StableId<"workflow">;
const bearerToken = "synthetic-counterpart-http-token-not-a-real-secret";
const sentinel = "synthetic-private-schema.connection-path-must-not-escape";
const unconfirmed = "ACP mission creation could not be confirmed. Reuse the same request ID only with unchanged terms.";
let checks = 0;
async function check(name: string, action: () => Promise<void>) { await action(); checks++; process.stdout.write(`PASS counterpart HTTP: ${name}\n`); }
function request() { return { clientRequestId: createStableId("event"), projectId, workflowKey: workflowId,
  objective: "Inspect this synthetic ž 🚀 mission.", requestedScope: "Return a verified diagnosis only." }; }
type Counts = { missions: number; events: number; requests: number; runs: number; effects: number; nodes: number };
async function counts(): Promise<Counts> {
  return (await pool.query(`SELECT (SELECT count(*)::int FROM acp.missions) AS missions,
    (SELECT count(*)::int FROM acp.mission_events) AS events,(SELECT count(*)::int FROM acp.counterpart_mission_requests) AS requests,
    (SELECT count(*)::int FROM acp.worker_runs) AS runs,(SELECT count(*)::int FROM acp.effect_proposals) AS effects,
    (SELECT count(*)::int FROM acp.mission_nodes) AS nodes`)).rows[0] as Counts;
}
function plusOne(before: Counts): Counts { return { ...before, missions: before.missions + 1, events: before.events + 1, requests: before.requests + 1 }; }
type Result = Awaited<ReturnType<Client["callTool"]>>;
function creation(result: Result): CounterpartMissionCreation {
  assert.notEqual(result.isError, true); assert.ok(result.structuredContent);
  return result.structuredContent as unknown as CounterpartMissionCreation;
}
function denied(result: Result) {
  assert.equal(result.isError, true); assert.equal(result.structuredContent, undefined);
  assert.deepEqual(result.content, [{ type: "text", text: unconfirmed }]);
  assert.equal(JSON.stringify(result).includes(sentinel), false);
}

function observedStore(loseCommitReply = false) {
  let connections = 0, directReads = 0, commits = 0;
  const sessions: { pid: number; ended: Promise<void>; releases: (boolean | Error | undefined)[] }[] = [];
  const connection: ConnectionPool = {
    async query<R extends QueryResultRow>(sql: string, values?: unknown[]): Promise<QueryResult<R>> {
      directReads++; return pool.query<R>(sql, values);
    },
    async connect() {
      connections++;
      const client = await pool.connect(), ended = new Promise<void>(resolve => client.once("end", () => resolve()));
      client.on("error", () => {}); // Fixture owns failures before identity acquisition too.
      try {
        const pid = Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        process.stdout.write(`Owned database backend ${pid}: mission HTTP creation\n`);
        const releases: (boolean | Error | undefined)[] = []; sessions.push({ pid, ended, releases });
        return { on: client.on.bind(client), off: client.off.bind(client),
          release(discard?: boolean | Error) { releases.push(discard); client.release(discard); },
          async query<R extends QueryResultRow>(sql: string, values?: unknown[]): Promise<QueryResult<R>> {
            const result = await client.query<R>(sql, values);
            if (sql === "COMMIT") {
              commits++;
              if (loseCommitReply) { loseCommitReply = false; throw new Error(sentinel); }
            }
            return result;
          } };
      } catch (error) {
        try { client.release(true); } catch { /* Preserve identity-read failure. */ }
        await ended; throw error;
      }
    },
  };
  return { store: new PostgresCounterpartMissionStore(connection, provenanceId), sessions,
    get connections() { return connections; }, get directReads() { return directReads; }, get commits() { return commits; } };
}
async function assertClosed(probe: ReturnType<typeof observedStore>) {
  for (const session of probe.sessions) {
    assert.deepEqual(session.releases, [true]); await session.ended;
    const deadline = Date.now() + 2000;
    while ((await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1) AS remains", [session.pid])).rows[0].remains) {
      if (Date.now() >= deadline) assert.fail("owned mission HTTP backend remained after discard");
      await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
  }
}
async function withClient(probe: ReturnType<typeof observedStore>, action: (client: Client, url: string) => Promise<void>) {
  const server = createControlApiServer({ persistence: probe.store, bearerToken });
  const client = new Client({ name: "acp-counterpart-postgres-http", version: "1.0.0" });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: {
      Authorization: `Bearer ${bearerToken}`, "X-ACP-Plugin-Version": "0.2.0",
    } } });
    await client.connect(transport as unknown as Transport); await action(client, url);
  } finally {
    try { await client.close(); }
    finally { if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  }
}

try {
  await check("authentication and exact input rejection happen before any SQL", async () => {
    const probe = observedStore(), before = await counts();
    await withClient(probe, async (client, url) => {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_mission", arguments: request() } }) });
      assert.equal(response.status, 401);
      for (const input of [{ ...request(), workflowKey: "WF-ENG" }, { ...request(), projectId: "prj_123" }, { ...request(), authorizationGranted: true }]) {
        const result = await client.callTool({ name: "create_mission", arguments: input });
        assert.equal(result.isError, true); assert.equal(result.structuredContent, undefined);
      }
      assert.equal(probe.connections, 0); assert.equal(probe.directReads, 0); assert.deepEqual(await counts(), before);
    });
  });
  await check("actual HTTP creation and exact replay retain one history without dispatch or effects", async () => {
    const probe = observedStore(), input = request(), before = await counts();
    await withClient(probe, async client => {
      const first = creation(await client.callTool({ name: "create_mission", arguments: input }));
      assert.equal(first.replayed, false); assert.equal(first.mission.projectId, projectId); assert.equal(first.mission.workflowId, workflowId);
      assert.equal(first.mission.workflowVersion, "1.0.0"); assert.equal(first.mission.state, "received"); assert.deepEqual(first.mission.nodes, []);
      const replay = creation(await client.callTool({ name: "create_mission", arguments: input }));
      assert.equal(replay.replayed, true); assert.deepEqual(replay.mission, first.mission);
      denied(await client.callTool({ name: "create_mission", arguments: { ...input, objective: "Different terms." } }));
      assert.deepEqual(await counts(), plusOne(before)); assert.equal(probe.connections, 3); assert.equal(probe.commits, 2);
      const active = await client.callTool({ name: "list_active_missions", arguments: { projectId, limit: 200 } });
      assert.notEqual(active.isError, true);
      assert.ok((active.structuredContent as { missions: { missionId: string }[] }).missions.some(m => m.missionId === first.mission.missionId));
    });
    await assertClosed(probe);
  });
  await check("unavailable exact workflow returns a generic denial and persists no history", async () => {
    const probe = observedStore(), before = await counts();
    await withClient(probe, async client => {
      denied(await client.callTool({ name: "create_mission", arguments: { ...request(), workflowKey: createStableId("workflow") } }));
      assert.equal(probe.connections, 1); assert.equal(probe.commits, 0); assert.deepEqual(await counts(), before);
    });
    await assertClosed(probe);
  });
  await check("lost actual COMMIT reply is unconfirmed; explicit exact retry reconciles without duplication", async () => {
    const probe = observedStore(true), input = request(), before = await counts();
    await withClient(probe, async client => {
      denied(await client.callTool({ name: "create_mission", arguments: input }));
      assert.equal(probe.connections, 1); assert.equal(probe.commits, 1); // No hidden retry/readback in the handler.
      assert.equal(probe.directReads, 0); await assertClosed(probe);
      const retained = await counts(); assert.deepEqual(retained, plusOne(before));
      const identity = (await pool.query("SELECT mission_id FROM acp.counterpart_mission_requests WHERE client_request_id=$1", [input.clientRequestId])).rows[0]?.mission_id;
      assert.equal(typeof identity, "string");
      const replay = creation(await client.callTool({ name: "create_mission", arguments: input }));
      assert.equal(replay.replayed, true); assert.equal(replay.mission.missionId, identity);
      denied(await client.callTool({ name: "create_mission", arguments: { ...input, requestedScope: "Different scope." } }));
      assert.equal(probe.connections, 3); assert.equal(probe.commits, 2); assert.deepEqual(await counts(), retained);
    });
    await assertClosed(probe);
  });
  assert.equal(checks, 4); process.stdout.write(`Counterpart PostgreSQL and HTTP integration: ${checks} checks passed.\n`);
} finally { await pool.end(); }
