import assert from "node:assert/strict";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { describe, it } from "node:test";

import { DBOSClient } from "@dbos-inc/dbos-sdk";
import { Pool, type QueryResultRow } from "pg";

const databaseUrl = process.env.ACP_DBOS_RECOVERY_DATABASE_URL;
const applicationName = "acp-dbos-recovery-test";
const applicationVersion = "1.0.0-test";
const executorId = "acp-dbos-recovery-executor";
const workflowId = "acp-test-synthetic-mission-recovery";
const missionId = "mis_00000000-0000-4000-8000-000000000777";
const childPath = fileURLToPath(
  new URL("./dbos-recovery-child.ts", import.meta.url),
);

interface WorkflowStatusRow extends QueryResultRow {
  readonly status: string;
  readonly executor_id: string;
  readonly application_version: string;
  readonly recovery_attempts: string;
  readonly completed_at: string | null;
}

interface ProbeRow extends QueryResultRow {
  readonly phase: "before" | "after";
  readonly invocation_count: number;
}

describe("live DBOS process recovery", () => {
  it(
    "recovers a killed synthetic mission without repeating completed steps",
    {
      skip: databaseUrl === undefined,
      timeout: 60_000,
    },
    async (testContext) => {
      assert.ok(databaseUrl);
      const pool = new Pool({ connectionString: databaseUrl, max: 3 });
      let client: DBOSClient | undefined;
      const children = new Set<ObservedChild>();
      testContext.after(async () => {
        for (const observed of children) await terminateChild(observed);
        if (client !== undefined) await client.destroy();
        await pool.end();
      });

      await pool.query(
        `CREATE TABLE public.acp_recovery_probe (
           workflow_id text NOT NULL,
           mission_id text NOT NULL,
           phase text NOT NULL CHECK (phase IN ('before', 'after')),
           invocation_count integer NOT NULL CHECK (invocation_count > 0),
           PRIMARY KEY (workflow_id, phase)
         )`,
      );

      const first = startChild("start", databaseUrl);
      children.add(first);
      const firstMarker = await first.waitFor("WORKFLOW_STARTED", 20_000);
      testContext.diagnostic(`killing first DBOS worker ${firstMarker.trim()}`);

      client = await DBOSClient.create({
        systemDatabaseUrl: databaseUrl,
        systemDatabaseSchemaName: "dbos",
        systemDatabasePoolSize: 2,
        systemDatabasePollingConcurrency: 1,
        applicationName,
      });
      const checkpoint = await client.getEvent<{ readonly missionId: string }>(
        workflowId,
        "checkpoint",
        { timeoutSeconds: 20, pollingIntervalMs: 50 },
      );
      assert.deepEqual(checkpoint, { missionId });

      assert.equal(first.process.kill("SIGKILL"), true);
      await waitForExit(first, 5_000);
      const pending = await readWorkflowStatus(pool);
      assert.equal(pending.status, "PENDING");
      assert.equal(pending.executor_id, executorId);
      assert.equal(pending.application_version, applicationVersion);
      assert.equal(pending.completed_at, null);

      const recovered = startChild("recover", databaseUrl);
      children.add(recovered);
      await recovered.waitFor("RECOVERY_LAUNCHED", 20_000);
      await client.send(
        workflowId,
        { resume: true },
        "resume",
        "acp-recovery-resume-v1",
      );

      const succeeded = await waitForWorkflowSuccess(client, 20_000);
      assert.equal(succeeded.status, "SUCCESS");
      assert.equal(succeeded.executorId, executorId);
      assert.equal(succeeded.applicationVersion, applicationVersion);
      assert.ok((succeeded.recoveryAttempts ?? 0) >= 1);
      assert.ok(succeeded.completedAt !== undefined);
      assert.deepEqual(
        await client.retrieveWorkflow(workflowId).getResult({
          pollingIntervalMs: 50,
        }),
        { missionId, status: "recovered" },
      );

      const durableStatus = await readWorkflowStatus(pool);
      assert.equal(durableStatus.status, "SUCCESS");
      assert.ok(Number(durableStatus.recovery_attempts) >= 1);
      assert.notEqual(durableStatus.completed_at, null);

      const probes = await pool.query<ProbeRow>(
        `SELECT phase, invocation_count
         FROM public.acp_recovery_probe
         WHERE workflow_id = $1
         ORDER BY phase`,
        [workflowId],
      );
      assert.deepEqual(probes.rows, [
        { phase: "after", invocation_count: 1 },
        { phase: "before", invocation_count: 1 },
      ]);
    },
  );
});

