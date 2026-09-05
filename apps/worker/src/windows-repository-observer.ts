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
