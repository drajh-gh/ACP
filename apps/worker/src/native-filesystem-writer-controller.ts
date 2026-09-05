import { isDeepStrictEqual } from "node:util";
import { parseStableId, type StableId } from "@acp/domain";
import { parseWindowsLaunchFence, type WindowsLaunchFenceDescriptor, type FilesystemWriterLease, type PostgresFilesystemWriterStore } from "@acp/storage";
import type { OwnedWorker, OwnedWorkerExit } from "./windows-worker-launcher.ts";

export interface NativeFilesystemLeaseIdentity {
  readonly leaseId: StableId<"lease">;
  readonly runId: StableId<"run">;
  readonly workerProcessId: StableId<"workerProcess">;
}
export interface NativeFilesystemLeaseChallenge { readonly nonce: string; readonly epoch: number; }
export interface NativeFilesystemLeaseCommit extends NativeFilesystemLeaseIdentity, NativeFilesystemLeaseChallenge {
  readonly revision: number;
  readonly durationMilliseconds: number;
}
export interface NativeFilesystemLeaseAcceptance extends NativeFilesystemLeaseChallenge { readonly revision: number; }
export interface NativeFilesystemWriterLaunchRequest extends NativeFilesystemLeaseIdentity {
  readonly fence: WindowsLaunchFenceDescriptor;
  readonly workspace: string;
  readonly deadlineAt: string;
}
/** @internal Trusted private bridge port, never an SDK/dispatch-selected adapter.
 * The root is already suspended and its first challenge was issued before this
 * controller runs. Native waits must be bounded and settle on bridge closure;
 * closed must provide exact owned-tree evidence or reject as unconfirmed.
 * These raw epoch methods are intentionally absent from the public OwnedWorker.
 */
export interface NativeFilesystemWriterSession extends OwnedWorker {
  readonly leaseIdentity: NativeFilesystemLeaseIdentity;
  readonly initialLeaseChallenge: NativeFilesystemLeaseChallenge;
  requestLeaseChallenge(): Promise<NativeFilesystemLeaseChallenge>;
  acceptLease(commit: NativeFilesystemLeaseCommit): Promise<NativeFilesystemLeaseAcceptance>;
}
export type NativeFilesystemWriterOutcome = { readonly state: "unconfirmed" }
  | { readonly state: "closed"; readonly exit: OwnedWorkerExit; readonly authorityLost: boolean };
export interface NativeFilesystemWriterControllerOptions { readonly renewalIntervalMs?: number; }
type WriterStore = Pick<PostgresFilesystemWriterStore, "authority" | "load" | "heartbeat">
  & Partial<Pick<PostgresFilesystemWriterStore,"loadLaunchBinding">>;

/** Fresh database ACK → private native epoch. No acquisition, receipt, result or
 * release writes or filesystem pinning. Public leased launchers also require
 * the original persisted launch binding before creating native ownership.
 */
