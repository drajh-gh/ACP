export const idPrefixes = {
  adapter: "adp",
  approval: "apr",
  approvalEvaluation: "ape",
  artifact: "art",
  candidate: "can",
  claim: "clm",
  capabilityGrant: "cgr",
  capabilityGrantEvaluation: "cge",
  capabilityReadinessAssessment: "cra",
  changeSet: "chs",
  completionContract: "cct",
  completionEvaluation: "cev",
  contextPacket: "ctx",
  credentialReference: "cdr",
  effect: "eff",
  evidence: "evd",
  event: "evt",
  intake: "int",
  lease: "lea",
  mission: "mis",
  node: "nod",
  nodeContextRevision: "ncr",
  policy: "pol",
  executionPreconditionEvaluation: "epe",
  preconditionSnapshot: "pcs",
  project: "prj",
  projectProfile: "pro",
  projectProfileProposal: "pfp",
  provenance: "prv",
  reconciliation: "rcn",
  receipt: "rcp",
  repository: "repo",
  repositoryBinding: "rpb",
  worktreeBinding: "wtb",
  worktreeReservation: "wtr",
  worktreeProvisionerAttempt: "wpa",
  run: "run",
  runtimeControlEvent: "rce",
  runtimeControlAuthorization: "rca",
  schedule: "sch",
  sourceCursor: "cur",
  subscription: "sub",
  workflow: "wfl",
  workflowBinding: "wfb",
  workflowExecution: "wfx",
  workerProcess: "wpr",
  workerHostSession: "whs",
} as const;

export type EntityKind = keyof typeof idPrefixes;

export type StableId<K extends EntityKind = EntityKind> =
  `${(typeof idPrefixes)[K]}_${string}`;

const uuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function createStableId<K extends EntityKind>(kind: K): StableId<K> {
  return `${idPrefixes[kind]}_${globalThis.crypto.randomUUID()}` as StableId<K>;
}

export function isStableId<K extends EntityKind>(
  value: unknown,
  kind: K,
): value is StableId<K> {
  if (typeof value !== "string") {
    return false;
  }

  const prefix = `${idPrefixes[kind]}_`;
  return value.startsWith(prefix) && uuidV4Pattern.test(value.slice(prefix.length));
}

export function parseStableId<K extends EntityKind>(
  value: unknown,
  kind: K,
): StableId<K> {
  if (!isStableId(value, kind)) {
    throw new TypeError(`Invalid ${kind} identifier`);
  }

  return value;
}
