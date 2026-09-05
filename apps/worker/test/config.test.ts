import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createStableId } from "@acp/domain";
import { Error as DBOSErrors } from "@dbos-inc/dbos-sdk";

import { parseWorkerConfig } from "../src/config.ts";
import {
  approvalSubscriptionSemanticDigest,
  isIssueDeliveryCancellationError,
  parseApprovalSignal,
  parseIssueDeliveryCancellation,
  parseIssueDeliveryInput,
} from "../src/issue-delivery.ts";

describe("DBOS worker configuration", () => {
  it("defaults schema mutation off and requires immutable runtime identity", () => {
    const config = parseWorkerConfig({
      ACP_DBOS_SYSTEM_DATABASE_URL: "postgresql://dbos.invalid/acp",
      ACP_APPLICATION_VERSION: "sha256:artifact",
      ACP_EXECUTOR_ID: "acp-worker-1",
    });

    assert.equal(config.runMigrations, false);
    assert.equal(config.applicationVersion, "sha256:artifact");
  });

  it("rejects non-PostgreSQL configuration and invalid migration flags", () => {
    assert.throws(
      () =>
        parseWorkerConfig({
          ACP_DBOS_SYSTEM_DATABASE_URL: "https://example.com",
          ACP_APPLICATION_VERSION: "v1",
          ACP_EXECUTOR_ID: "worker-1",
        }),
      /PostgreSQL URL/,
    );
    assert.throws(
      () =>
        parseWorkerConfig({
          ACP_DBOS_SYSTEM_DATABASE_URL: "postgresql://dbos.invalid/acp",
          ACP_APPLICATION_VERSION: "v1",
          ACP_EXECUTOR_ID: "worker-1",
          ACP_DBOS_RUN_MIGRATIONS: "yes",
        }),
      /true or false/,
    );
  });

  it("canonicalizes the durable workflow identity and absolute approval deadline", () => {
    const input = parseIssueDeliveryInput({
      missionId: createStableId("mission"),
      approvalNodeId: createStableId("node"),
      approvalSubscriptionId: createStableId("subscription"),
      workflowExecutionId: createStableId("workflowExecution"),
      dbosWorkflowId: "acp:mission:one",
      workflowVersion: "1.0.0",
      graphRevision: "sha256:graph",
      provenanceId: createStableId("provenance"),
      approvalExpiresAt: "2026-09-05T14:00:00+02:00",
    });
    assert.equal(input.approvalExpiresAt, "2026-09-05T12:00:00.000Z");

    assert.throws(
      () => parseIssueDeliveryInput({ ...input, approvalExpiresAt: "2026-09-05" }),
      /ISO 8601 timestamp with a timezone/,
    );
  });

  it("binds durable subscription replay to its full waiting semantics", () => {
    const input = parseIssueDeliveryInput({
      missionId: createStableId("mission"),
      approvalNodeId: createStableId("node"),
      approvalSubscriptionId: createStableId("subscription"),
      workflowExecutionId: createStableId("workflowExecution"),
      dbosWorkflowId: "acp:mission:semantic-wait",
      workflowVersion: "1.0.0",
      graphRevision: "sha256:graph",
      provenanceId: createStableId("provenance"),
      approvalExpiresAt: "2026-09-05T12:00:00Z",
    });

    const first = approvalSubscriptionSemanticDigest(input);
    assert.equal(first, approvalSubscriptionSemanticDigest(input));
    assert.notEqual(
      first,
      approvalSubscriptionSemanticDigest({
        ...input,
        approvalExpiresAt: "2026-09-05T12:00:01.000Z",
      }),
    );
  });

  it("validates and canonicalizes cancellation projection input", () => {
    const cancellation = parseIssueDeliveryCancellation({
      input: {
        missionId: createStableId("mission"),
        approvalNodeId: createStableId("node"),
        approvalSubscriptionId: createStableId("subscription"),
        workflowExecutionId: createStableId("workflowExecution"),
        dbosWorkflowId: "acp:mission:cancel",
        workflowVersion: "1.0.0",
        graphRevision: "sha256:graph",
        provenanceId: createStableId("provenance"),
        approvalExpiresAt: "2026-09-05T12:00:00Z",
      },
      eventId: createStableId("event"),
      reason: "Operator cancelled delivery.",
      requestedBy: "operator:david",
      occurredAt: "2026-09-04T14:00:00+02:00",
    });

    assert.equal(cancellation.occurredAt, "2026-09-04T12:00:00.000Z");
  });

  it("recognizes the SDK cancellation classes without relying on error names", () => {
    assert.equal(
      isIssueDeliveryCancellationError(
        new DBOSErrors.DBOSWorkflowCancelledError("workflow:test"),
      ),
      true,
    );
    assert.equal(
      isIssueDeliveryCancellationError(
        new DBOSErrors.DBOSAwaitedWorkflowCancelledError("workflow:test"),
      ),
      true,
    );
    assert.equal(isIssueDeliveryCancellationError(new Error("cancelled")), false);
    assert.equal(
      isIssueDeliveryCancellationError(
        new DBOSErrors.DBOSWorkflowConflictError("workflow:test"),
      ),
      false,
    );
  });

  it("treats approval messages only as exact persisted-envelope notifications", () => {
    const approvalId = createStableId("approval");
    assert.deepEqual(parseApprovalSignal({ approvalId }), { approvalId });
    assert.throws(
      () => parseApprovalSignal({ disposition: "approved" }),
      /approval/,
    );
  });
});
