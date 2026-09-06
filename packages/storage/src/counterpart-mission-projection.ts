import {
  expectArray, expectBoolean, expectEnum, expectOnlyKeys, expectRecord, expectString,
  missionStates, parseCanonicalTimestamp, parseStableId, snapshotJsonData, workerRoles,
  type MissionState, type StableId,
} from "@acp/domain";

export const counterpartMissionMaximumBytes = 65_536;
export const counterpartMissionCollectionLimit = 200;
// Exact acp.mission_nodes vocabulary from migration 0002; not dispatch-request states.
export const counterpartMissionNodeStates = ["pending", "runnable", "running", "awaiting_event", "succeeded", "failed", "needs_input", "cancelled"] as const;
export const counterpartMissionSummaryFields = ["missionId", "projectId", "state", "requestedScope", "workflowId", "workflowVersion",
  "completionContractId", "completionContractVersion", "createdAt", "updatedAt"] as const;

export interface CounterpartMissionNodeProjection {
  readonly nodeId: StableId<"node">;
  readonly nodeType: string;
  readonly workerRole: string;
  readonly state: string;
  readonly graphRevision: string;
}
export interface CounterpartMissionSummary {
  readonly missionId: StableId<"mission">;
  readonly projectId: StableId<"project">;
  readonly state: MissionState;
  readonly requestedScope: string;
  readonly workflowId: StableId<"workflow">;
  readonly workflowVersion: string;
  readonly completionContractId: StableId<"completionContract">;
  readonly completionContractVersion: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface CounterpartMissionProjection extends CounterpartMissionSummary {
  readonly nodes: readonly CounterpartMissionNodeProjection[];
}
export interface CounterpartMissionCreation {
  readonly mission: CounterpartMissionProjection;
  readonly replayed: boolean;
}

export function snapshotCounterpartMissionData(value: unknown) {
  return snapshotJsonData(value, { maximumBytes: counterpartMissionMaximumBytes });
}

export function parseCounterpartMissionCreation(value: unknown): CounterpartMissionCreation {
  const input = exact(snapshotCounterpartMissionData(value), ["mission", "replayed"]);
  return { mission: projection(input.mission), replayed: expectBoolean(input.replayed, "creation.replayed") };
}

export function parseCounterpartMissionProjection(value: unknown): CounterpartMissionProjection {
  return projection(snapshotCounterpartMissionData(value));
}

export function parseCounterpartActiveMissions(value: unknown, projectId: StableId<"project"> | undefined, limit: number): readonly CounterpartMissionSummary[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > counterpartMissionCollectionLimit) throw new TypeError("invalid mission list limit");
  // Count the actual structured-content wrapper, not just the array of rows.
  const input = exact(snapshotCounterpartMissionData({ missions: value }), ["missions"]);
  const rows = expectArray(input.missions, "missions");
  if (rows.length > limit) throw new TypeError("mission list exceeds its requested limit");
  const missions = rows.map((row) => parseCounterpartMissionSummaryFields(exact(row, counterpartMissionSummaryFields)));
  if (new Set(missions.map((mission) => mission.missionId)).size !== missions.length
    || missions.some((mission) => (projectId !== undefined && mission.projectId !== projectId)
      || ["complete_for_scope", "failed", "cancelled"].includes(mission.state))) {
    throw new TypeError("mission list does not match its exact active query");
  }
  return missions;
}

/** Internal composition over already-detached data. Caller owns the whole-record exact-key check. */
export function parseCounterpartMissionSummaryFields(input: Record<string, unknown>): CounterpartMissionSummary {
  return {
    missionId: parseStableId(input.missionId, "mission"), projectId: parseStableId(input.projectId, "project"),
    state: expectEnum(input.state, missionStates, "mission.state"), requestedScope: text(input.requestedScope),
    workflowId: parseStableId(input.workflowId, "workflow"), workflowVersion: version(input.workflowVersion),
    completionContractId: parseStableId(input.completionContractId, "completionContract"), completionContractVersion: version(input.completionContractVersion),
    createdAt: timestamp(input.createdAt), updatedAt: timestamp(input.updatedAt),
  };
}

/** Internal composition over already-detached data. */
export function parseCounterpartMissionNodes(value: unknown): readonly CounterpartMissionNodeProjection[] {
  const values = expectArray(value, "mission.nodes");
  if (values.length > counterpartMissionCollectionLimit) throw new TypeError("mission nodes exceed bounded snapshot");
  const nodes = values.map((value) => {
    const node = exact(value, ["nodeId", "nodeType", "workerRole", "state", "graphRevision"]);
    return { nodeId: parseStableId(node.nodeId, "node"), nodeType: text(node.nodeType), graphRevision: text(node.graphRevision),
      workerRole: expectEnum(node.workerRole, workerRoles, "node.workerRole"), state: expectEnum(node.state, counterpartMissionNodeStates, "node.state") };
  });
  if (new Set(nodes.map((node) => node.nodeId)).size !== nodes.length) throw new TypeError("mission nodes require unique identities");
  return nodes;
}

function projection(value: unknown): CounterpartMissionProjection {
  const input = exact(value, [...counterpartMissionSummaryFields, "nodes"]);
  return { ...parseCounterpartMissionSummaryFields(input), nodes: parseCounterpartMissionNodes(input.nodes) };
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const input = expectRecord(value, "mission response"); expectOnlyKeys(input, keys, "mission response");
  if (keys.some((key) => !Object.hasOwn(input, key))) throw new TypeError("mission response requires every declared field");
  return input;
}
function text(value: unknown): string {
  const result = expectString(value, "mission text");
  if (result.length > 4096) throw new TypeError("mission text exceeds bounded snapshot");
  return result;
}
function version(value: unknown): string {
  const result = text(value);
  // Same contract as acp.semantic_version; do not silently impose a stricter versioning policy.
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(result)) throw new TypeError("invalid pinned semantic version");
  return result;
}
function timestamp(value: unknown): string {
  const result = text(value); parseCanonicalTimestamp(result); return result;
}