interface ObservedChild {
  readonly process: ChildProcessByStdio<null, Readable, Readable>;
  readonly waitFor: (marker: string, timeoutMilliseconds: number) => Promise<string>;
  readonly output: () => string;
}

function startChild(
  role: "start" | "recover",
  recoveryDatabaseUrl: string,
): ObservedChild {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", childPath, role],
    {
      env: {
        ...process.env,
        ACP_DBOS_RECOVERY_DATABASE_URL: recoveryDatabaseUrl,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (child.pid === undefined) {
    child.kill("SIGKILL");
    throw new Error(`DBOS ${role} child did not receive a process ID`);
  }
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output = appendCappedOutput(output, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output = appendCappedOutput(output, chunk);
  });

  return {
    process: child,
    output: () => output,
    waitFor: async (marker, timeoutMilliseconds) => {
      const deadline = Date.now() + timeoutMilliseconds;
      while (Date.now() < deadline) {
        const markerIndex = output.indexOf(marker);
        if (markerIndex >= 0) {
          const lineEnd = output.indexOf("\n", markerIndex);
          return output.slice(
            markerIndex,
            lineEnd < 0 ? output.length : lineEnd,
          );
        }
        if (child.exitCode !== null) {
          throw new Error(
            `DBOS ${role} child exited before ${marker}:\n${output}`,
          );
        }
        await delay(25);
      }
      throw new Error(`timed out waiting for ${marker}:\n${output}`);
    },
  };
}

function appendCappedOutput(current: string, chunk: Buffer): string {
  const maximumCharacters = 65_536;
  const combined = current + chunk.toString("utf8");
  return combined.length <= maximumCharacters
    ? combined
    : `[truncated]\n${combined.slice(-maximumCharacters)}`;
}

async function readWorkflowStatus(pool: Pool): Promise<WorkflowStatusRow> {
  const result = await pool.query<WorkflowStatusRow>(
    `SELECT status, executor_id, application_version, recovery_attempts,
            completed_at
     FROM dbos.workflow_status
     WHERE workflow_uuid = $1`,
    [workflowId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("DBOS workflow status row is missing");
  return row;
}

async function waitForWorkflowSuccess(
  client: DBOSClient,
  timeoutMilliseconds: number,
) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const status = await client.getWorkflow(workflowId);
    if (status?.status === "SUCCESS") return status;
    if (
      status?.status === "ERROR" ||
      status?.status === "MAX_RECOVERY_ATTEMPTS_EXCEEDED" ||
      status?.status === "CANCELLED"
    ) {
      throw new Error(`DBOS recovery ended in ${status.status}`);
    }
    await delay(50);
  }
  throw new Error("timed out waiting for recovered DBOS workflow");
}

async function terminateChild(observed: ObservedChild): Promise<void> {
  if (hasExited(observed)) return;
  observed.process.kill("SIGTERM");
  try {
    await waitForExit(observed, 3_000);
  } catch {
    observed.process.kill("SIGKILL");
    await waitForExit(observed, 3_000);
  }
}

async function waitForExit(
  observed: ObservedChild,
  timeoutMilliseconds: number,
): Promise<void> {
  if (hasExited(observed)) return;
  await Promise.race([
    once(observed.process, "exit").then(() => undefined),
    delay(timeoutMilliseconds).then(() => {
      throw new Error(
        `timed out waiting for DBOS child exit:\n${observed.output()}`,
      );
    }),
  ]);
}

function hasExited(observed: ObservedChild): boolean {
  return (
    observed.process.exitCode !== null || observed.process.signalCode !== null
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
