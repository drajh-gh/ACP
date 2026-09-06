import { isDeepStrictEqual } from "node:util";
import { expectOnlyKeys,expectRecord,parseStableId,type StableId } from "@acp/domain";
import { parseProvisionerAdmissionRequest,type PostgresWorktreeProvisionerStore,type PostgresProvisionerAdmissionStore,
  type PostgresProvisionerJournalStore,type WorktreeProvisionerAttempt,type WorkerRecoveryAuthority } from "@acp/storage";
import { NativeProvisionerAdmissionController,parseNativeProvisionerExpectedPlan,type NativeProvisionerControllerOutcome } from "./native-provisioner-controller.ts";
import { parseNativeProvisionerOwner,provisionerChannelBinding,snapshotNativeProvisionerPlan } from "./native-provisioner-plan.ts";
import type { NativeProvisionerRunner } from "./windows-provisioner-runner.ts";
import type { OwnedProvisionerHandle } from "./windows-provisioner-process.ts";

type PlanPort=Pick<PostgresWorktreeProvisionerStore,"authority"|"load">;
type AdmissionPort=Pick<PostgresProvisionerAdmissionStore,"authority"|"admit">;
type JournalPort=Pick<PostgresProvisionerJournalStore,"authority"|"recordStop">;
export type NativeProvisionerExecutorOutcome=NativeProvisionerControllerOutcome | {
  readonly state:"not_started";readonly authorityLost:true;readonly goAttempted:false;
  readonly reason:"cancelled"|"plan_unavailable"|"plan_rejected"|"launch_unavailable";
};
const consumedHandles=new WeakSet<OwnedProvisionerHandle>();

/** @internal One original-plan load, one owned runner, one fresh controller.
 * No plan creation, renewal, operation selector, retry, release or dispatcher.
 * Port requests must be bounded by their trusted transport; cancellation drains
 * them rather than abandoning a hidden database transaction or spawned child. */
export class NativeProvisionerExecutor {
  readonly authority:WorkerRecoveryAuthority;
  private readonly load:PlanPort["load"];
  private readonly start:NativeProvisionerRunner["start"];
  private readonly controller:NativeProvisionerAdmissionController;
  constructor(plans:PlanPort,admissions:AdmissionPort,journal:JournalPort,runner:NativeProvisionerRunner) {
    this.authority=parseNativeProvisionerOwner(plans.authority);
    for(const owner of [admissions.authority,journal.authority,runner.authority])
      if(!isDeepStrictEqual(this.authority,parseNativeProvisionerOwner(owner)))throw new TypeError("all provisioner ports require the exact original owner");
    this.load=plans.load.bind(plans);this.start=runner.start.bind(runner);
    this.controller=new NativeProvisionerAdmissionController({authority:this.authority,admit:admissions.admit.bind(admissions)},
      {authority:this.authority,recordStop:journal.recordStop.bind(journal)});
  }
  async run(value:{readonly attemptId:StableId<"worktreeProvisionerAttempt">;readonly signal:AbortSignal}):Promise<NativeProvisionerExecutorOutcome> {
    const row=expectRecord(value,"private provisioner invocation");expectOnlyKeys(row,["attemptId","signal"],"private provisioner invocation");
    if(!Object.hasOwn(row,"attemptId") || !Object.hasOwn(row,"signal"))throw new TypeError("both exact provisioner invocation fields required");
    const attemptId=parseStableId(row.attemptId,"worktreeProvisionerAttempt"),signal=row.signal;
    if(!(signal instanceof AbortSignal))throw new TypeError("owned provisioner cancellation signal required");
    if(signal.aborted)return notStarted("cancelled");
    let retained:WorktreeProvisionerAttempt|undefined;
    try{retained=await this.load(attemptId);}catch{return notStarted("plan_unavailable");}
    if(signal.aborted)return notStarted("cancelled");
    if(retained===undefined)return notStarted("plan_unavailable");
    let plan:WorktreeProvisionerAttempt;
    try {
      plan=snapshotNativeProvisionerPlan(retained);
      const remaining=Date.parse(plan.deadlineAt)-Date.now();
      if(plan.attemptId!==attemptId || plan.state!=="planned" || remaining<=250 || remaining>20000
        || !isDeepStrictEqual(provisionerChannelBinding(plan).owner,this.authority))return notStarted("plan_rejected");
    } catch {return notStarted("plan_rejected");}
    let handle:OwnedProvisionerHandle;
    try{handle=await this.start(plan,signal);}catch{return notStarted("launch_unavailable");}
    // Trusted runner returns ownership immediately after spawn, not after READY.
    const terminate=handle.terminate.bind(handle),originalClosed=handle.closed,closed=Promise.resolve(originalClosed),ready=handle.ready,nativeSignal=handle.signal;
    void closed.catch(()=>{});
    let stopping:Promise<void>|undefined,combined:AbortSignal|undefined,goAttempted=false;
    const stop=():Promise<void>=>{
      if(stopping===undefined){
        stopping=Promise.resolve(); // Re-entry sentinel before the native method.
        try{stopping=Promise.resolve(terminate()).then(()=>{},()=>{});}catch{/* Closure remains independently required. */}
      }
      return stopping;
    };
    const abort=()=>{void stop();};
    try {
      if(consumedHandles.has(handle))throw new Error("owned provisioner handle already consumed");
      consumedHandles.add(handle);
      combined=AbortSignal.any([signal,nativeSignal]);combined.addEventListener("abort",abort,{once:true});if(combined.aborted)abort();
      const session=await ready,request=parseProvisionerAdmissionRequest(session.request),expectedPlan=parseNativeProvisionerExpectedPlan(session.expectedPlan);
      const binding=provisionerChannelBinding(plan);
      if(session.closed!==originalClosed || request.attemptId!==attemptId || !isDeepStrictEqual(expectedPlan,binding.expectedPlan)
        || request.fence.namespace!==binding.fencePlan.namespace || request.fence.directory!==binding.fencePlan.directory
        || request.fence.scope.machineFingerprint!==binding.machineFingerprint)throw new Error("native readiness differs from the loaded original plan");
      // Use the owned handle's closure/termination, never a substituted receipt.
      // Valid late identity may reach a pre-aborted controller for stop-only work.
      const go=session.go.bind(session);
      return await this.controller.run({request,expectedPlan,closed,
        acceptAdmission:session.acceptAdmission.bind(session),go:()=>{goAttempted=true;go();},terminate:stop},combined);
    } catch {
      await stop();return {state:"unconfirmed",authorityLost:true,goAttempted};
    } finally {
      // Neither terminate() returning nor READY rejection proves physical stop.
      await closed.catch(()=>{});await stopping;
      combined?.removeEventListener("abort",abort);
    }
  }
}
function notStarted(reason:Extract<NativeProvisionerExecutorOutcome,{state:"not_started"}>["reason"]):NativeProvisionerExecutorOutcome {
  return {state:"not_started",authorityLost:true,goAttempted:false,reason};
}
