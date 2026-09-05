import { parseStableId } from "@acp/domain";
import { WorkerTerminationUnconfirmedError } from "./worker-manager.ts";
import type { NativeFilesystemWriterController, NativeFilesystemLeaseIdentity, NativeFilesystemLeaseChallenge,
  NativeFilesystemLeaseCommit, NativeFilesystemLeaseAcceptance, NativeFilesystemWriterSession } from "./native-filesystem-writer-controller.ts";
import type { OwnedWorker, OwnedWorkerExit } from "./windows-worker-launcher.ts";

export function parseNativeFilesystemLeaseIdentity(value: unknown): NativeFilesystemLeaseIdentity {
  if (!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).length!==3) throw new Error("exact native lease identity required");
  const v=value as Record<string,unknown>;
  return Object.freeze({ leaseId:parseStableId(v.leaseId,"lease"),runId:parseStableId(v.runId,"run"),workerProcessId:parseStableId(v.workerProcessId,"workerProcess") });
}
function challenge(value: unknown): NativeFilesystemLeaseChallenge {
  if (!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).length!==2) throw new Error("exact native challenge required");
  const v=value as Record<string,unknown>;
  if (typeof v.nonce!=="string" || !/^[0-9a-f]{32}$/u.test(v.nonce) || !Number.isSafeInteger(v.epoch) || (v.epoch as number)<1) {
    throw new Error("invalid native challenge");
  }
  return Object.freeze({ nonce:v.nonce,epoch:v.epoch as number });
}
type EpochReply = NativeFilesystemLeaseChallenge | NativeFilesystemLeaseAcceptance;
type Pending = { readonly type:"lease-challenge" | "lease-accepted"; readonly expected?: NativeFilesystemLeaseAcceptance;
  readonly resolve:(value: EpochReply) => void; readonly reject:(error: Error) => void; readonly timer: ReturnType<typeof setTimeout> };

/** @internal One bounded private request; never returned to a worker/model. */
export class WindowsFilesystemLeaseChannel {
  readonly identity: NativeFilesystemLeaseIdentity;
  readonly initialChallenge: NativeFilesystemLeaseChallenge;
  private readonly send: (frame: unknown) => void;
  private readonly stop: () => void;
  private readonly timeout: number;
  private pending: Pending | undefined;
  private ended=false;
  constructor(identity: NativeFilesystemLeaseIdentity, initial: unknown, send: (frame: unknown) => void, stop: () => void, timeoutMs=3000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>5000) throw new Error("invalid native epoch IPC timeout");
    this.identity=parseNativeFilesystemLeaseIdentity(identity); this.initialChallenge=challenge(initial);
    if (this.initialChallenge.epoch!==1) throw new Error("native bootstrap challenge must be first");
    this.send=send; this.stop=stop; this.timeout=timeoutMs;
  }
  requestChallenge(): Promise<NativeFilesystemLeaseChallenge> {
    return this.request("lease-challenge",{ type:"lease-challenge" });
  }
  accept(commit: NativeFilesystemLeaseCommit): Promise<NativeFilesystemLeaseAcceptance> {
    try {
      const c=challenge({ nonce:commit.nonce,epoch:commit.epoch });
      if (Object.keys(commit).length!==7 || commit.leaseId!==this.identity.leaseId || commit.runId!==this.identity.runId
          || commit.workerProcessId!==this.identity.workerProcessId || !Number.isSafeInteger(commit.revision) || commit.revision<1
          || !Number.isSafeInteger(commit.durationMilliseconds) || commit.durationMilliseconds<=250 || commit.durationMilliseconds>20000) {
        throw new Error("native epoch commit changed its bound authority");
      }
      const expected={ ...c,revision:commit.revision };
      return this.request("lease-accepted",{ type:"lease-commit",...this.identity,...expected,durationMilliseconds:commit.durationMilliseconds },expected)
        .then((reply) => reply as NativeFilesystemLeaseAcceptance);
    } catch { const error=new Error("invalid native epoch commit"); this.fail(error); return Promise.reject(error); }
  }
  receive(frame: Record<string,unknown>): void {
    try {
      const pending=this.pending;
      if (this.ended || !pending || frame.type!==pending.type) throw new Error("unsolicited native epoch frame");
      let reply: EpochReply;
      if (pending.type==="lease-challenge") {
        if (Object.keys(frame).length!==3) throw new Error("invalid native challenge frame");
        reply=challenge({ nonce:frame.nonce,epoch:frame.epoch });
      } else {
        if (Object.keys(frame).length!==4 || frame.nonce!==pending.expected!.nonce || frame.epoch!==pending.expected!.epoch
            || frame.revision!==pending.expected!.revision) throw new Error("native epoch acknowledgement mismatch");
        reply={ ...pending.expected! };
      }
      clearTimeout(pending.timer); this.pending=undefined; pending.resolve(reply);
    } catch { const error=new Error("invalid native epoch transition"); this.fail(error); throw error; }
  }
  close(error=new Error("native epoch channel closed")): void {
    this.ended=true;
    const pending=this.pending; this.pending=undefined;
    if (pending) { clearTimeout(pending.timer); pending.reject(error); }
  }
  private fail(error: Error): void {
    this.close(error);
    // Ownership cleanup must not depend on the consumer draining the rejection.
    try { this.stop(); } catch { /* Raw ownership still owes bounded closure evidence. */ }
  }
  private request(type: Pending["type"],frame: unknown,expected?: NativeFilesystemLeaseAcceptance): Promise<EpochReply> {
    if (this.ended) return Promise.reject(new Error("native epoch channel already closed"));
    if (this.pending) { const error=new Error("native epoch request already pending"); this.fail(error); return Promise.reject(error); }
    const reply=Promise.withResolvers<EpochReply>();
    const timer=setTimeout(() => this.fail(new Error("native epoch acknowledgement timed out")),this.timeout);
    this.pending={ type,...(expected ? { expected } : {}),resolve:reply.resolve,reject:reply.reject,timer };
    // Register the bounded wait before a write can cause a synchronous reply.
    try { this.send(frame); } catch { this.fail(new Error("native epoch delivery failed")); }
    return reply.promise;
  }
}

