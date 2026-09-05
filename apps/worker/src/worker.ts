import { DBOS } from "@dbos-inc/dbos-sdk";

import type { WorkerConfig } from "./config.ts";
import {
  heavyWorkerQueueName,
  missionControlQueueName,
  registerIssueDeliveryWorkflows,
  type IssueDeliveryDependencies,
  type RegisteredIssueDeliveryWorkflows,
} from "./issue-delivery.ts";
import type { WorkflowReconciliationResult } from "./postgres-dependencies.ts";
import { registerHostDispatchWorkflow, type HostDispatchRuntime } from "./host-dispatch.ts";

export interface RunningWorker {
  readonly workflows: RegisteredIssueDeliveryWorkflows;
  shutdown(): Promise<void>;
}

export interface WorkerMaintenance {
  reconcileWorkflows(): Promise<WorkflowReconciliationResult>;
}

const maintenanceIntervalMilliseconds = 30_000;

export async function launchWorker(
  config: WorkerConfig,
  dependencies: IssueDeliveryDependencies,
  maintenance: WorkerMaintenance,
  specialists?: HostDispatchRuntime,
): Promise<RunningWorker> {
  if (specialists && specialists.applicationVersion !== config.applicationVersion) throw new Error("specialist runtime application version mismatch");
  DBOS.setConfig({
    name: "acp-worker",
    systemDatabaseUrl: config.systemDatabaseUrl,
    systemDatabaseSchemaName: "dbos",
    applicationVersion: config.applicationVersion,
    executorID: config.executorId,
    runMigrations: config.runMigrations,
    listenQueues: [missionControlQueueName, heavyWorkerQueueName, ...(specialists?.queueNames ?? [])],
    maxConcurrentQueueDispatches: 2,
    systemDatabasePollingConcurrency: 2,
  });
  const workflows = registerIssueDeliveryWorkflows(dependencies);
  if (specialists) registerHostDispatchWorkflow(specialists);
  let maintenanceTimer: NodeJS.Timeout | undefined;
  let maintenanceInFlight: Promise<void> | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let heartbeatInFlight: Promise<void> | undefined;
  let stopping = false;

  const runHeartbeat = (): Promise<void> => {
    if (stopping || !specialists) return Promise.resolve();
    heartbeatInFlight ??= specialists.heartbeat().finally(() => { heartbeatInFlight = undefined; });
    return heartbeatInFlight;
  };

  const stopRuntime = async (): Promise<void> => {
    stopping = true;
    if (maintenanceTimer !== undefined) clearInterval(maintenanceTimer);
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    try {
      await specialists?.stop();
    } finally {
      await Promise.allSettled([maintenanceInFlight, heartbeatInFlight]);
      await DBOS.shutdown({ deregister: true });
    }
  };

  const runMaintenance = (): Promise<void> => {
    if (stopping) return Promise.resolve();
    if (maintenanceInFlight !== undefined) return maintenanceInFlight;
    maintenanceInFlight = (async () => {
      await specialists?.maintain();
      return maintenance.reconcileWorkflows();
    })()
      .then((result) => {
        for (const error of result.errors) DBOS.logger.error(error);
      })
      .finally(() => {
        maintenanceInFlight = undefined;
      });
    return maintenanceInFlight;
  };

  try {
    await DBOS.launch();
    await specialists?.start();
    await runHeartbeat();
    if (specialists) {
      heartbeatTimer = setInterval(() => { void runHeartbeat().catch((error: unknown) => DBOS.logger.error(error)); },
        specialists.heartbeatIntervalMilliseconds);
      heartbeatTimer.unref();
    }
    await runMaintenance();
    await DBOS.registerQueue(missionControlQueueName, {
      globalConcurrency: 100,
      workerConcurrency: 20,
    });
    await DBOS.registerQueue(heavyWorkerQueueName, {
      globalConcurrency: 2,
      workerConcurrency: 2,
    });
    maintenanceTimer = setInterval(() => {
      void runMaintenance().catch((error: unknown) => {
        DBOS.logger.error(error);
      });
    }, maintenanceIntervalMilliseconds);
    maintenanceTimer.unref();
  } catch (error) {
    try { await stopRuntime(); } catch (shutdownError) { DBOS.logger.error(shutdownError); }
    throw error;
  }

  return {
    workflows,
    async shutdown(): Promise<void> {
      await stopRuntime();
    },
  };
}
