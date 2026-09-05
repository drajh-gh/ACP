import { DBOS } from "@dbos-inc/dbos-sdk";
import { Pool } from "pg";

const databaseUrl = requiredEnvironment("ACP_DBOS_RECOVERY_DATABASE_URL");
const role = process.argv[2];
if (role !== "start" && role !== "recover") {
  throw new TypeError("recovery child role must be start or recover");
}

const applicationName = "acp-dbos-recovery-test";
const applicationVersion = "1.0.0-test";
const executorId = "acp-dbos-recovery-executor";
const workflowId = "acp-test-synthetic-mission-recovery";
const missionId = "mis_00000000-0000-4000-8000-000000000777";
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
pool.on("error", (error) => console.error(error));

DBOS.setConfig({
  name: applicationName,
  systemDatabaseUrl: databaseUrl,
  systemDatabaseSchemaName: "dbos",
  applicationVersion,
  executorID: executorId,
  runMigrations: role === "start",
  systemDatabasePollingConcurrency: 1,
  maxConcurrentQueueDispatches: 1,
});

const beforeCheckpoint = DBOS.registerStep(
  async (persistedMissionId: string): Promise<void> => {
    await recordInvocation(persistedMissionId, "before");
  },
  {
    name: "acp.test.recovery.before.v1",
    retriesAllowed: false,
    timeoutMS: 10_000,
  },
);

const afterCheckpoint = DBOS.registerStep(
  async (persistedMissionId: string): Promise<void> => {
    await recordInvocation(persistedMissionId, "after");
  },
  {
    name: "acp.test.recovery.after.v1",
    retriesAllowed: false,
    timeoutMS: 10_000,
  },
);

const recoverSyntheticMission = DBOS.registerWorkflow(
  async (persistedMissionId: string) => {
    await beforeCheckpoint(persistedMissionId);
    await DBOS.setEvent("checkpoint", { missionId: persistedMissionId });
    const resume = await DBOS.recv<{ readonly resume: boolean }>("resume", {
      timeoutSeconds: 120,
      pollingIntervalMs: 50,
    });
    if (resume?.resume !== true) {
      throw new Error("synthetic mission recovery did not receive resume signal");
    }
    await afterCheckpoint(persistedMissionId);
    return { missionId: persistedMissionId, status: "recovered" as const };
  },
  {
    name: "acp.test.synthetic_mission_recovery.v1",
    maxRecoveryAttempts: 3,
  },
);

let shuttingDown = false;
async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await DBOS.shutdown({ workflowCompletionTimeoutMS: 1_000 });
    await pool.end();
  } finally {
    process.exit(exitCode);
  }
}

process.on("SIGTERM", () => void shutdown(0));
process.on("SIGINT", () => void shutdown(0));

try {
  await DBOS.launch();
  if (role === "start") {
    const handle = await DBOS.startWorkflow(recoverSyntheticMission, {
      workflowID: workflowId,
    })(missionId);
    console.log(`WORKFLOW_STARTED ${process.pid}`);
    const result = await handle.getResult();
    console.log(`WORKFLOW_RESULT ${JSON.stringify(result)}`);
    await shutdown(0);
  } else {
    console.log(`RECOVERY_LAUNCHED ${process.pid}`);
    await new Promise<void>(() => undefined);
  }
} catch (error) {
  console.error(error);
  await shutdown(1);
}

async function recordInvocation(
  persistedMissionId: string,
  phase: "before" | "after",
): Promise<void> {
  await pool.query(
    `INSERT INTO public.acp_recovery_probe (
       workflow_id, mission_id, phase, invocation_count
     ) VALUES ($1, $2, $3, 1)
     ON CONFLICT (workflow_id, phase) DO UPDATE
     SET invocation_count = public.acp_recovery_probe.invocation_count + 1`,
    [workflowId, persistedMissionId, phase],
  );
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new TypeError(`${name} is required`);
  }
  return value;
}
