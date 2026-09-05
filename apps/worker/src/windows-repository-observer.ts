import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { win32 } from "node:path";
import { parseWindowsDirectoryBinding, parseRepositoryBinding, type WindowsDirectoryBinding, type RepositoryBindingInput } from "@acp/storage";
import { minimalCodexEnvironment } from "./codex-sdk-transport.ts";

export interface WindowsRepositoryObserverOptions {
  /** Trusted host configuration, never a model-supplied executable or PATH search. */
  readonly gitExecutable: string;
  readonly onSpawn?: (pid: number, purpose: string) => void;
}
export type WindowsRepositoryObservation = { readonly state: "unconfirmed" } | {
  readonly state: "confirmed"; readonly kind: "repository"; readonly machineFingerprint: string;
  readonly checkout: WindowsDirectoryBinding; readonly commonGitDirectory: WindowsDirectoryBinding; readonly observedAt: string;
};
export type WindowsWorktreeObservation = { readonly state: "unconfirmed" } | {
  readonly state: "confirmed"; readonly kind: "worktree"; readonly machineFingerprint: string;
  readonly workspace: WindowsDirectoryBinding; readonly gitDirectory: WindowsDirectoryBinding;
  readonly branchRef: string; readonly headRevision: string; readonly observedAt: string;
};
export interface WindowsProvisionerTargetInput {
  readonly workspacePath:string;
  readonly branchRef:string;
  readonly baseRevision:string;
}
/** Sequential read-only observations, not an atomic snapshot, retained pins,
 * absence reservation, configured creation authority or a successful worktree. */
export type WindowsProvisionerTargetObservation = { readonly state:"unconfirmed" } | {
  readonly state:"observed";readonly kind:"provisioner_target";readonly scope:"observation_only";
  readonly machineFingerprint:string;readonly checkout:WindowsDirectoryBinding;readonly commonGitDirectory:WindowsDirectoryBinding;
  readonly parent:WindowsDirectoryBinding;readonly workspacePath:string;readonly branchRef:string;readonly baseRevision:string;
  readonly targetAbsent:true;readonly branchAbsent:true;readonly observedAt:string;
};
export function parseWindowsProvisionerTargetObservation(value:unknown):WindowsProvisionerTargetObservation {
  try {
    const v=exact(value,["state","kind","scope","machineFingerprint","checkout","commonGitDirectory","parent",
      "workspacePath","branchRef","baseRevision","targetAbsent","branchAbsent","observedAt"]);
    if(v.state!=="observed" || v.kind!=="provisioner_target" || v.scope!=="observation_only" || v.targetAbsent!==true || v.branchAbsent!==true
      || typeof v.machineFingerprint!=="string" || !/^[0-9a-f]{64}$/u.test(v.machineFingerprint)
      || typeof v.observedAt!=="string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v.observedAt)
      || !Number.isFinite(Date.parse(v.observedAt)) || new Date(v.observedAt).toISOString()!==v.observedAt) return { state:"unconfirmed" };
    const checkout=parseWindowsDirectoryBinding(v.checkout),commonGitDirectory=parseWindowsDirectoryBinding(v.commonGitDirectory),
      parent=parseWindowsDirectoryBinding(v.parent),input=parseWindowsProvisionerTargetInput({ workspacePath:v.workspacePath,branchRef:v.branchRef,baseRevision:v.baseRevision });
    if(win32.dirname(input.workspacePath)!==parent.path || parent.identity===checkout.identity || parent.identity===commonGitDirectory.identity
      || checkout.identity===commonGitDirectory.identity || win32.join(checkout.path,".git")!==commonGitDirectory.path
      || overlaps(input.workspacePath,checkout.path) || overlaps(input.workspacePath,commonGitDirectory.path)) return { state:"unconfirmed" };
    return { state:"observed",kind:"provisioner_target",scope:"observation_only",machineFingerprint:v.machineFingerprint,
      checkout,commonGitDirectory,parent,...input,targetAbsent:true,branchAbsent:true,observedAt:v.observedAt };
  } catch { return { state:"unconfirmed" }; }
}

/** Exact intent, not a native observation or base/branch creation policy. This
 * first Windows layout limits branch depth to 16 and rejects Windows aliases. */
