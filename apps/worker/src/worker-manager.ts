import {
  assertWorkerResultContext,
  assessCapabilityGrant,
  createWorkerFailureResult,
  createStableId,
  parseContextPacket,
  parseWorkerResult,
  type CapabilityGrant,
  type CapabilityRequest,
  type ContextPacket,
  type StableId,
  type WorkerResult,
} from "@acp/domain";
import { parseWindowsLaunchFence, parseWorkerLaunchIntent, type WorkerRunPersistence, type WorkerLaunchIntent,
  type WindowsLaunchFenceDescriptor } from "@acp/storage";
import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify, isDeepStrictEqual } from "node:util";

const execFileAsync = promisify(execFile);

export type WorkerIsolationProfile = "read_only" | "delivery" | "acceptance";

export interface WorkerIsolationDescriptor {
  readonly profile: WorkerIsolationProfile;
  readonly workspace: string;
  readonly filesystem: "read_only" | "isolated_worktree";
  readonly networkDestinations: readonly string[];
  readonly credentials: "none";
}

export interface WorkerToolManifest {
  readonly operations: readonly string[];
  readonly resources: readonly string[];
  readonly effectExecutorAccess: false;
}

export interface WorkerTransportRequest {
  readonly execution: {
    readonly startedAt: string;
    readonly timeoutAt: string;
    readonly hostIdentifier: string;
    readonly provenanceId: StableId<"provenance">;
    readonly transitionProvenanceId: StableId<"provenance">;
    readonly launchIntent?: WorkerLaunchIntent;
  };
  readonly runId: StableId<"run">;
  readonly attemptNumber: number;
  readonly packet: ContextPacket;
  readonly toolManifest: WorkerToolManifest;
  readonly isolation: WorkerIsolationDescriptor;
  readonly signal: AbortSignal;
}

export interface WorkerTransport {
  /** Trusted supervisor configuration, never a dispatch/model-selected path. */
  readonly launchFence?: WindowsLaunchFenceDescriptor;
  run(request: WorkerTransportRequest): Promise<unknown>;
}

export interface WorkerDispatch {
  readonly dispatchGeneration?: number;
  readonly runId: StableId<"run">;
  readonly contextPacketId: StableId<"contextPacket">;
  readonly attemptNumber: number;
  readonly operation: string;
  readonly resource: string;
  readonly mode: "read" | "write";
  readonly workspace: string;
  readonly networkDestination?: string;
  readonly provenanceId: StableId<"provenance">;
  readonly transitionProvenanceId: StableId<"provenance">;
  readonly signal?: AbortSignal;
}

export interface WorkerManagerOptions {
  readonly localHostIdentifier: string;
  readonly now?: () => Date;
  readonly verifyDeliveryWorkspace?: (workspace: string) => Promise<boolean>;
  readonly readDeliveryRevision?: (workspace: string) => Promise<string>;
  readonly terminationConfirmationMs?: number;
}

export class WorkerTerminationUnconfirmedError extends Error {
  constructor() {
    super("worker termination could not be confirmed within the bounded grace period");
  }
}

export class WorkerManager {
  private readonly persistence: WorkerRunPersistence;
  private readonly transport: WorkerTransport;
  private readonly now: () => Date;
  private readonly localHostIdentifier: string;
  private readonly verifyDeliveryWorkspace: (
    workspace: string,
  ) => Promise<boolean>;
  private readonly readDeliveryRevision: (workspace: string) => Promise<string>;
  private readonly terminationConfirmationMs: number;

  constructor(
    persistence: WorkerRunPersistence,
    transport: WorkerTransport,
    options: WorkerManagerOptions,
  ) {
    if (options.localHostIdentifier.trim().length === 0) {
      throw new TypeError("worker manager local host identifier must not be empty");
    }
    const terminationConfirmationMs = options.terminationConfirmationMs ?? 5_000;
    if (
      !Number.isSafeInteger(terminationConfirmationMs) ||
      terminationConfirmationMs < 1 ||
      terminationConfirmationMs > 60_000
    ) {
      throw new TypeError(
        "termination confirmation must be between 1 and 60000 ms",
      );
    }
    this.persistence = persistence;
    this.transport = transport;
    this.now = options.now ?? (() => new Date());
    this.localHostIdentifier = options.localHostIdentifier;
    this.verifyDeliveryWorkspace =
      options.verifyDeliveryWorkspace ?? isIsolatedGitWorktree;
    this.readDeliveryRevision = options.readDeliveryRevision ?? readGitHead;
    this.terminationConfirmationMs = terminationConfirmationMs;
  }

