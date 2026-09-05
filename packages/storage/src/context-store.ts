import {
  canonicalJsonDigest, createContextPacket, parseContextPacket, parseNodeContextContent,
  parseStableId, type ContextPacket, type ContextPacketContent, type NodeContextContent,
  type StableId, type JsonValue,
} from "@acp/domain";
import type { ConnectionPool } from "./database.ts";
import { withTransaction } from "./database.ts";

export interface NodeContextPublication {
  readonly contextRevisionId: StableId<"nodeContextRevision">;
  readonly missionId: StableId<"mission">;
  readonly nodeId: StableId<"node">;
  readonly graphRevision: string;
  readonly expectedRevision: number;
  readonly content: NodeContextContent;
  readonly provenanceId: StableId<"provenance">;
}

/** Trusted supervisor identity only. No worker-supplied narrative or source data. */
export interface ContextPacketBuildRequest {
  readonly contextPacketId: StableId<"contextPacket">;
  readonly missionId: StableId<"mission">;
  readonly nodeId: StableId<"node">;
  readonly capabilityGrantId: StableId<"capabilityGrant">;
  readonly runtimeTemplateProvenanceId: StableId<"provenance">;
  readonly provenanceId: StableId<"provenance">;
}

export class PostgresContextStore {
  private readonly pool: ConnectionPool;
  constructor(pool: ConnectionPool) { this.pool = pool; }

  async publishNodeContext(input: NodeContextPublication): Promise<number> {
    const content = parseNodeContextContent(input.content);
    const digest = canonicalJsonDigest(content as unknown as JsonValue);
    parseStableId(input.contextRevisionId, "nodeContextRevision");
    parseStableId(input.missionId, "mission");
    parseStableId(input.nodeId, "node");
    parseStableId(input.provenanceId, "provenance");
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
        || input.expectedRevision >= 2147483647 || !input.graphRevision.trim()) {
      throw new TypeError("node context requires a graph revision and bounded expected revision");
    }
    return withTransaction(this.pool, async (client) => {
      // The row lock serializes independent publishers. Subsequent READ COMMITTED
      // statements see the winner's revision after a wait, so the loser fails CAS.
      await client.query("SELECT mission_id FROM acp.missions WHERE mission_id = $1 FOR UPDATE", [input.missionId]);
      const node = await client.query(
        "SELECT node_id FROM acp.mission_nodes WHERE mission_id = $1 AND node_id = $2 FOR UPDATE",
        [input.missionId, input.nodeId],
      );
      if (!node.rowCount) throw new Error("node context mission/node does not exist");
      const replay = await client.query(
        `SELECT revision, mission_id, node_id, graph_revision, digest, provenance_id
         FROM acp.node_context_revisions WHERE context_revision_id = $1`,
        [input.contextRevisionId],
      );
      const existing = replay.rows[0];
      if (existing) {
        if (existing.mission_id !== input.missionId || existing.node_id !== input.nodeId
            || existing.graph_revision !== input.graphRevision || existing.digest !== digest
            || existing.provenance_id !== input.provenanceId
            || existing.revision !== input.expectedRevision + 1) {
          throw new Error("node context revision ID is already bound to different content");
        }
        return existing.revision as number;
      }
      await client.query(
        `INSERT INTO acp.node_context_revisions (context_revision_id, mission_id, node_id,
          revision, graph_revision, content, digest, provenance_id)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
        [input.contextRevisionId, input.missionId, input.nodeId, input.expectedRevision + 1,
          input.graphRevision, JSON.stringify(content), digest, input.provenanceId],
      );
      return input.expectedRevision + 1;
    });
  }

  async buildAndRecordContextPacket(input: ContextPacketBuildRequest): Promise<ContextPacket> {
    // Reconstruct the request to exclude accidental extra caller properties.
    const request: ContextPacketBuildRequest = {
      contextPacketId: parseStableId(input.contextPacketId, "contextPacket"),
      missionId: parseStableId(input.missionId, "mission"),
      nodeId: parseStableId(input.nodeId, "node"),
      capabilityGrantId: parseStableId(input.capabilityGrantId, "capabilityGrant"),
      runtimeTemplateProvenanceId: parseStableId(input.runtimeTemplateProvenanceId, "provenance"),
      provenanceId: parseStableId(input.provenanceId, "provenance"),
    };
    const requestDigest = canonicalJsonDigest(request as unknown as JsonValue);
    return withTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`acp:context-packet:${request.contextPacketId}`]);
      const replay = await client.query(
        "SELECT packet, build_request_digest FROM acp.context_packets WHERE context_packet_id = $1",
        [request.contextPacketId],
      );
      if (replay.rows[0]) {
        if (replay.rows[0].build_request_digest !== requestDigest) {
          throw new Error("context packet ID is already bound to a different build request");
        }
        // Historical retrieval is NOT authorization to start another worker run.
        return parseContextPacket(replay.rows[0].packet);
      }
      await client.query("SELECT mission_id FROM acp.missions WHERE mission_id = $1 FOR UPDATE", [request.missionId]);
      const node = await client.query(
        "SELECT node_id FROM acp.mission_nodes WHERE mission_id = $1 AND node_id = $2 FOR UPDATE",
        [request.missionId, request.nodeId],
      );
      if (!node.rowCount) throw new Error("context packet mission/node does not exist");
      const assembled = await client.query(
        `SELECT context_revision_id, acp.build_context_packet_content(
          $1::acp.stable_id, $2::acp.stable_id, $3::acp.stable_id,
          context_revision_id, $4::acp.stable_id) AS content
         FROM acp.node_context_revisions WHERE mission_id = $2 AND node_id = $3
         ORDER BY revision DESC LIMIT 1`,
        [request.contextPacketId, request.missionId, request.nodeId, request.capabilityGrantId],
      );
      const revision = assembled.rows[0];
      if (!revision) throw new Error("node has no published authoritative context revision");
      const packet = createContextPacket(revision.content as ContextPacketContent);
      const provenance = await client.query(
        `INSERT INTO acp.runtime_provenance SELECT (jsonb_populate_record(
          NULL::acp.runtime_provenance, to_jsonb(template) || jsonb_build_object(
            'provenance_id', $1::text, 'context_packet_schema_version', $2::text,
            'context_packet_digest', $3::text, 'recorded_at', statement_timestamp()))).*
         FROM acp.runtime_provenance template WHERE provenance_id = $4
           AND acp.runtime_provenance_matches_context(provenance_id, $5::acp.stable_id)`,
        [request.provenanceId, packet.schemaVersion, packet.digest,
          request.runtimeTemplateProvenanceId, request.missionId],
      );
      if (!provenance.rowCount) throw new Error("runtime template does not match the mission");
      // The INSERT trigger recomputes authoritative content. Source changes between
      // assembly and insertion reject the whole transaction, including provenance.
      await client.query(
        `INSERT INTO acp.context_packets (context_packet_id, mission_id, node_id,
          schema_version, digest, packet, provenance_id, capability_grant_id,
          context_revision_id, build_request_digest, runtime_template_provenance_id)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11)`,
        [request.contextPacketId, request.missionId, request.nodeId, packet.schemaVersion,
          packet.digest, JSON.stringify(packet), request.provenanceId, request.capabilityGrantId,
          revision.context_revision_id, requestDigest, request.runtimeTemplateProvenanceId],
      );
      return packet;
    });
  }
}
