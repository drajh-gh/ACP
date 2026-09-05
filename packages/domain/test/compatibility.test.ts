import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assessRuntimeCompatibility,
  parseRuntimeCompatibilityRequirements,
  parseRuntimeHello,
} from "../src/compatibility.ts";
import { createStableId } from "../src/ids.ts";

const workflowId = createStableId("workflow");

function versionSet() {
  return {
    protocolVersion: "1.0.0",
    apiVersion: "1.0.0",
    workerImplementationVersion: "1.0.0",
    databaseSchemaVersion: "0002",
    workflowVersions: [{ workflowId, version: "1.0.0" }],
  };
}

describe("runtime compatibility", () => {
  it("accepts an exact runtime and required workflow version", () => {
    assert.deepEqual(
      assessRuntimeCompatibility(versionSet(), versionSet()),
      { compatible: true, reasons: [] },
    );
  });

  for (const [field, code] of [
    ["protocolVersion", "protocol_version_mismatch"],
    ["apiVersion", "api_version_mismatch"],
    ["workerImplementationVersion", "worker_implementation_version_mismatch"],
    ["databaseSchemaVersion", "database_schema_version_mismatch"],
  ] as const) {
    it(`rejects an exact-version mismatch in ${field}`, () => {
      const hello = { ...versionSet(), [field]: "different" };

      assert.deepEqual(assessRuntimeCompatibility(versionSet(), hello), {
        compatible: false,
        reasons: [{ code, expected: versionSet()[field], observed: "different" }],
      });
    });
  }

  it("distinguishes a missing workflow from a version mismatch", () => {
    const missing = assessRuntimeCompatibility(versionSet(), {
      ...versionSet(),
      workflowVersions: [{
        workflowId: createStableId("workflow"),
        version: "1.0.0",
      }],
    });
    const mismatched = assessRuntimeCompatibility(versionSet(), {
      ...versionSet(),
      workflowVersions: [{ workflowId, version: "2.0.0" }],
    });

    assert.deepEqual(missing, {
      compatible: false,
      reasons: [{
        code: "workflow_version_missing",
        expected: "1.0.0",
        workflowId,
      }],
    });
    assert.deepEqual(mismatched, {
      compatible: false,
      reasons: [{
        code: "workflow_version_mismatch",
        expected: "1.0.0",
        observed: "2.0.0",
        workflowId,
      }],
    });
  });

  it("allows a runtime to advertise additional workflow versions", () => {
    const additionalWorkflowId = createStableId("workflow");
    const assessment = assessRuntimeCompatibility(versionSet(), {
      ...versionSet(),
      workflowVersions: [
        ...versionSet().workflowVersions,
        { workflowId: additionalWorkflowId, version: "3.0.0" },
      ],
    });

    assert.deepEqual(assessment, { compatible: true, reasons: [] });
  });

  it("fails closed on missing and unknown top-level fields", () => {
    const { apiVersion: _apiVersion, ...missingApiVersion } = versionSet();
    const unknownHello = { ...versionSet(), dbosApplicationVersion: "old-run" };

    assert.deepEqual(assessRuntimeCompatibility(versionSet(), missingApiVersion), {
      compatible: false,
      reasons: [{ code: "hello_invalid", path: "runtimeHello.apiVersion" }],
    });
    assert.deepEqual(assessRuntimeCompatibility(versionSet(), unknownHello), {
      compatible: false,
      reasons: [{
        code: "hello_invalid",
        path: "runtimeHello.dbosApplicationVersion",
      }],
    });
  });

  it("fails closed on invalid requirements", () => {
    assert.deepEqual(assessRuntimeCompatibility({}, versionSet()), {
      compatible: false,
      reasons: [{
        code: "requirements_invalid",
        path: "runtimeCompatibilityRequirements.workflowVersions",
      }],
    });
  });

  it("strictly parses workflow entries and rejects duplicates", () => {
    assert.throws(
      () => parseRuntimeHello({
        ...versionSet(),
        workflowVersions: [{ workflowId, version: "1.0.0", unknown: true }],
      }),
      /unknown.*recognized field/,
    );
    assert.throws(
      () => parseRuntimeCompatibilityRequirements({
        ...versionSet(),
        workflowVersions: [
          { workflowId, version: "1.0.0" },
          { workflowId, version: "2.0.0" },
        ],
      }),
      /duplicate workflow identifiers/,
    );
  });
});