export function parseWindowsProvisionerTargetInput(value:unknown):WindowsProvisionerTargetInput {
  const v=exact(value,["workspacePath","branchRef","baseRevision"]);
  if(typeof v.workspacePath!=="string" || typeof v.branchRef!=="string" || typeof v.baseRevision!=="string"
    || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(v.baseRevision) || !v.branchRef.startsWith("refs/heads/")
    || v.branchRef.length>1024 || /[\u0000-\u0020\u007f~^:?*\[\\]/u.test(v.branchRef) || v.branchRef.includes("..") || v.branchRef.includes("@{")) {
    throw new TypeError("bounded canonical target and exact branch/full commit intent required");
  }
  const parts=v.branchRef.slice(11).split("/");
  if(parts.length>16 || parts.some((part)=>!part || part.startsWith(".") || part.toLowerCase().endsWith(".lock"))) throw new TypeError("unsupported branch components");
  validatePath("C:\\"+parts.join("\\")); validatePath(v.workspacePath); validatePath(win32.dirname(v.workspacePath));
  return { workspacePath:v.workspacePath,branchRef:v.branchRef,baseRevision:v.baseRevision };
}
const overlaps=(left:string,right:string)=>left.toLowerCase()===right.toLowerCase()
  || left.toLowerCase().startsWith(right.toLowerCase()+"\\") || right.toLowerCase().startsWith(left.toLowerCase()+"\\");
function exact(value:unknown,keys:readonly string[]):Record<string,unknown> {
  if(!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).sort().join()!==[...keys].sort().join()) throw new TypeError("exact observation fields required");
  return value as Record<string,unknown>;
}

/** First discovery of an existing parent and absent prospective target. A
 * positive result follows native cleanup; no absence remains guaranteed.
 * Unconfirmed/aborted results are not descendant-empty stop receipts. */
export async function observeWindowsProvisionerTarget(repository:RepositoryBindingInput,input:WindowsProvisionerTargetInput,signal:AbortSignal,
  options:WindowsRepositoryObserverOptions):Promise<WindowsProvisionerTargetObservation> {
  const binding=parseRepositoryBinding(repository),intent=parseWindowsProvisionerTargetInput(input); validateWindowsRepositoryObserverOptions(options);
  if(overlaps(intent.workspacePath,binding.checkout.path) || overlaps(intent.workspacePath,binding.commonGitDirectory.path)) return { state:"unconfirmed" };
  const result=parseWindowsProvisionerTargetObservation(await helper({ operation:"provisioner_target",repository:{
    checkout:binding.checkout,commonGitDirectory:binding.commonGitDirectory,machineFingerprint:binding.machineFingerprint },...intent },signal,options));
  if(result.state!=="observed") return result;
  return result.machineFingerprint===binding.machineFingerprint && result.checkout.path===binding.checkout.path && result.checkout.identity===binding.checkout.identity
    && result.commonGitDirectory.path===binding.commonGitDirectory.path && result.commonGitDirectory.identity===binding.commonGitDirectory.identity
    && result.workspacePath===intent.workspacePath && result.branchRef===intent.branchRef && result.baseRevision===intent.baseRevision ? result : { state:"unconfirmed" };
}

/** Read-only observation. Does not register a binding, obtain a lease, or enable delivery. */
export async function observeWindowsRepository(checkout: string, signal: AbortSignal,
  options: WindowsRepositoryObserverOptions): Promise<WindowsRepositoryObservation> {
  validatePath(checkout); validateWindowsRepositoryObserverOptions(options);
  return parseObservation(await helper({ operation: "repository", checkout }, signal, options), "repository") as WindowsRepositoryObservation;
}

/** Rechecks exact native repository identities and machine before reading its linked worktree. */
export async function observeWindowsWorktree(repository: RepositoryBindingInput, workspace: string, signal: AbortSignal,
  options: WindowsRepositoryObserverOptions): Promise<WindowsWorktreeObservation> {
  const binding = parseRepositoryBinding(repository); validatePath(workspace); validateWindowsRepositoryObserverOptions(options);
  const result = parseObservation(await helper({ operation: "worktree", repository: {
    checkout: binding.checkout, commonGitDirectory: binding.commonGitDirectory, machineFingerprint: binding.machineFingerprint,
  }, workspace }, signal, options), "worktree") as WindowsWorktreeObservation;
  return result.state === "confirmed" && result.machineFingerprint !== binding.machineFingerprint ? { state: "unconfirmed" } : result;
}

function validatePath(path: string) { parseWindowsDirectoryBinding({ path, identity: "win32-dir:00000000:0000000000000000" }); }
export function validateWindowsRepositoryObserverOptions(options: WindowsRepositoryObserverOptions): void {
  validatePath(options.gitExecutable);
  if (win32.basename(options.gitExecutable).toLowerCase() !== "git.exe") throw new TypeError("trusted absolute git.exe required");
}

