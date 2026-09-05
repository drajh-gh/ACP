import { createHash } from "node:crypto";

import {
  DBOS,
  Error as DBOSErrors,
  type WorkflowHandle,
} from "@dbos-inc/dbos-sdk";
import {
  expectRecord,
  parseStableId,
  timestampMilliseconds,
  type JsonValue,
  type MissionState,
  type StableId,
} from "@acp/domain";

export const missionControlQueueName = "acp-mission-control-v1";
export const heavyWorkerQueueName = "acp-worker-heavy-v1";
export const issueDeliveryWorkflowName = "acp.issue_delivery.v1";
export const deliveryNodeWorkflowName = "acp.execute_delivery_node.v1";

export interface IssueDeliveryInput {
  readonly missionId: StableId<"mission">;
  readonly approvalNodeId: StableId<"node">;
  readonly approvalSubscriptionId: StableId<"subscription">;
  readonly workflowExecutionId: StableId<"workflowExecution">;
  readonly dbosWorkflowId: string;
  readonly workflowVersion: string;
  readonly graphRevision: string;
  readonly provenanceId: StableId<"provenance">;
  readonly approvalExpiresAt: string;
}

export interface DeliveryNodeResult {
  readonly status:
    | "succeeded"
    | "failed"
    | "awaiting_approval"
    | "effect_authorized"
    | "needs_input";
  readonly conclusion: string;
  readonly output: JsonValue;
}

export interface ApprovalSignal {
  readonly approvalId: StableId<"approval">;
}

export interface DeliveryExecutionContext {
  readonly abortSignal: AbortSignal;
}

export interface ApprovalResolutionRequest {
  readonly input: IssueDeliveryInput;
  readonly effectId: StableId<"effect">;
  readonly approvalId: StableId<"approval">;
}

export interface WorkflowPersistenceUpdate {
  readonly input: IssueDeliveryInput;
  readonly state: "running" | "success" | "error";
}

export interface MissionPersistenceUpdate {
  readonly input: IssueDeliveryInput;
  readonly state: MissionState;
  readonly idempotencyKey: string;
  readonly eventId: StableId<"event">;
  readonly occurredAt: string;
}

export interface SubscriptionPersistenceUpdate {
  readonly input: IssueDeliveryInput;
  readonly topic: "approval";
  readonly state: "waiting" | "received" | "expired";
}

export interface IssueDeliveryDependencies {
  readonly persistWorkflowState: (
    update: WorkflowPersistenceUpdate,
  ) => Promise<void>;
  readonly persistMissionState: (
    update: MissionPersistenceUpdate,
  ) => Promise<void>;
  readonly persistSubscription: (
    update: SubscriptionPersistenceUpdate,
  ) => Promise<void>;
  readonly executeDeliveryNode: (
    input: IssueDeliveryInput,
    context: DeliveryExecutionContext,
  ) => Promise<DeliveryNodeResult>;
  readonly resolveApproval: (
    request: ApprovalResolutionRequest,
  ) => Promise<boolean>;
}

export interface RegisteredIssueDeliveryWorkflows {
  readonly issueDelivery: (
    input: IssueDeliveryInput,
  ) => Promise<DeliveryNodeResult>;
  readonly deliveryNode: (
    input: IssueDeliveryInput,
  ) => Promise<DeliveryNodeResult>;
}

