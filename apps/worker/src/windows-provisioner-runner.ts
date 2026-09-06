import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parseCanonicalWindowsBindingPath,type WorktreeProvisionerAttempt,type WorkerRecoveryAuthority } from "@acp/storage";
import { minimalCodexEnvironment } from "./codex-sdk-transport.ts";
import { parseNativeProvisionerOwner,provisionerChannelBinding,snapshotNativeProvisionerPlan } from "./native-provisioner-plan.ts";
import { WindowsProvisionerProcessOwner,type OwnedProvisionerHandle } from "./windows-provisioner-process.ts";

export interface WindowsProvisionerRunnerOptions {
  /** Trusted fixed capsule, not a model-selected script or per-call command. */
  readonly runnerPath:string;
  readonly powershellExecutable:string;
  readonly maximumOutputBytes?:number;
  readonly onSpawn?:(pid:number,purpose:string)=>void;
}
export interface NativeProvisionerRunner {
  readonly authority:WorkerRecoveryAuthority;
  /** Returns immediately after spawn/ownership setup, never waits for READY. */
  start(plan:WorktreeProvisionerAttempt,signal:AbortSignal):Promise<OwnedProvisionerHandle>;
}

/** @internal No production dispatcher selects a capsule here yet. The capsule
 * inherits the host's filesystem access; this is NOT a restricted Git grant. */
export class WindowsProvisionerProcessRunner implements NativeProvisionerRunner {
  readonly authority:WorkerRecoveryAuthority;
  private readonly runnerPath:string;
  private readonly powershell:string;
  private readonly node:string;
  private readonly outputLimit:number;
  private readonly onSpawn:WindowsProvisionerRunnerOptions["onSpawn"];
  constructor(authority:WorkerRecoveryAuthority,options:WindowsProvisionerRunnerOptions) {
    this.authority=parseNativeProvisionerOwner(authority);this.runnerPath=parseCanonicalWindowsBindingPath(options.runnerPath);
    this.powershell=parseCanonicalWindowsBindingPath(options.powershellExecutable);this.node=process.execPath;
    const limit=options.maximumOutputBytes??65536;
    if(!Number.isSafeInteger(limit) || limit<1 || limit>1048576)throw new TypeError("bounded fixed provisioner output required");
    this.outputLimit=limit;this.onSpawn=options.onSpawn;
  }
  async start(value:WorktreeProvisionerAttempt,signal:AbortSignal):Promise<OwnedProvisionerHandle> {
    if(process.platform!=="win32")throw new Error("native Windows provisioner unavailable");
    const plan=snapshotNativeProvisionerPlan(value),binding=provisionerChannelBinding(plan);
    if(!(signal instanceof AbortSignal) || signal.aborted || plan.state!=="planned" || !isDeepStrictEqual(binding.owner,this.authority))throw new Error("original planned provisioner owner unavailable");
    this.requireDeadline(plan.deadlineAt);
    // Read-only existence checks spend the original deadline; no new authority
    // is inferred from these paths or the inert planned state.
    const [runner,powershell,parent]=await Promise.all([stat(this.runnerPath),stat(this.powershell),stat(plan.reportedParent.path)]);
    if(!runner.isFile() || !powershell.isFile() || !parent.isDirectory())throw new Error("trusted provisioner artifacts unavailable");
    if(signal.aborted)throw new Error("provisioner cancelled before native ownership");this.requireDeadline(plan.deadlineAt);
    const environment=minimalCodexEnvironment();
    const input=JSON.stringify({attemptId:plan.attemptId,workspacePath:plan.workspacePath,branchRef:plan.branchRef,baseRevision:plan.baseRevision,
      reportedParent:plan.reportedParent,commonGitDirectory:plan.commonGitDirectory});
    const initial=JSON.stringify({...binding,bindings:{workspacePath:plan.workspacePath,reportedParent:{path:plan.reportedParent.path,identity:plan.reportedParent.identity},
      commonGitDirectory:plan.commonGitDirectory},command:{executable:this.node,arguments:["--experimental-strip-types",this.runnerPath],workspace:plan.reportedParent.path,
      environment:Object.entries(environment).map(([key,value])=>`${key}=${value}`),input,maximumOutputBytes:this.outputLimit}});
    // Construct and validate every option/frame before creating a bridge.
    const owner=new WindowsProvisionerProcessOwner(binding,initial,{maximumOutputBytes:this.outputLimit,...(this.onSpawn?{onSpawn:this.onSpawn}:{})});
    const bridge=spawn(this.powershell,["-NoLogo","-NoProfile","-NonInteractive","-File",fileURLToPath(new URL("../native/windows-provisioner-host.ps1",import.meta.url))],
      {windowsHide:true,stdio:["pipe","pipe","pipe"],env:environment});
    return owner.attach(bridge,signal); // No await may hide this already-spawned owner.
  }
  private requireDeadline(value:string):void {
    const remaining=Date.parse(value)-Date.now();if(remaining<=250 || remaining>20000)throw new Error("original provisioner deadline outside remaining native budget");
  }
}