export class NativeFilesystemWriterController {
  private readonly writers: WriterStore;
  private readonly owner: WriterStore["authority"];
  private readonly interval: number;
  constructor(writers: WriterStore, options: NativeFilesystemWriterControllerOptions = {}) {
    const interval=options.renewalIntervalMs ?? 1000;
    if (!Number.isSafeInteger(interval) || interval<1 || interval>5000) throw new TypeError("native writer renewal interval must be 1 to 5000 ms");
    this.writers=writers; this.owner=Object.freeze({ ...writers.authority }); this.interval=interval;
  }
  async assertLaunchBinding(value: NativeFilesystemWriterLaunchRequest, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error("worker launch already cancelled");
    const request={ leaseId:parseStableId(value.leaseId,"lease"),runId:parseStableId(value.runId,"run"),
      workerProcessId:parseStableId(value.workerProcessId,"workerProcess"),fence:parseWindowsLaunchFence(value.fence),
      workspace:value.workspace,deadlineAt:new Date(value.deadlineAt).toISOString() };
    if (!this.writers.loadLaunchBinding) throw new Error("persisted filesystem writer launch binding read required");
    const binding=await this.writers.loadLaunchBinding(request.leaseId);
    if (signal.aborted) throw new Error("worker launch already cancelled");
    if (!binding || !this.owned(binding.lease) || binding.lease.leaseId!==request.leaseId || binding.lease.runId!==request.runId
        || binding.lease.workerProcessId!==request.workerProcessId || binding.intent.workerProcessId!==request.workerProcessId
        || binding.workspace!==request.workspace || binding.deadlineAt!==request.deadlineAt
        || !isDeepStrictEqual(binding.intent.fence,request.fence)) throw new Error("persisted filesystem writer launch binding mismatch");
  }
  async run(session: NativeFilesystemWriterSession, signal: AbortSignal, input: string): Promise<NativeFilesystemWriterOutcome> {
    let identity: NativeFilesystemLeaseIdentity, current: FilesystemWriterLease;
    let closing=false,lost=false,released=false,epoch=0,lastNonce="",duration=0;
    let exit: OwnedWorkerExit | undefined, scheduled: ReturnType<typeof setTimeout> | undefined;
    let pending: Promise<boolean> | undefined, stopping: Promise<void> | undefined;
    const stopScheduling=() => { if (scheduled!==undefined) { clearTimeout(scheduled); scheduled=undefined; } };
    const lose=() => {
      lost=true; stopScheduling();
      // Stop is independent of a blocked DB/IPC request. Never wait for that
      // request before asking the native owner to terminate the exact tree.
      if (!exit && stopping===undefined) {
        try { stopping=Promise.resolve(session.terminate()).then(() => {},() => { lost=true; }); }
        catch { stopping=Promise.resolve(); }
      }
    };
    // Attach before load or any other await. A failed closure receipt is never
    // replaced by terminate()'s return value or an inferred dead process.
    const closure=Promise.resolve(session.closed).then((value) => {
      closing=true; stopScheduling();
      if (!this.confirmedExit(value)) { lose(); return; }
      exit=Object.freeze({ ...value });
      if (exit.failed || exit.terminated) lost=true;
    }).catch(() => { closing=true; lose(); });
    signal.addEventListener("abort",lose,{ once:true });
    if (signal.aborted) lose();
    const active=() => !closing && !lost && !signal.aborted;
    const renew=async (first?: NativeFilesystemLeaseChallenge): Promise<boolean> => {
      try {
        if (!active()) return false;
        const challenge=this.challenge(first ?? await session.requestLeaseChallenge());
        if (challenge.epoch!==epoch+1 || challenge.nonce===lastNonce) throw new Error("native challenge replay");
        if (!active()) return false;
        // This is a NEW transaction, after native issuance; a load/readback or
        // cached duration can never stand in for its commit acknowledgement.
        const next=await this.writers.heartbeat(identity.leaseId);
        if (!this.renewed(current,next)) throw new Error("filesystem writer ACK changed ownership");
        const milliseconds=Date.parse(next.expiresAt)-Date.parse(next.heartbeatAt);
        if (!Number.isSafeInteger(milliseconds) || milliseconds<=250 || milliseconds>20000) throw new Error("invalid filesystem writer budget");
        // Still validate a pending DB ACK after closure, but never send a new
        // commit then. A pending rejection remains a sticky loss of authority.
        if (!active()) return false;
        const accepted=await session.acceptLease({ ...identity,...challenge,revision:next.revision,durationMilliseconds:milliseconds });
        if (!accepted || Object.keys(accepted).length!==3 || accepted.nonce!==challenge.nonce
            || accepted.epoch!==challenge.epoch || accepted.revision!==next.revision) throw new Error("native lease ACK mismatch");
        if (!active()) return false;
        current={ ...next }; epoch=challenge.epoch; lastNonce=challenge.nonce; duration=milliseconds;
        return true;
      } catch { lose(); return false; }
    };
    const schedule=() => {
      if (!active()) return;
      // A scheduling hint only, not a rederived permission deadline. The native
      // QPC watchdog alone enforces issuance age and the irrevocable OLD epoch.
      scheduled=setTimeout(() => {
        scheduled=undefined;
        if (!active()) return;
        pending=renew().then((ok) => { if (ok) schedule(); return ok; });
      },Math.min(this.interval,Math.max(1,(duration-250)/2)));
    };
    try {
      const binding=session.leaseIdentity;
      if (!binding || Object.keys(binding).length!==3) throw new Error("exact native lease binding required");
      identity=Object.freeze({ leaseId:parseStableId(binding.leaseId,"lease"),runId:parseStableId(binding.runId,"run"),
        workerProcessId:parseStableId(binding.workerProcessId,"workerProcess") });
      if (active()) {
        const loaded=await this.writers.load(identity.leaseId);
        if (!loaded || !this.owned(loaded) || loaded.leaseId!==identity.leaseId || loaded.runId!==identity.runId
            || loaded.workerProcessId!==identity.workerProcessId) throw new Error("lease does not own the suspended native session");
        current={ ...loaded };
        if (active()) {
          pending=renew(session.initialLeaseChallenge);
          if (await pending && active()) {
            session.release(input); released=true; schedule();
          }
        }
      }
      if (!released) lose();
      await closure;
    } catch { lose(); }
    finally {
      stopScheduling();
      if (!closing) lose();
      await stopping;
      await closure;
      // Store calls use bounded connection/query timeouts; the native channel
      // settles pending requests on close. Neither operation is detached.
      await pending;
      signal.removeEventListener("abort",lose);
    }
    // No final DB/native renewal after root closure. Future transport receipt
    // persistence must occur only after this quiescent result is returned.
    return exit ? { state:"closed",exit,authorityLost:lost || !released || signal.aborted } : { state:"unconfirmed" };
  }
  private owned(lease: FilesystemWriterLease): boolean {
    return lease.state==="active" && lease.releasedAt===null && Number.isSafeInteger(lease.revision) && lease.revision>0
      && lease.hostIdentifier===this.owner.hostIdentifier && lease.ownerSessionId===this.owner.sessionId
      && lease.applicationVersion===this.owner.applicationVersion;
  }
  private renewed(previous: FilesystemWriterLease, next: FilesystemWriterLease): boolean {
    const immutable=(value: FilesystemWriterLease) => {
      const { heartbeatAt:_heartbeat,expiresAt:_expiry,revision:_revision,...identity }=value; return identity;
    };
    return this.owned(next) && next.revision>previous.revision && isDeepStrictEqual(immutable(previous),immutable(next));
  }
  private challenge(value: NativeFilesystemLeaseChallenge): NativeFilesystemLeaseChallenge {
    if (!value || Object.keys(value).length!==2 || typeof value.nonce!=="string" || !/^[0-9a-f]{32}$/u.test(value.nonce)
        || !Number.isSafeInteger(value.epoch) || value.epoch<1) throw new Error("invalid native lease challenge");
    return { nonce:value.nonce,epoch:value.epoch };
  }
  private confirmedExit(value: OwnedWorkerExit): boolean {
    return !!value && value.treeEmpty===true && Number.isSafeInteger(value.exitCode) && typeof value.output==="string"
      && typeof value.terminated==="boolean" && typeof value.failed==="boolean"
      && (value.launchSealed===undefined || value.launchSealed===true);
  }
}