export function registerIssueDeliveryWorkflows(
  dependencies: IssueDeliveryDependencies,
): RegisteredIssueDeliveryWorkflows {
  const persistWorkflowState = DBOS.registerStep(
    dependencies.persistWorkflowState,
    {
      name: "acp.persist_workflow_state.v1",
      retriesAllowed: true,
      intervalSeconds: 1,
      maxAttempts: 3,
      backoffRate: 2,
      timeoutMS: 10_000,
    },
  );
  const persistMissionState = DBOS.registerStep(
    dependencies.persistMissionState,
    {
      name: "acp.persist_mission_transition.v1",
      retriesAllowed: true,
      intervalSeconds: 1,
      maxAttempts: 3,
      backoffRate: 2,
      timeoutMS: 10_000,
    },
  );
  const persistSubscription = DBOS.registerStep(
    dependencies.persistSubscription,
    {
      name: "acp.persist_subscription.v1",
      retriesAllowed: true,
      intervalSeconds: 1,
      maxAttempts: 3,
      backoffRate: 2,
      timeoutMS: 10_000,
    },
  );
  const executeDeliveryNodeStep = DBOS.registerStep(
    async (input: IssueDeliveryInput) => {
      const abortSignal = DBOS.stepStatus?.timeoutSignal;
      if (abortSignal === undefined) {
        throw new Error("DBOS did not provide the required step timeout signal");
      }
      return dependencies.executeDeliveryNode(input, { abortSignal });
    },
    {
      name: "acp.execute_delivery_node_step.v1",
      retriesAllowed: false,
      timeoutMS: 30 * 60 * 1_000,
    },
  );
  const resolveApproval = DBOS.registerStep(dependencies.resolveApproval, {
    name: "acp.resolve_persisted_approval.v1",
    retriesAllowed: true,
    intervalSeconds: 1,
    maxAttempts: 3,
    backoffRate: 2,
    timeoutMS: 10_000,
  });

  const deliveryNode = DBOS.registerWorkflow(
    async (input: IssueDeliveryInput) => executeDeliveryNodeStep(input),
    {
      name: deliveryNodeWorkflowName,
      maxRecoveryAttempts: 3,
      inputSchema: issueDeliveryInputSchema,
    },
  );

  const issueDelivery = DBOS.registerWorkflow(
    async (input: IssueDeliveryInput): Promise<DeliveryNodeResult> => {
      assertWorkflowIdentity(input, DBOS.workflowID);
      try {
        await persistWorkflowState({ input, state: "running" });
        await persistMissionState(
          await missionPersistenceUpdate(
            input,
            "executing",
            `${input.dbosWorkflowId}:mission:executing`,
          ),
        );
        await DBOS.setEvent("mission.executing", { missionId: input.missionId });

        const child = await DBOS.startWorkflow(deliveryNode, {
          workflowID: `${input.dbosWorkflowId}:delivery`,
          queueName: heavyWorkerQueueName,
          duplicationPolicy: "return-existing",
          enqueueOptions: {
            deduplicationID: `${input.workflowExecutionId}:delivery`,
          },
          workflowAttributes: {
            missionId: input.missionId,
            workflowVersion: input.workflowVersion,
          },
        })(input);
        let result = await child.getResult();

        if (result.status === "awaiting_approval") {
          await persistMissionState(
            await missionPersistenceUpdate(
              input,
              "awaiting_approval",
              `${input.dbosWorkflowId}:mission:awaiting-approval`,
            ),
          );
          await persistSubscription({ input, topic: "approval", state: "waiting" });
          const notification = await DBOS.recv<unknown>("approval", {
            deadlineEpochMS: timestampMilliseconds(
              input.approvalExpiresAt,
              "issueDeliveryInput.approvalExpiresAt",
            ),
          });
          if (notification === null) {
            await persistSubscription({ input, topic: "approval", state: "expired" });
            result = {
              status: "needs_input",
              conclusion: "Approval wait expired.",
              output: {},
            };
          } else {
            let approval: ApprovalSignal | undefined;
            let effectId: StableId<"effect"> | undefined;
            try {
              approval = parseApprovalSignal(notification);
              effectId = parseAwaitingEffectId(result);
            } catch {
              // The message is only a wakeup. Invalid content is never authority.
            }
            const authorized =
              approval !== undefined && effectId !== undefined
                ? await resolveApproval({
                    input,
                    effectId,
                    approvalId: approval.approvalId,
                  })
                : false;
            await persistSubscription({ input, topic: "approval", state: "received" });
            if (!authorized || approval === undefined || effectId === undefined) {
              result = {
                status: "needs_input",
                conclusion:
                  "The approval notification did not resolve to current persisted authorization.",
                output: {},
              };
            } else {
              await persistMissionState(
                await missionPersistenceUpdate(
                  input,
                  "executing",
                  `${input.dbosWorkflowId}:mission:approval-received`,
                ),
              );
              result = {
                status: "effect_authorized",
                conclusion:
                  "Persisted approval was revalidated; the proposal is ready for the deterministic effect service.",
                output: { approvalId: approval.approvalId, effectId },
              };
            }
          }
        }

        if (result.status !== "effect_authorized") {
          const terminalState: MissionState =
            result.status === "succeeded"
              ? "verifying"
              : result.status === "failed"
                ? "failed"
                : "needs_input";
          await persistMissionState(
            await missionPersistenceUpdate(
              input,
              terminalState,
              `${input.dbosWorkflowId}:mission:${terminalState}`,
            ),
          );
        }
        await DBOS.setEvent("mission.workflow-finished", {
          missionId: input.missionId,
          resultStatus: result.status,
        });
        await persistWorkflowState({ input, state: "success" });
        return result;
      } catch (error) {
        if (isIssueDeliveryCancellationError(error)) throw error;
        try {
          await persistMissionState(
            await missionPersistenceUpdate(
              input,
              "failed",
              `${input.dbosWorkflowId}:mission:failed`,
            ),
          );
        } finally {
          await persistWorkflowState({ input, state: "error" });
        }
        throw error;
      }
    },
    {
      name: issueDeliveryWorkflowName,
      maxRecoveryAttempts: 10,
      inputSchema: issueDeliveryInputSchema,
    },
  );

  return { issueDelivery, deliveryNode };
}

export async function startIssueDeliveryWorkflow(
  submitter: IssueDeliverySubmitter,
  input: IssueDeliveryInput,
): Promise<WorkflowHandle<DeliveryNodeResult>> {
  return submitter.submit(input);
}

export async function cancelIssueDeliveryWorkflow(
  controller: IssueDeliveryController,
  cancellation: IssueDeliveryCancellation,
): Promise<void> {
  return controller.cancel(cancellation);
}

export async function reconcileIssueDeliveryCancellation(
  controller: IssueDeliveryController,
  cancellation: IssueDeliveryCancellation,
): Promise<void> {
  return controller.reconcileCancellation(cancellation);
}