  async dispatch(dispatch: WorkerDispatch): Promise<WorkerResult> {
    if (signalAborted(dispatch.signal)) {
      throw new Error("worker dispatch was cancelled before admission");
    }
    const packetValue = await this.persistence.loadContextPacket(
      dispatch.contextPacketId,
    );
    if (packetValue === undefined) throw new Error("context packet does not exist");
    const packet = parseContextPacket(packetValue);
    const grant = await this.persistence.loadCapabilityGrant(
      packet.capabilityGrantId,
    );
    if (grant === undefined) throw new Error("capability grant does not exist");

    const startedAt = this.now();
    const request = capabilityRequest(
      dispatch,
      packet,
      grant.resourceClass,
      startedAt.toISOString(),
    );
    const assessment = assessCapabilityGrant(grant, request);
    if (!assessment.allowed) {
      throw new Error(
        `worker capability denied: ${assessment.reasons.join(", ")}`,
      );
    }
    const isolation = isolationDescriptor(
      packet,
      grant.networkDestinations,
      dispatch.workspace,
    );
    validateIsolation(dispatch, packet, isolation);
    if (
      isolation.profile === "delivery" &&
      !(await this.verifyDeliveryWorkspace(isolation.workspace))
    ) {
      throw new Error(
        "delivery worker requires a verified linked Git worktree",
      );
    }

    const timeoutAt = new Date(
      startedAt.getTime() + packet.limits.wallTimeMs,
    );
    if (timeoutAt.getTime() > Date.parse(grant.expiresAt)) {
      throw new Error("worker deadline exceeds the capability grant expiry");
    }
    const launchIntent = this.transport.launchFence === undefined ? undefined : {
      workerProcessId: createStableId("workerProcess"), fence: parseWindowsLaunchFence(this.transport.launchFence) };
    const started = await this.persistence.startRun({
      ...(launchIntent === undefined ? {} : { launchIntent }),
      ...(dispatch.dispatchGeneration === undefined ? {} : { dispatchGeneration: dispatch.dispatchGeneration }),
      runId: dispatch.runId,
      packet,
      attemptNumber: dispatch.attemptNumber,
      request,
      hostIdentifier: this.localHostIdentifier,
      resourceClass: grant.resourceClass,
      wallTimeMs: packet.limits.wallTimeMs,
      provenanceId: dispatch.provenanceId,
    });
    // Admission may have committed before a bad/lost acknowledgement. Never
    // invent another native identity or launch with unpersisted metadata.
    if (!isDeepStrictEqual(started.launchIntent, launchIntent)) throw new WorkerTerminationUnconfirmedError();
    const admittedIntent = started.launchIntent === undefined ? undefined : parseWorkerLaunchIntent(started.launchIntent);

    const controller = new AbortController();
    const externalAbort = () => controller.abort(dispatch.signal?.reason);
    dispatch.signal?.addEventListener("abort", externalAbort, { once: true });
    if (signalAborted(dispatch.signal)) externalAbort();
    const remainingWallTime = Date.parse(started.timeoutAt) - this.now().getTime();
    const timer = setTimeout(
      () => controller.abort(new Error("worker deadline elapsed")),
      Math.max(0, remainingWallTime),
    );
    if (remainingWallTime <= 0) {
      controller.abort(new Error("worker deadline elapsed before dispatch"));
    }
    const wallStart = Date.parse(started.startedAt);
    let result: WorkerResult;
    try {
      if (controller.signal.aborted) {
        if (admittedIntent !== undefined) throw new WorkerTerminationUnconfirmedError();
        const externallyTerminated = signalAborted(dispatch.signal);
        result = createWorkerFailureResult({
          runId: dispatch.runId,
          packet,
          attemptNumber: dispatch.attemptNumber,
          status: externallyTerminated ? "cancelled" : "failed",
          code: externallyTerminated ? "terminated" : "timeout",
          conclusion: externallyTerminated
            ? "The worker was terminated before execution began."
            : "The worker deadline elapsed before execution began.",
          wallMilliseconds: elapsedMilliseconds(wallStart, this.now()),
        });
        return await this.persistResult(result, dispatch);
      }
      let output: unknown;
      try {
        output = await raceWithAbortAfterSettlement(
          this.transport.run({
            execution: { startedAt: started.startedAt, timeoutAt: started.timeoutAt,
              ...(admittedIntent === undefined ? {} : { launchIntent: admittedIntent }),
              hostIdentifier: this.localHostIdentifier, provenanceId: dispatch.provenanceId,
              transitionProvenanceId: dispatch.transitionProvenanceId },
            runId: dispatch.runId,
            attemptNumber: dispatch.attemptNumber,
            packet,
            toolManifest: {
              operations: [dispatch.operation],
              resources: [dispatch.resource],
              effectExecutorAccess: false,
            },
            isolation,
            signal: controller.signal,
          }),
          controller.signal,
          this.terminationConfirmationMs,
        );
      } catch (error) {
        if (error instanceof WorkerTerminationUnconfirmedError) throw error;
        const externallyTerminated = signalAborted(dispatch.signal);
        const timedOut = controller.signal.aborted && !externallyTerminated;
        result = createWorkerFailureResult({
          runId: dispatch.runId,
          packet,
          attemptNumber: dispatch.attemptNumber,
          status: externallyTerminated ? "cancelled" : "failed",
          code: externallyTerminated
            ? "terminated"
            : timedOut
              ? "timeout"
              : "transport_failure",
          conclusion: externallyTerminated
            ? "The worker was terminated before returning a result."
            : timedOut
              ? "The worker exceeded its bounded execution deadline."
              : "The worker transport ended before returning a result.",
          wallMilliseconds: elapsedMilliseconds(wallStart, this.now()),
        });
        return await this.persistResult(result, dispatch);
      }

      try {
        result = parseWorkerResult(output);
        assertWorkerResultContext(
          result,
          packet,
          dispatch.runId,
          dispatch.attemptNumber,
        );
        if (
          packet.workerRole === "delivery" &&
          result.status === "succeeded" &&
          result.candidateRevision !==
            await this.readDeliveryRevision(isolation.workspace)
        ) {
          throw new TypeError(
            "delivery result revision does not match the isolated worktree HEAD",
          );
        }
        if (jsonByteLength(result) > packet.limits.maximumOutputBytes) {
          throw new TypeError("worker result exceeds the packet output limit");
        }
      } catch {
        result = createWorkerFailureResult({
          runId: dispatch.runId,
          packet,
          attemptNumber: dispatch.attemptNumber,
          status: "failed",
          code: "invalid_output",
          conclusion: "The worker returned output that violated its result contract.",
          wallMilliseconds: elapsedMilliseconds(wallStart, this.now()),
        });
      }
      return await this.persistResult(result, dispatch);
    } finally {
      // A bounded race can finish while the underlying transport is still
      // settling. Never let late launch/journal acknowledgements release it.
      controller.abort(new Error("worker manager dispatch ended"));
      clearTimeout(timer);
      dispatch.signal?.removeEventListener("abort", externalAbort);
    }
  }

