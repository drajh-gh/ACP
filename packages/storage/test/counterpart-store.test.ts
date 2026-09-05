import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canonicalJsonDigest,
  createStableId,
  type StableId,
} from "@acp/domain";
import type { QueryResult, QueryResultRow } from "pg";

import type { ConnectionPool, TransactionClient } from "../src/database.ts";
import { PostgresCounterpartMissionStore } from "../src/counterpart-store.ts";
import { statusFixture } from "./fixtures/counterpart-status.ts";

type Response =
  | { readonly rows?: readonly QueryResultRow[]; readonly rowCount?: number }
  | Error;

class ScriptedPool implements ConnectionPool, TransactionClient {
  readonly queries: { readonly text: string; readonly values: readonly unknown[] }[] = [];
  private readonly responses: Response[];

  constructor(responses: Response[]) {
    this.responses = responses;
  }

  async connect(): Promise<TransactionClient> {
    return this;
  }

  release(): void {}

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<R>> {
    this.queries.push({ text, values });
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
      return result<R>([]);
    }
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    if (response === undefined) throw new Error(`No scripted response for ${text}`);
    return result<R>((response.rows ?? []) as readonly R[], response.rowCount);
  }
}

describe("PostgresCounterpartMissionStore", () => {
  it("reads mission, nodes and independent lifecycle in one bounded statement without transaction or execution authority",async()=>{
    const snapshot=statusFixture(),pool=new ScriptedPool([{ rows:[{ snapshot,status_error:null }] }]);
    const store=new PostgresCounterpartMissionStore(pool,createStableId("provenance"));
    assert.deepEqual(await store.getMissionStatus(snapshot.missionId),snapshot);
    assert.equal(pool.queries.length,1); assert.match(pool.queries[0]!.text,/^WITH/u);
    assert.deepEqual(pool.queries[0]!.values,[snapshot.missionId,200,50,65536]);
    assert.doesNotMatch(pool.queries[0]!.text,/build_context_packet_content|FOR UPDATE|INSERT INTO|UPDATE acp|DELETE FROM/u);
  });
  it("validates status identity before querying and returns absent only for an absent mission",async()=>{
    const pool=new ScriptedPool([{ rows:[] }]),store=new PostgresCounterpartMissionStore(pool,createStableId("provenance"));
    await assert.rejects(store.getMissionStatus(createStableId("node") as never)); assert.equal(pool.queries.length,0);
    assert.equal(await store.getMissionStatus(createStableId("mission")),undefined); assert.equal(pool.queries.length,1);
  });
  it("denies oversized, cross-project, restricted, malformed and mismatched snapshots without returning partial status",async()=>{
    const snapshot=statusFixture();
    for(const row of [{ status_error:"too_large",snapshot:null },{ status_error:"invalid_references",snapshot:null },
      { status_error:"unexpected",snapshot:null },{ status_error:null,snapshot:{ ...snapshot,statusSchemaVersion:"bad" } },
      { status_error:null,snapshot:{ ...snapshot,missionId:createStableId("mission") } }]) {
      const pool=new ScriptedPool([{ rows:[row] }]);
      await assert.rejects(new PostgresCounterpartMissionStore(pool,createStableId("provenance")).getMissionStatus(snapshot.missionId));
      assert.equal(pool.queries.length,1);
    }
  });
  it("creates a mission from exactly one active binding and records idempotency", async () => {
    const projectId = createStableId("project");
    const provenanceId = createStableId("provenance");
    const missionRow = rowFor(projectId);
    const pool = new ScriptedPool([
      {},
      { rows: [] },
      { rows: [{
        binding_id: createStableId("workflowBinding"),
        workflow_id: missionRow.workflow_id,
        workflow_version: missionRow.workflow_version,
        completion_contract_id: missionRow.completion_contract_id,
        completion_contract_version: missionRow.completion_contract_version,
      }] },
      { rows: [{ occurred_at: new Date("2026-09-04T12:00:00.000Z") }] },
      { rows: [missionRow] },
      { rowCount: 1 },
      { rowCount: 1 },
      { rows: [] },
    ]);
    const store = new PostgresCounterpartMissionStore(pool, provenanceId);

    const created = await store.createMission({
      clientRequestId: "request-1",
      projectId,
      objective: "Diagnose the defect.",
      requestedScope: "Return a verified diagnosis.",
    });

    assert.equal(created.replayed, false);
    assert.equal(created.mission.projectId, projectId);
    assert.match(pool.queries[1]?.text ?? "", /pg_advisory_xact_lock/u);
    assert.match(
      pool.queries.find((query) => /INSERT INTO acp\.counterpart_mission_requests/u.test(query.text))?.text ?? "",
      /request_digest/u,
    );
  });

  it("returns the original mission for an identical replay", async () => {
    const projectId = createStableId("project");
    const provenanceId = createStableId("provenance");
    const missionRow = rowFor(projectId);
    const request = {
      clientRequestId: "request-1",
      projectId,
      objective: "Diagnose the defect.",
      requestedScope: "Return a verified diagnosis.",
    } as const;
    const matchingPool = new ScriptedPool([
      {},
      { rows: [{
        ...missionRow,
        request_digest: canonicalJsonDigest(request),
      }] },
      { rows: [] },
    ]);
    const store = new PostgresCounterpartMissionStore(matchingPool, provenanceId);

    const replay = await store.createMission(request);

    assert.equal(replay.replayed, true);
    assert.equal(replay.mission.missionId, missionRow.mission_id);
    assert.match(matchingPool.queries.at(-1)?.text ?? "", /COMMIT/u);
  });

  it("rejects a client request identifier that aliases different terms", async () => {
    const projectId = createStableId("project");
    const provenanceId = createStableId("provenance");
    const missionRow = rowFor(projectId);
    const matchingPool = new ScriptedPool([
      {},
      { rows: [{
        ...missionRow,
        request_digest: canonicalJsonDigest({
          clientRequestId: "request-1",
          projectId,
          objective: "Diagnose the defect.",
          requestedScope: "Return a verified diagnosis.",
        }),
      }] },
    ]);
    const store = new PostgresCounterpartMissionStore(matchingPool, provenanceId);

    await assert.rejects(
      store.createMission({
        clientRequestId: "request-1",
        projectId,
        objective: "A different objective.",
        requestedScope: "Return a verified diagnosis.",
      }),
      /aliases different mission terms/,
    );
    assert.match(matchingPool.queries.at(-1)?.text ?? "", /ROLLBACK/u);
  });
});

function rowFor(projectId: StableId<"project">) {
  return {
    mission_id: createStableId("mission"),
    project_id: projectId,
    state: "received",
    requested_scope: "Return a verified diagnosis.",
    workflow_id: createStableId("workflow"),
    workflow_version: "1.0.0",
    completion_contract_id: createStableId("completionContract"),
    completion_contract_version: "1.0.0",
    created_at: new Date("2026-09-04T12:00:00.000Z"),
    updated_at: new Date("2026-09-04T12:00:00.000Z"),
  };
}

function result<R extends QueryResultRow>(
  rows: readonly R[],
  rowCount = rows.length,
): QueryResult<R> {
  return {
    rows: [...rows],
    rowCount,
    command: "SCRIPTED",
    oid: 0,
    fields: [],
  };
}