/** @internal Public completion is controller-quiescent, not raw pipe closure. */
export function guardFilesystemOwnedWorker(raw: OwnedWorker, channel: WindowsFilesystemLeaseChannel,
  controller: NativeFilesystemWriterController, signal: AbortSignal): OwnedWorker {
  const completion=Promise.withResolvers<OwnedWorkerExit>(); void completion.promise.catch(() => {});
  let releaseRequested=false,ended=false,stopping=false;
  void raw.closed.then((exit) => {
    // Bootstrap expiry or stop before release must not wait for a controller
    // invocation that will never exist. No guarded execution occurred.
    if (!releaseRequested) { ended=true; completion.resolve({ ...exit,failed:true }); }
  },(error) => { if (!releaseRequested) { ended=true; completion.reject(error); } });
  return { scope:raw.scope,processId:raw.processId,processStartToken:raw.processStartToken,startedAt:raw.startedAt,closed:completion.promise,
    release(input) {
      if (releaseRequested || stopping || ended || signal.aborted) throw new Error("leased worker cannot be released now");
      if (Buffer.byteLength(JSON.stringify({ type:"go",input }))>524288) throw new Error("worker input exceeds IPC limit");
      releaseRequested=true;
      const session: NativeFilesystemWriterSession={ ...raw,leaseIdentity:channel.identity,initialLeaseChallenge:channel.initialChallenge,
        requestLeaseChallenge:() => channel.requestChallenge(),acceptLease:(commit) => channel.accept(commit) };
      // session.closed/terminate are RAW. Substituting public completion here
      // creates a cycle: controller cleanup would wait for its own result.
      const failed=async () => {
        try { await raw.terminate(); } catch { /* No substitute for confirmed closure. */ }
        ended=true; completion.reject(new WorkerTerminationUnconfirmedError());
      };
      try {
        void controller.run(session,signal,input).then((outcome) => {
          ended=true;
          if (outcome.state==="closed") completion.resolve({ ...outcome.exit,failed:outcome.exit.failed || outcome.authorityLost || stopping });
          else completion.reject(new WorkerTerminationUnconfirmedError());
        }).catch(failed);
      } catch { void failed(); }
    },
    terminate() {
      stopping=true;
      // Stop the native tree synchronously, then await the public quiescent
      // outcome. In particular, do not queue stop behind a held DB transaction.
      try { void raw.terminate().catch(() => {}); }
      catch { completion.reject(new WorkerTerminationUnconfirmedError()); }
      return completion.promise;
    },
  };
}
