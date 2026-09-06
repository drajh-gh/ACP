import { isDeepStrictEqual } from "node:util";
import { expectOnlyKeys,expectRecord,parseCanonicalTimestamp,timestampMicroseconds,parseStableId,type StableId } from "@acp/domain";
import { parseProvisionerAdmissionRequest,parseProvisionerStopRecord,type ProvisionerAdmissionRequest,type ProvisionerAdmissionAcknowledgement,
  type ProvisionerStopRecordInput,type ProvisionerStopRecord,type PostgresProvisionerAdmissionStore,type PostgresProvisionerJournalStore } from "@acp/storage";

export interface NativeProvisionerExpectedPlan {
  readonly reservationId:StableId<"worktreeReservation">;
  readonly reservationRevision:number;
  readonly deadlineAt:string;
  readonly provenanceId:StableId<"provenance">;
}
export interface NativeProvisionerAdmissionAcceptance extends ProvisionerAdmissionRequest { readonly reservationRevision:number; }
/** @internal An already-owned suspended root, never a model-selected adapter.
 * Native requests/termination must be bounded and settle on channel closure.
 * The adapter independently enforces bootstrap/absolute plan deadlines, anchors
 * the ACK budget to native challenge issuance, consumes GO once, permanently
 * seals this attempt and supplies exact descendant-empty rooted closure.
 * No real provisioner adapter is enabled by this synthetic-only controller. */
export interface NativeProvisionerSession {
  readonly request:ProvisionerAdmissionRequest;
  readonly expectedPlan:NativeProvisionerExpectedPlan;
  readonly closed:Promise<ProvisionerStopRecordInput>;
  acceptAdmission(ack:ProvisionerAdmissionAcknowledgement):Promise<NativeProvisionerAdmissionAcceptance>;
  /** Releases only the fixed operation already selected by the trusted owner. */
  go():void;
  /** A request to terminate, never substitute closure evidence. */
  terminate():Promise<void>;
}
export type NativeProvisionerControllerOutcome = {
  readonly state:"unconfirmed";readonly authorityLost:true;readonly goAttempted:boolean;
} | {
  readonly state:"closed_stop_unconfirmed";readonly observation:ProvisionerStopRecordInput;readonly authorityLost:true;readonly goAttempted:boolean;
} | {
  readonly state:"stop_recorded";readonly stop:ProvisionerStopRecord;readonly authorityLost:boolean;readonly goAttempted:boolean;
};
type AdmissionPort=Pick<PostgresProvisionerAdmissionStore,"authority"|"admit">;
type JournalPort=Pick<PostgresProvisionerJournalStore,"authority"|"recordStop">;
// Do not let another controller consume the same live native-session object.
// Native permanent fencing and SQL freshness separately exclude identity aliases.
const consumedSessions=new WeakSet<NativeProvisionerSession>();

/** One fresh transaction → one native acceptance → at most one GO. Failure
 * requests stop immediately; durable stop follows closure and all pending work.
 * No process pre-journal, renewal, readback, success, release or recovery API. */
