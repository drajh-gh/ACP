import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ProvisionerStopRecordInput } from "@acp/storage";
import { parseBoundedJson } from "./bounded-json.ts";
import { parseNativeProvisionerExpectedPlan,type NativeProvisionerSession } from "./native-provisioner-controller.ts";
import { WindowsProvisionerChannel,type NativeProvisionerChannelBinding } from "./windows-provisioner-channel.ts";

export interface OwnedProvisionerHandle {
  readonly ready:Promise<NativeProvisionerSession>;
  readonly closed:Promise<ProvisionerStopRecordInput>;
  readonly signal:AbortSignal;
  terminate():Promise<void>;
  outputBytes():Buffer;
}
export interface ProvisionerProcessOptions {
  readonly startupTimeoutMilliseconds?:number;
  readonly drainGraceMilliseconds?:number;
  readonly maximumOutputBytes?:number;
  readonly onSpawn?:(pid:number,purpose:string)=>void;
}
/** @internal Construct/validate before spawn, then attach once synchronously.
 * Owns only the exact supplied ChildProcess. It never interprets exit as close,
 * kills arbitrary PIDs, or manufactures native rooted-stop evidence. */
export class WindowsProvisionerProcessOwner {
  private readonly channel:WindowsProvisionerChannel;
  private readonly initial:string;
  private readonly absoluteDeadline:number;
  private readonly startupMilliseconds:number;
  private readonly grace:number;
  private readonly report:ProvisionerProcessOptions["onSpawn"];
  private bridge:ChildProcessWithoutNullStreams|undefined;
  private attached=false;
  private physical=false;
  private exited=false;
  private draining=false;
  private startup:ReturnType<typeof setTimeout>|undefined;
  private deadline:ReturnType<typeof setTimeout>|undefined;
  private forced:ReturnType<typeof setTimeout>|undefined;
  private abortSignal:AbortSignal|undefined;
  private readonly abort=()=>this.channel.failTransport();
  private readonly writes=new Set<(error?:Error|null)=>void>();
  constructor(binding:NativeProvisionerChannelBinding,initialFrame:string,options:ProvisionerProcessOptions={}) {
    const startup=options.startupTimeoutMilliseconds??10000,grace=options.drainGraceMilliseconds??6000;
    if(!Number.isSafeInteger(startup) || startup<1 || startup>10000 || !Number.isSafeInteger(grace) || grace<1 || grace>6000)throw new TypeError("bounded provisioner process timeouts required");
    if(typeof initialFrame!=="string" || initialFrame.length>16384 || /[\r\n]/u.test(initialFrame))throw new TypeError("bounded single initial native frame required");
    parseBoundedJson(initialFrame,{maximumBytes:65536,maximumDepth:12,maximumNodes:1000,canonicalIntegers:true});
    this.absoluteDeadline=Date.parse(parseNativeProvisionerExpectedPlan(binding.expectedPlan).deadlineAt);
    const remaining=this.absoluteDeadline-Date.now();if(remaining<=250 || remaining>20000)throw new Error("original provisioner deadline unavailable before spawn");
    this.initial=initialFrame+"\n";this.startupMilliseconds=startup;this.grace=grace;this.report=options.onSpawn;
    this.channel=new WindowsProvisionerChannel(binding,{send:frame=>this.write(JSON.stringify(frame)+"\n"),stop:sendStop=>this.beginDrain(sendStop)},
      {...(options.maximumOutputBytes===undefined?{}:{maximumOutputBytes:options.maximumOutputBytes})});
  }
  attach(bridge:ChildProcessWithoutNullStreams,signal:AbortSignal):OwnedProvisionerHandle {
    if(this.attached)throw new Error("provisioner process ownership already attached");
    this.attached=true;this.bridge=bridge;this.abortSignal=signal;
    bridge.stdin.on("error",()=>{if(!this.physical)this.channel.failTransport();});
    bridge.stdout.on("error",()=>{if(!this.physical)this.channel.failTransport();});
    bridge.stderr.on("error",()=>{if(!this.physical)this.channel.failTransport();});
    bridge.on("error",()=>{if(!this.physical)this.channel.failTransport();});
    bridge.stdout.on("data",(chunk:Buffer)=>this.channel.feed(chunk));
    bridge.stdout.once("end",()=>this.channel.endOutput());
    let errorBytes=0;bridge.stderr.on("data",(chunk:Buffer)=>{errorBytes+=chunk.length;if(errorBytes>65536)this.channel.failTransport();});
    bridge.once("exit",(code,exitSignal)=>{
      this.exited=true;
      // Buffered stdout may still arrive after exit. Start a physical drain,
      // preserving provisional evidence until close and decoder finalization.
      if(code!==0 || exitSignal!==null)this.channel.failTransport();
      this.beginDrain(false);
    });
    bridge.once("close",(code,exitSignal)=>this.close(code,exitSignal));
    signal.addEventListener("abort",this.abort,{once:true});
    const remaining=Math.max(0,this.absoluteDeadline-Date.now());
    this.deadline=setTimeout(this.abort,remaining);this.startup=setTimeout(this.abort,Math.min(remaining,this.startupMilliseconds));
    void this.channel.ready.then(session=>{if(this.startup!==undefined)clearTimeout(this.startup);this.startup=undefined;this.reportSpawn(session.request.root.processId,"ACP suspended provisioner root");},()=>{});
    if(signal.aborted)this.channel.failTransport();
    else try{this.write(this.initial);}catch{this.channel.failTransport();}
    if(bridge.pid!==undefined)this.reportSpawn(bridge.pid,"ACP private provisioner bridge");
    return Object.freeze({ready:this.channel.ready,closed:this.channel.closed,signal:this.channel.signal,
      terminate:()=>this.channel.terminate(),outputBytes:()=>this.channel.outputBytes()});
  }
  private write(frame:string):void {
    const bridge=this.bridge;
    if(this.physical || !bridge || bridge.stdin.destroyed || bridge.stdin.writableEnded)throw new Error("private provisioner input unavailable");
    if(frame.length>16385 || Buffer.byteLength(frame,"utf8")>65537)throw new Error("private provisioner input frame bound");
    const settled=(error?:Error|null)=>{
      if(!this.writes.delete(settled))return;
      if(error)this.channel.failTransport();
    };
    this.writes.add(settled);
    try{bridge.stdin.write(frame,settled);}catch(error){settled(new Error("private provisioner write failed"));throw error;}
  }
  private beginDrain(sendStop:boolean):void {
    if(this.draining || this.physical)return;
    this.draining=true;
    if(this.startup!==undefined)clearTimeout(this.startup);this.startup=undefined;
    if(this.deadline!==undefined)clearTimeout(this.deadline);this.deadline=undefined;
    // Arm before any write/end operation can fail or re-enter termination.
    this.forced=setTimeout(()=>this.force(),this.grace);
    const bridge=this.bridge;if(!bridge)return;
    try{if(sendStop && !this.exited)this.write('{"type":"stop"}\n');bridge.stdin.end();}
    catch{bridge.stdin.destroy();}
  }
  private force():void {
    this.forced=undefined;if(this.physical)return;
    this.channel.failTransport();
    const bridge=this.bridge;if(!bridge)return;
    try{if(!this.exited)bridge.kill();}catch{/* No invented process exit when native termination fails. */}
    finally{
      // Settle our local pipe endpoints, including inherited-pipe hangs after
      // process exit. Child `close` still requires its actual exit observation.
      bridge.stdin.destroy();bridge.stdout.destroy();bridge.stderr.destroy();
    }
  }
  private close(code:number|null,signal:NodeJS.Signals|null):void {
    if(this.physical)return;this.physical=true;
    if(this.startup!==undefined)clearTimeout(this.startup);if(this.deadline!==undefined)clearTimeout(this.deadline);if(this.forced!==undefined)clearTimeout(this.forced);
    this.startup=undefined;this.deadline=undefined;this.forced=undefined;this.abortSignal?.removeEventListener("abort",this.abort);
    // Drain write callbacks already queued by Node before interpreting any
    // remainder as failed. Child close may arrive in a synchronous test/native
    // callback before those callbacks get their next I/O checkpoint.
    setImmediate(()=>{
      for(const settle of [...this.writes])settle(new Error("private write closed before acknowledgement"));
      this.channel.transportClosed(code,signal);
    });
  }
  private reportSpawn(pid:number,purpose:string):void {try{this.report?.(pid,purpose);}catch{/* Observability never interrupts ownership. */}}
}