export function parseWindowsFilesystemObservation(value: unknown): WindowsRepositoryObservation | WindowsWorktreeObservation {
  return parseObservation(value);
}
function parseObservation(value: unknown, expected?: "repository" | "worktree"): WindowsRepositoryObservation | WindowsWorktreeObservation {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { state: "unconfirmed" };
    const v = value as Record<string, unknown>;
    if (v.state !== "confirmed" || !(v.kind === "repository" || v.kind === "worktree") || (expected && v.kind !== expected)
      || typeof v.machineFingerprint !== "string" || !/^[0-9a-f]{64}$/u.test(v.machineFingerprint)
      || typeof v.observedAt !== "string" || !Number.isFinite(Date.parse(v.observedAt))) return { state: "unconfirmed" };
    const base = { state: "confirmed" as const, machineFingerprint: v.machineFingerprint, observedAt: new Date(v.observedAt).toISOString() };
    if (v.kind === "repository") {
      if (Object.keys(v).sort().join() !== ["state","kind","machineFingerprint","observedAt","checkout","commonGitDirectory"].sort().join()) return { state: "unconfirmed" };
      const checkout = parseWindowsDirectoryBinding(v.checkout), commonGitDirectory = parseWindowsDirectoryBinding(v.commonGitDirectory);
      if (checkout.identity === commonGitDirectory.identity || win32.join(checkout.path,".git").toLowerCase() !== commonGitDirectory.path.toLowerCase()) return { state: "unconfirmed" };
      return { ...base,kind:"repository",checkout,commonGitDirectory };
    }
    if (Object.keys(v).sort().join() !== ["state","kind","machineFingerprint","observedAt","workspace","gitDirectory","branchRef","headRevision"].sort().join()) return { state: "unconfirmed" };
    const workspace = parseWindowsDirectoryBinding(v.workspace), gitDirectory = parseWindowsDirectoryBinding(v.gitDirectory);
    if (workspace.identity === gitDirectory.identity || workspace.path.toLowerCase() === gitDirectory.path.toLowerCase()
      || typeof v.branchRef !== "string" || !v.branchRef.startsWith("refs/heads/") || v.branchRef.length <= 11 || v.branchRef.length > 1024
      || /[\u0000-\u001f\u007f]/u.test(v.branchRef) || typeof v.headRevision !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(v.headRevision)) return { state: "unconfirmed" };
    return { ...base,kind:"worktree",workspace,gitDirectory,branchRef:v.branchRef,headRevision:v.headRevision };
  } catch { return { state: "unconfirmed" }; }
}

async function helper(input: object, signal: AbortSignal, options: WindowsRepositoryObserverOptions): Promise<unknown> {
  if (process.platform !== "win32" || signal.aborted) return { state: "unconfirmed" };
  const frame = JSON.stringify({ ...input,gitExecutable:options.gitExecutable,deadlineAt:new Date(Date.now()+16000).toISOString() });
  if (Buffer.byteLength(frame) > 16384) throw new TypeError("filesystem observation request too large");
  const child = spawn("pwsh",["-NoLogo","-NoProfile","-NonInteractive","-File",fileURLToPath(new URL("../native/windows-repository-observe.ps1",import.meta.url))],
    { windowsHide:true,stdio:["pipe","pipe","pipe"],env:minimalCodexEnvironment() });
  const report = (pid: number, purpose: string) => { try { options.onSpawn?.(pid,purpose); } catch {} };
  if (child.pid) report(child.pid,"ACP read-only filesystem observer (18-second bound)");
  return new Promise((done) => {
    let invalid = false, bytes = 0, pending = "", result: unknown, observations = 0;
    const stop = () => { invalid = true; child.kill(); };
    const timer = setTimeout(stop,18000);
    signal.addEventListener("abort",stop,{ once:true }); if (signal.aborted) stop();
    child.on("error",() => { invalid = true; }); child.stdin.on("error",stop);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data",(data: string) => {
      bytes += Buffer.byteLength(data); if (bytes > 32768) { stop(); return; } pending += data;
      while (pending.includes("\n")) {
        const end = pending.indexOf("\n"), line = pending.slice(0,end); pending = pending.slice(end+1);
        try {
          const message = JSON.parse(line) as Record<string, unknown>;
          if (message.type === "process" && Number.isSafeInteger(message.pid) && (message.pid as number)>0) report(message.pid as number,"ACP owned read-only Git child (shared 16-second deadline)");
          else if (message.type === "observation" && ++observations === 1) result = message.value;
          else stop();
        } catch { stop(); }
      }
    });
    child.stderr.on("data",(data: Buffer) => { bytes += data.length; if (bytes > 32768) stop(); });
    child.on("close",(code) => {
      clearTimeout(timer); signal.removeEventListener("abort",stop);
      done(!invalid && code === 0 && observations === 1 && pending.trim() === "" ? result : { state:"unconfirmed" });
    });
    child.stdin.end(frame+"\n");
  });
}