  private async persistResult(
    result: WorkerResult,
    dispatch: WorkerDispatch,
  ): Promise<WorkerResult> {
    await this.persistence.completeRun({
      result,
      completedAt: this.now().toISOString(),
      transitionProvenanceId: dispatch.transitionProvenanceId,
    });
    return result;
  }
}

function capabilityRequest(
  dispatch: WorkerDispatch,
  packet: ContextPacket,
  resourceClass: CapabilityGrant["resourceClass"],
  at: string,
): CapabilityRequest {
  return {
    missionId: packet.missionId,
    nodeId: packet.nodeId,
    projectId: packet.projectId,
    role: packet.workerRole,
    resourceClass,
    operation: dispatch.operation,
    resource: dispatch.resource,
    mode: dispatch.mode,
    workspace: dispatch.workspace,
    networkAccess: dispatch.networkDestination === undefined ? "none" : "required",
    ...(dispatch.networkDestination === undefined
      ? {}
      : { networkDestination: dispatch.networkDestination }),
    at,
  };
}

function isolationDescriptor(
  packet: ContextPacket,
  networkDestinations: readonly string[],
  workspace: string,
): WorkerIsolationDescriptor {
  if (packet.workerRole === "delivery") {
    return {
      profile: "delivery",
      workspace,
      filesystem: "isolated_worktree",
      networkDestinations,
      credentials: "none",
    };
  }
  return {
    profile: packet.workerRole === "acceptance" ? "acceptance" : "read_only",
    workspace,
    filesystem: "read_only",
    networkDestinations,
    credentials: "none",
  };
}

