import { expectOnlyKeys,expectRecord,parseStableId,type StableId } from "@acp/domain";
import { parseCanonicalWindowsBindingPath } from "./repository-binding.ts";
import type { WindowsLaunchFenceDescriptor } from "./worker-launch-intent.ts";

/** Durable native claims only; none of these values grants GO, stop authority or hold release. */
export interface ProvisionerJournalFence extends WindowsLaunchFenceDescriptor {
  readonly namespace:"acp-worktree-provisioner-v1";
}
export interface ProvisionerNativeRoot {
  readonly processId:number;
  readonly processStartToken:string;
  /** Canonical UTC with seven fractional digits, equal to the FILETIME token. */
  readonly startedAt:string;
}
export type ProvisionerSealedObservation = {
  readonly state:"lost";readonly sealed:true;readonly reason:"sealed_launch_job_absent"|"sealed_launch_job_empty";
} | {
  readonly state:"lost";readonly sealed:true;readonly reason:"owned_job_and_original_root_absent"|"owned_job_empty";readonly root:ProvisionerNativeRoot;
} | {
  readonly state:"terminated";readonly sealed:true;readonly reason:"exact_owned_tree_terminated";readonly root:ProvisionerNativeRoot;readonly exitCode:number;
};
export interface ProvisionerProcessRecordInput {
  readonly attemptId:StableId<"worktreeProvisionerAttempt">;
  readonly fence:ProvisionerJournalFence;
  readonly root:ProvisionerNativeRoot;
}
export interface ProvisionerStopRecordInput {
  readonly attemptId:StableId<"worktreeProvisionerAttempt">;
  readonly fence:ProvisionerJournalFence;
  readonly observation:ProvisionerSealedObservation;
}
function exact(value:unknown,keys:readonly string[]):Record<string,unknown> {
  const input=expectRecord(value,"provisioner journal"); expectOnlyKeys(input,keys,"provisioner journal");
  if(keys.some((key)=>!Object.hasOwn(input,key))) throw new TypeError("all exact provisioner journal fields required");
  return input;
}
function integer(value:unknown,min:number,max:number):number {
  if(!Number.isInteger(value) || (value as number)<min || (value as number)>max) throw new TypeError("bounded native integer required");
  return value as number;
}
/** Integer Gregorian arithmetic: never round native identity through Date or SQL timestamps. */
function filetime(value:unknown):bigint {
  if(typeof value!=="string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{7}Z$/u.test(value)) throw new TypeError("canonical native UTC7 timestamp required");
  const year=Number(value.slice(0,4)),month=Number(value.slice(5,7)),day=Number(value.slice(8,10)),hour=Number(value.slice(11,13)),minute=Number(value.slice(14,16)),second=Number(value.slice(17,19));
  const leap=year%4===0 && (year%100!==0 || year%400===0),days=[31,leap ? 29 : 28,31,30,31,30,31,31,30,31,30,31];
  if(year<1601 || month<1 || month>12 || day<1 || day>days[month-1]! || hour>23 || minute>59 || second>59) throw new TypeError("valid native Gregorian timestamp required");
  const before=(y:number)=>365*y+Math.floor(y/4)-Math.floor(y/100)+Math.floor(y/400);
  const since1601=before(year-1)-before(1600)+days.slice(0,month-1).reduce((sum,n)=>sum+n,0)+day-1;
  return BigInt(((since1601*24+hour)*60+minute)*60+second)*10000000n+BigInt(value.slice(20,27));
}
export function parseProvisionerNativeRoot(value:unknown):ProvisionerNativeRoot {
  const input=exact(value,["processId","processStartToken","startedAt"]);
  const processId=integer(input.processId,1,2147483647),ticks=filetime(input.startedAt);
  if(typeof input.processStartToken!=="string" || !/^win32-filetime:[1-9][0-9]{15,19}$/u.test(input.processStartToken)
    || BigInt(input.processStartToken.slice(15))!==ticks) throw new TypeError("exact native FILETIME/start timestamp pair required");
  return { processId,processStartToken:input.processStartToken,startedAt:input.startedAt as string };
}
function fence(value:unknown):ProvisionerJournalFence {
  const input=exact(value,["namespace","directory","directoryIdentity","scope"]),scope=exact(input.scope,["machineFingerprint","bootedAt","sessionId"]);
  if(input.namespace!=="acp-worktree-provisioner-v1" || typeof input.directoryIdentity!=="string" || !/^win32-dir:[0-9a-f]{8}:[0-9a-f]{16}$/u.test(input.directoryIdentity)
    || typeof scope.machineFingerprint!=="string" || !/^[0-9a-f]{64}$/u.test(scope.machineFingerprint)) throw new TypeError("exact provisioner fence namespace and native scope required");
  // Preserve the existing describeWindowsLaunchFence producer's UTC-millisecond scope.
  if(typeof scope.bootedAt!=="string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u.test(scope.bootedAt)) throw new TypeError("canonical native boot scope required");
  filetime(scope.bootedAt.replace("Z","0000Z"));
  return { namespace:input.namespace,directory:parseCanonicalWindowsBindingPath(input.directory),directoryIdentity:input.directoryIdentity,
    scope:{ machineFingerprint:scope.machineFingerprint,bootedAt:scope.bootedAt,sessionId:integer(scope.sessionId,0,2147483647) } };
}
function rootAfterBoot(root:ProvisionerNativeRoot,observed:ProvisionerJournalFence) {
  if(filetime(root.startedAt)<filetime(observed.scope.bootedAt.replace("Z","0000Z"))) throw new TypeError("native root must not predate its boot scope");
}
export function parseProvisionerProcessRecord(value:unknown):ProvisionerProcessRecordInput {
  const input=exact(value,["attemptId","fence","root"]),observed=fence(input.fence),root=parseProvisionerNativeRoot(input.root);
  rootAfterBoot(root,observed);
  return { attemptId:parseStableId(input.attemptId,"worktreeProvisionerAttempt"),fence:observed,root };
}
export function parseProvisionerStopRecord(value:unknown):ProvisionerStopRecordInput {
  const input=exact(value,["attemptId","fence","observation"]),observed=fence(input.fence),raw=expectRecord(input.observation,"provisioner sealed observation");
  const rootless=raw.reason==="sealed_launch_job_absent" || raw.reason==="sealed_launch_job_empty",terminated=raw.reason==="exact_owned_tree_terminated";
  const checked=exact(raw,rootless ? ["state","sealed","reason"] : terminated ? ["state","sealed","reason","root","exitCode"] : ["state","sealed","reason","root"]);
  if(checked.sealed!==true || checked.state!==(terminated ? "terminated" : "lost") || !(rootless || terminated || checked.reason==="owned_job_and_original_root_absent" || checked.reason==="owned_job_empty")) {
    throw new TypeError("supported sealed provisioner observation required");
  }
  const root=rootless ? undefined : parseProvisionerNativeRoot(checked.root);
  if(root) rootAfterBoot(root,observed);
  const observation={ state:checked.state,sealed:true,reason:checked.reason,...(root ? { root } : {}),...(terminated ? { exitCode:integer(checked.exitCode,-2147483648,2147483647) } : {}) } as ProvisionerSealedObservation;
  return { attemptId:parseStableId(input.attemptId,"worktreeProvisionerAttempt"),fence:observed,observation };
}