export class NativeProvisionerAdmissionController {
  private readonly owner:AdmissionPort["authority"];
  private readonly admit:AdmissionPort["admit"];
  private readonly recordStop:JournalPort["recordStop"];
  private readonly maximumWait:number;
  constructor(admissions:AdmissionPort,journal:JournalPort,options:{ readonly maximumWaitMilliseconds?:number }={}) {
    const a=admissions.authority,j=journal.authority,maximumWait=options.maximumWaitMilliseconds??20000;
    parseStableId(a.sessionId,"workerHostSession");
    if(!a.hostIdentifier.trim() || !a.applicationVersion.trim() || !isDeepStrictEqual(a,j)) throw new TypeError("admission and stop ports require the exact same original owner");
    if(!Number.isSafeInteger(maximumWait) || maximumWait<1 || maximumWait>20000) throw new TypeError("provisioner controller wait must be 1 to 20000 milliseconds");
    this.owner=Object.freeze({ ...a }); this.admit=admissions.admit.bind(admissions); this.recordStop=journal.recordStop.bind(journal); this.maximumWait=maximumWait;
  }
  async run(session:NativeProvisionerSession,signal:AbortSignal):Promise<NativeProvisionerControllerOutcome> {
    if(consumedSessions.has(session)) throw new Error("native provisioner session already consumed");
    consumedSessions.add(session);
    let request:ProvisionerAdmissionRequest|undefined,expected:NativeProvisionerExpectedPlan|undefined,observation:ProvisionerStopRecordInput|undefined;
    let lost=false,closing=false,goAttempted=false,goReturned=false;
    let stopping:Promise<void>|undefined,pending:Promise<void>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
    const clearDeadline=()=>{ if(timer!==undefined){ clearTimeout(timer); timer=undefined; } };
    const terminate=session.terminate.bind(session),accept=session.acceptAdmission.bind(session),go=session.go.bind(session);
    const lose=()=>{
      lost=true;
      // Independent of any pending DB/native request. Never wait for its answer
      // before asking the exact native owner to stop its already-owned tree.
      if(!observation && stopping===undefined) {
        // Mark before invoking the adapter: it may synchronously abort and
        // re-enter lose(). The real pending operation replaces this sentinel.
        stopping=Promise.resolve();
        try { stopping=Promise.resolve(terminate()).then(()=>{},()=>{ lost=true; }); }
        catch { stopping=Promise.resolve(); }
      }
    };
    const closure=Promise.resolve(session.closed).then((value)=>{
      closing=true; clearDeadline();
      try {
        const checked=parseProvisionerStopRecord(value);
        if(!request || checked.attemptId!==request.attemptId || !isDeepStrictEqual(checked.fence,request.fence)
          || !("root" in checked.observation) || !isDeepStrictEqual(checked.observation.root,request.root)) throw new Error("exact owned rooted closure required");
        observation=checked;
        if(!goReturned) lost=true;
      } catch { lose(); }
    }).catch(()=>{ closing=true; clearDeadline(); lose(); });
    signal.addEventListener("abort",lose,{ once:true });
    if(signal.aborted) lose();
    // Best-effort local backstop only; never substitutes for the independent
    // native deadline/issuance-age watchdog when the JS event loop is stalled.
    timer=setTimeout(lose,this.maximumWait);
    const active=()=>!lost && !closing && !signal.aborted;
    try {
      request=parseProvisionerAdmissionRequest(session.request); expected=parseExpectedPlan(session.expectedPlan);
      const exactRequest=request,exactPlan=expected;
      pending=(async()=>{
        // Observe an already-settled closure before beginning a transaction.
        await Promise.resolve();
        if(!active()) return;
        const ack=this.acknowledgement(await this.admit(exactRequest),exactRequest,exactPlan);
        // A late ACK is still validated but cannot advance a closing session.
        if(!active()) return;
        const native=await accept(ack);
        const row=exact(native,["attemptId","fence","root","challenge","reservationRevision"]);
        const nativeRequest=parseProvisionerAdmissionRequest({ attemptId:row.attemptId,fence:row.fence,root:row.root,challenge:row.challenge });
        if(!isDeepStrictEqual(nativeRequest,exactRequest) || row.reservationRevision!==exactPlan.reservationRevision) throw new Error("native provisioner acceptance mismatch");
        if(!active()) return;
        goAttempted=true; go(); goReturned=true;
      })().catch(()=>{ lose(); });
      await pending;
      if(!goReturned) lose();
      await closure;
    } catch { lose(); }
    finally {
      if(!closing) lose();
      await stopping; await closure; await pending;
      clearDeadline();
    }
    try {
      if(!observation) return { state:"unconfirmed",authorityLost:true,goAttempted };
      try {
        // Native closure alone never manufactures a database receipt. Keep its
        // evidence even if retirement or an uncertain stop COMMIT rejects.
        const stop=this.stopReceipt(await this.recordStop(observation),observation,expected);
        return { state:"stop_recorded",stop,authorityLost:lost || !goReturned || signal.aborted,goAttempted };
      } catch { return { state:"closed_stop_unconfirmed",observation,authorityLost:true,goAttempted }; }
    } finally { signal.removeEventListener("abort",lose); }
  }
  private acknowledgement(value:ProvisionerAdmissionAcknowledgement,request:ProvisionerAdmissionRequest,expected:NativeProvisionerExpectedPlan):ProvisionerAdmissionAcknowledgement {
    const row=exact(value,["attemptId","fence","root","challenge","fresh","hostIdentifier","ownerSessionId","applicationVersion","provenanceId",
      "treeIdentifier","rootClaimOwnerId","reservationId","reservationRevision","deadlineAt","admittedAt","durationMilliseconds"]);
    const observed=parseProvisionerAdmissionRequest({ attemptId:row.attemptId,fence:row.fence,root:row.root,challenge:row.challenge });
    const deadlineAt=parseCanonicalTimestamp(row.deadlineAt),admittedAt=parseCanonicalTimestamp(row.admittedAt),duration=row.durationMilliseconds;
    if(!isDeepStrictEqual(observed,request) || row.fresh!==true || row.hostIdentifier!==this.owner.hostIdentifier || row.ownerSessionId!==this.owner.sessionId
      || row.applicationVersion!==this.owner.applicationVersion || row.provenanceId!==expected.provenanceId || row.rootClaimOwnerId!==request.attemptId
      || row.treeIdentifier!==`Local\\ACP.Provisioner.${request.attemptId}` || row.reservationId!==expected.reservationId || row.reservationRevision!==expected.reservationRevision
      || deadlineAt!==expected.deadlineAt || !Number.isSafeInteger(duration) || (duration as number)<=250 || (duration as number)>20000
      || timestampMicroseconds(deadlineAt)<=timestampMicroseconds(admittedAt)
      || (timestampMicroseconds(deadlineAt)-timestampMicroseconds(admittedAt))/1000n!==BigInt(duration as number)) throw new Error("fresh provisioner acknowledgement mismatch");
    return { ...observed,fresh:true,hostIdentifier:this.owner.hostIdentifier,ownerSessionId:this.owner.sessionId,applicationVersion:this.owner.applicationVersion,
      provenanceId:expected.provenanceId,treeIdentifier:row.treeIdentifier as string,rootClaimOwnerId:request.attemptId,reservationId:expected.reservationId,
      reservationRevision:expected.reservationRevision,deadlineAt,admittedAt,durationMilliseconds:duration as number };
  }
  private stopReceipt(value:ProvisionerStopRecord,input:ProvisionerStopRecordInput,expected:NativeProvisionerExpectedPlan|undefined):ProvisionerStopRecord {
    const row=exact(value,["attemptId","fence","observation","hostIdentifier","ownerSessionId","applicationVersion","provenanceId","treeIdentifier","recordedAt"]);
    const observed=parseProvisionerStopRecord({ attemptId:row.attemptId,fence:row.fence,observation:row.observation });
    const provenanceId=parseStableId(row.provenanceId,"provenance"),recordedAt=parseCanonicalTimestamp(row.recordedAt);
    if(!isDeepStrictEqual(observed,input) || row.hostIdentifier!==this.owner.hostIdentifier || row.ownerSessionId!==this.owner.sessionId
      || row.applicationVersion!==this.owner.applicationVersion || (expected && provenanceId!==expected.provenanceId)
      || row.treeIdentifier!==`Local\\ACP.Provisioner.${input.attemptId}`) throw new Error("provisioner stop receipt mismatch");
    return { ...observed,hostIdentifier:this.owner.hostIdentifier,ownerSessionId:this.owner.sessionId,applicationVersion:this.owner.applicationVersion,
      provenanceId,treeIdentifier:row.treeIdentifier as string,recordedAt };
  }
}
function exact(value:unknown,keys:readonly string[]):Record<string,unknown> {
  const row=expectRecord(value,"private provisioner protocol"); expectOnlyKeys(row,keys,"private provisioner protocol");
  if(keys.some((key)=>!Object.hasOwn(row,key))) throw new TypeError("every private provisioner protocol field is required"); return row;
}
function parseExpectedPlan(value:unknown):NativeProvisionerExpectedPlan {
  const row=exact(value,["reservationId","reservationRevision","deadlineAt","provenanceId"]);
  if(!Number.isSafeInteger(row.reservationRevision) || (row.reservationRevision as number)<1 || (row.reservationRevision as number)>2147483647) throw new TypeError("exact original reservation revision required");
  return { reservationId:parseStableId(row.reservationId,"worktreeReservation"),reservationRevision:row.reservationRevision as number,
    deadlineAt:parseCanonicalTimestamp(row.deadlineAt),provenanceId:parseStableId(row.provenanceId,"provenance") };
}