function validateIsolation(
  dispatch: WorkerDispatch,
  packet: ContextPacket,
  descriptor: WorkerIsolationDescriptor,
): void {
  const expectedFilesystem = packet.workerRole === "delivery"
    ? "isolated_worktree"
    : "read_only";
  const expectedMode = packet.workerRole === "delivery" ? "write" : "read";
  if (
    descriptor.filesystem !== expectedFilesystem ||
    dispatch.mode !== expectedMode
  ) {
    throw new Error("worker request conflicts with its role isolation profile");
  }
}

async function raceWithAbortAfterSettlement<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  confirmationMs: number,
): Promise<T> {
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => {
      void confirmSettlement(promise, confirmationMs).then((settled) => {
        reject(
          settled
            ? signal.reason
            : new WorkerTerminationUnconfirmedError(),
        );
      });
    };
    signal.addEventListener("abort", abortListener, { once: true });
    if (signal.aborted) abortListener();
  });
  try {
    const value = await Promise.race([promise, aborted]);
    // A transport may resolve while handling abort. Settlement confirms it
    // ended, but its late success cannot override a cancellation/deadline.
    if (signal.aborted) throw signal.reason;
    return value;
  } finally {
    if (abortListener !== undefined) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

async function confirmSettlement(
  promise: Promise<unknown>,
  confirmationMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), confirmationMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function elapsedMilliseconds(startedAt: number, now: Date): number {
  return Math.max(0, Math.round(now.getTime() - startedAt));
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export async function isIsolatedGitWorktree(
  workspace: string,
): Promise<boolean> {
  try {
    const workspaceRoot = await realpath(path.resolve(workspace));
    const dotGitPath = path.join(workspaceRoot, ".git");
    if (!(await lstat(dotGitPath)).isFile()) return false;

    const pointer = parseGitdirPointer(await readBoundedText(dotGitPath));
    if (pointer === undefined) return false;
    const metadataDirectory = await realpath(
      path.resolve(workspaceRoot, pointer),
    );
    if (path.basename(path.dirname(metadataDirectory)) !== "worktrees") {
      return false;
    }

    const inspected = await execFileAsync(
      "git",
      [
        "-C",
        workspaceRoot,
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-dir",
        "--git-common-dir",
      ],
      {
        encoding: "utf8",
        maxBuffer: 4_096,
        timeout: 5_000,
        windowsHide: true,
      },
    );
    const [reportedWorkspace, reportedMetadata, reportedCommon, ...extra] =
      inspected.stdout.trim().split(/\r?\n/u);
    if (
      reportedWorkspace === undefined ||
      reportedMetadata === undefined ||
      reportedCommon === undefined ||
      extra.length > 0
    ) {
      return false;
    }
    const canonicalReportedWorkspace = await realpath(reportedWorkspace);
    const canonicalReportedMetadata = await realpath(reportedMetadata);
    const canonicalReportedCommon = await realpath(reportedCommon);
    if (
      pathKey(canonicalReportedWorkspace) !== pathKey(workspaceRoot) ||
      pathKey(canonicalReportedMetadata) !== pathKey(metadataDirectory) ||
      pathKey(canonicalReportedMetadata) === pathKey(canonicalReportedCommon)
    ) {
      return false;
    }

    const reversePointer = (await readBoundedText(
      path.join(metadataDirectory, "gitdir"),
    )).trim();
    if (reversePointer.length === 0) return false;
    const recordedDotGitPath = await realpath(
      path.resolve(metadataDirectory, reversePointer),
    );
    return pathKey(recordedDotGitPath) === pathKey(dotGitPath);
  } catch {
    return false;
  }
}

async function readGitHead(workspace: string): Promise<string> {
  const inspected = await execFileAsync(
    "git",
    ["-C", workspace, "rev-parse", "--verify", "HEAD"],
    {
      encoding: "utf8",
      maxBuffer: 1_024,
      timeout: 5_000,
      windowsHide: true,
    },
  );
  const revision = inspected.stdout.trim();
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(revision)) {
    throw new Error("isolated worktree HEAD is not a full Git object ID");
  }
  return revision;
}

async function readBoundedText(filePath: string): Promise<string> {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.size > 4_096) {
    throw new Error("Git worktree metadata file is invalid");
  }
  return readFile(filePath, "utf8");
}

function parseGitdirPointer(content: string): string | undefined {
  const match = /^gitdir:\s*(\S(?:.*\S)?)\s*$/iu.exec(content);
  return match?.[1];
}

function pathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