export async function reconcileIssueDeliveryStatus(
  controller: IssueDeliveryController,
  input: IssueDeliveryInput,
): Promise<void> {
  return controller.reconcileStatus(input);
}

export interface IssueDeliverySubmitter {
  submit(input: IssueDeliveryInput): Promise<WorkflowHandle<DeliveryNodeResult>>;
}

export interface IssueDeliveryCancellation {
  readonly input: IssueDeliveryInput;
  readonly eventId: StableId<"event">;
  readonly reason: string;
  readonly requestedBy: string;
  readonly occurredAt: string;
}

export interface IssueDeliveryController extends IssueDeliverySubmitter {
  cancel(cancellation: IssueDeliveryCancellation): Promise<void>;
  reconcileCancellation(cancellation: IssueDeliveryCancellation): Promise<void>;
  reconcileStatus(input: IssueDeliveryInput): Promise<void>;
}

export function parseIssueDeliveryInput(value: unknown): IssueDeliveryInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("issue delivery input must be an object");
  }
  const input = value as Record<string, unknown>;
  const dbosWorkflowId = nonEmptyString(input.dbosWorkflowId, "dbosWorkflowId");
  const workflowVersion = nonEmptyString(input.workflowVersion, "workflowVersion");
  const graphRevision = nonEmptyString(input.graphRevision, "graphRevision");
  const approvalExpiresAt = new Date(
    timestampMilliseconds(input.approvalExpiresAt, "approvalExpiresAt"),
  ).toISOString();

  return {
    missionId: parseStableId(input.missionId, "mission"),
    approvalNodeId: parseStableId(input.approvalNodeId, "node"),
    approvalSubscriptionId: parseStableId(
      input.approvalSubscriptionId,
      "subscription",
    ),
    workflowExecutionId: parseStableId(
      input.workflowExecutionId,
      "workflowExecution",
    ),
    dbosWorkflowId,
    workflowVersion,
    graphRevision,
    provenanceId: parseStableId(input.provenanceId, "provenance"),
    approvalExpiresAt,
  };
}

export function approvalSubscriptionSemanticDigest(
  input: IssueDeliveryInput,
  topic: "approval" = "approval",
): string {
  const semantics = JSON.stringify({
    version: "1",
    subscriptionId: input.approvalSubscriptionId,
    missionId: input.missionId,
    nodeId: input.approvalNodeId,
    dbosWorkflowId: input.dbosWorkflowId,
    topic,
    expiresAt: input.approvalExpiresAt,
    provenanceId: input.provenanceId,
  });
  return `sha256:${createHash("sha256").update(semantics).digest("hex")}`;
}

export function parseIssueDeliveryCancellation(
  value: unknown,
): IssueDeliveryCancellation {
  const cancellation = expectRecord(value, "issueDeliveryCancellation");
  return {
    input: parseIssueDeliveryInput(cancellation.input),
    eventId: parseStableId(cancellation.eventId, "event"),
    reason: nonEmptyString(cancellation.reason, "reason"),
    requestedBy: nonEmptyString(cancellation.requestedBy, "requestedBy"),
    occurredAt: new Date(
      timestampMilliseconds(cancellation.occurredAt, "occurredAt"),
    ).toISOString(),
  };
}

export function parseApprovalSignal(value: unknown): ApprovalSignal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("approval notification must be an object");
  }
  return {
    approvalId: parseStableId(
      (value as Record<string, unknown>).approvalId,
      "approval",
    ),
  };
}

function parseAwaitingEffectId(result: DeliveryNodeResult): StableId<"effect"> {
  if (typeof result.output !== "object" || result.output === null || Array.isArray(result.output)) {
    throw new TypeError("awaiting-approval result must identify one effect");
  }
  return parseStableId(
    (result.output as Readonly<Record<string, JsonValue>>).effectId,
    "effect",
  );
}

function assertWorkflowIdentity(
  input: IssueDeliveryInput,
  currentWorkflowId: string | undefined,
): void {
  if (currentWorkflowId !== input.dbosWorkflowId) {
    throw new Error("DBOS workflow identity does not match persisted ACP identity");
  }
}

export function isIssueDeliveryCancellationError(error: unknown): boolean {
  return (
    error instanceof DBOSErrors.DBOSWorkflowCancelledError ||
    error instanceof DBOSErrors.DBOSAwaitedWorkflowCancelledError
  );
}

async function missionPersistenceUpdate(
  input: IssueDeliveryInput,
  state: MissionState,
  idempotencyKey: string,
): Promise<MissionPersistenceUpdate> {
  const eventId = `evt_${await DBOS.randomUUID()}` as StableId<"event">;
  const occurredAt = new Date(await DBOS.now()).toISOString();
  return { input, state, idempotencyKey, eventId, occurredAt };
}

const issueDeliveryInputSchema = {
  parse(value: unknown): unknown {
    if (!Array.isArray(value) || value.length !== 1) {
      throw new TypeError("issue delivery workflow expects exactly one input");
    }
    return [parseIssueDeliveryInput(value[0])];
  },
};

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}
