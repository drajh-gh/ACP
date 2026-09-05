import { win32 } from "node:path";
import { parseStableId, type StableId } from "@acp/domain";
import type { WindowsSupervisionScope } from "./worker-runtime-store.ts";

export interface WindowsLaunchFenceDescriptor {
  readonly directory: string;
  readonly directoryIdentity: string;
  readonly scope: WindowsSupervisionScope;
}

/** Selected once before admission. Never regenerate after an ambiguous commit. */
export interface WorkerLaunchIntent {
  readonly workerProcessId: StableId<"workerProcess">;
  readonly fence: WindowsLaunchFenceDescriptor;
}

export function parseWindowsLaunchFence(value: unknown): WindowsLaunchFenceDescriptor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("missing launch fence");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 3 || typeof input.directory !== "string" || input.directory.length > 4096
      || !/^[a-z]:\\/iu.test(input.directory) || /[\u0000-\u001f]/u.test(input.directory)
      || win32.normalize(input.directory).replace(/\\$/u, "") === win32.parse(input.directory).root.replace(/\\$/u, "")
      || typeof input.directoryIdentity !== "string" || !/^win32-dir:[0-9a-f]{8}:[0-9a-f]{16}$/u.test(input.directoryIdentity)) {
    throw new Error("invalid launch fence directory identity");
  }
  if (typeof input.scope !== "object" || input.scope === null || Array.isArray(input.scope)) throw new Error("missing OS scope");
  const scope = input.scope as Record<string, unknown>;
  if (Object.keys(scope).length !== 3 || typeof scope.machineFingerprint !== "string" || !/^[0-9a-f]{64}$/u.test(scope.machineFingerprint)
      || typeof scope.bootedAt !== "string" || !Number.isFinite(Date.parse(scope.bootedAt))
      || !Number.isInteger(scope.sessionId) || (scope.sessionId as number) < 0 || (scope.sessionId as number) > 2147483647) {
    throw new Error("invalid OS scope");
  }
  return { directory: input.directory, directoryIdentity: input.directoryIdentity,
    scope: { machineFingerprint: scope.machineFingerprint, bootedAt: new Date(scope.bootedAt).toISOString(), sessionId: scope.sessionId as number } };
}

export function parseWorkerLaunchIntent(value: unknown): WorkerLaunchIntent {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 2) {
    throw new Error("invalid worker launch intent");
  }
  const input = value as Record<string, unknown>;
  return { workerProcessId: parseStableId(input.workerProcessId, "workerProcess"), fence: parseWindowsLaunchFence(input.fence) };
}
