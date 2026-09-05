import { parseStableId, type StableId } from "./ids.ts";
import { maximumContextPacketBytes, parseWorkerLimits, type WorkerLimits } from "./runtime.ts";
import {
  expectJsonValue, expectOnlyKeys, expectRecord, expectString,
  expectStringArray, type JsonValue,
} from "./validation.ts";

/** Published by the supervisor; reference selection is part of durable intent. */
export interface NodeContextContent {
  readonly objective: string;
  readonly nonGoals: readonly string[];
  readonly behavioralContract: Readonly<Record<string, JsonValue>>;
  readonly acceptanceCriteria: readonly string[];
  readonly conflicts: readonly string[];
  readonly unresolvedQuestions: readonly string[];
  readonly nextAction: string;
  readonly limits: WorkerLimits;
  readonly evidenceIds: readonly StableId<"evidence">[];
  readonly activeClaimIds: readonly StableId<"claim">[];
  readonly previousRunIds: readonly StableId<"run">[];
  readonly approvalIds: readonly StableId<"approval">[];
}

export function parseNodeContextContent(value: unknown): NodeContextContent {
  const input = expectRecord(value, "nodeContext");
  expectOnlyKeys(input, [
    "objective", "nonGoals", "behavioralContract", "acceptanceCriteria",
    "conflicts", "unresolvedQuestions", "nextAction", "limits", "evidenceIds",
    "activeClaimIds", "previousRunIds", "approvalIds",
  ], "nodeContext");
  const result: NodeContextContent = {
    objective: expectString(input.objective, "nodeContext.objective"),
    nonGoals: expectStringArray(input.nonGoals, "nodeContext.nonGoals"),
    behavioralContract: expectJsonValue(
      expectRecord(input.behavioralContract, "nodeContext.behavioralContract"),
      "nodeContext.behavioralContract",
    ) as Readonly<Record<string, JsonValue>>,
    acceptanceCriteria: expectStringArray(input.acceptanceCriteria, "nodeContext.acceptanceCriteria"),
    conflicts: expectStringArray(input.conflicts, "nodeContext.conflicts"),
    unresolvedQuestions: expectStringArray(input.unresolvedQuestions, "nodeContext.unresolvedQuestions"),
    nextAction: expectString(input.nextAction, "nodeContext.nextAction"),
    limits: parseWorkerLimits(input.limits),
    evidenceIds: uniqueIds(input.evidenceIds, "evidence"),
    activeClaimIds: uniqueIds(input.activeClaimIds, "claim"),
    previousRunIds: uniqueIds(input.previousRunIds, "run"),
    approvalIds: uniqueIds(input.approvalIds, "approval"),
  };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > maximumContextPacketBytes) {
    throw new TypeError("node context exceeds the context packet byte limit");
  }
  return result;
}

function uniqueIds<K extends "evidence" | "claim" | "run" | "approval">(
  value: unknown,
  kind: K,
): readonly StableId<K>[] {
  const values = expectStringArray(value, `nodeContext.${kind}Ids`)
    .map((id) => parseStableId(id, kind));
  if (values.length > 100 || new Set(values).size !== values.length) {
    throw new TypeError(`node context ${kind} references must be unique and at most 100`);
  }
  return values;
}
