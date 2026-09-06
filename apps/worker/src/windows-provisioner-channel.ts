import { isDeepStrictEqual } from "node:util";
import { expectOnlyKeys,expectRecord,parseStableId,type StableId } from "@acp/domain";
import { parseCanonicalWindowsBindingPath,parseProvisionerAdmissionRequest,parseProvisionerStopRecord,
  type PostgresProvisionerAdmissionStore,type ProvisionerAdmissionAcknowledgement,type ProvisionerAdmissionRequest,type ProvisionerStopRecordInput } from "@acp/storage";
import { parseBoundedJson } from "./bounded-json.ts";
import { parseNativeProvisionerAcknowledgement,parseNativeProvisionerExpectedPlan,
  type NativeProvisionerExpectedPlan,type NativeProvisionerAdmissionAcceptance,type NativeProvisionerSession } from "./native-provisioner-controller.ts";

export interface NativeProvisionerChannelBinding {
  readonly attemptId:StableId<"worktreeProvisionerAttempt">;
  readonly expectedPlan:NativeProvisionerExpectedPlan;
  readonly owner:PostgresProvisionerAdmissionStore["authority"];
  readonly fencePlan:{readonly namespace:"acp-worktree-provisioner-v1";readonly directory:string};
  readonly machineFingerprint:string;
}
type Pending={readonly resolve:(value:NativeProvisionerAdmissionAcceptance)=>void;readonly reject:(error:Error)=>void;readonly timer:ReturnType<typeof setTimeout>};
const limits={maximumBytes:65536,maximumDepth:12,maximumNodes:1000,canonicalIntegers:true} as const;

/** @internal Raw private session, not a public execution capability.
 * Feed only native stdout. transportClosed must be called only on actual child
 * `close` after process AND pipes settle, never on `exit` or a protocol frame.
 * The executor must combine signal with the caller signal for controller.run. */
export class WindowsProvisionerChannel {
  private readonly binding:NativeProvisionerChannelBinding;
  private readonly send:(frame:unknown)=>void;
  private readonly stop:(sendStop:boolean)=>void;
  private readonly timeout:number;
  private readonly maximumOutput:number;
  private readonly failure=new AbortController();
  readonly signal=this.failure.signal;
  private readonly readiness=Promise.withResolvers<NativeProvisionerSession>();
  readonly ready=this.readiness.promise;
  private readonly completion=Promise.withResolvers<ProvisionerStopRecordInput>();
  readonly closed=this.completion.promise;
  private readonly decoder=new TextDecoder("utf-8",{fatal:true,ignoreBOM:true});
  private buffered="";
  private frames=0;
  private bytes=0;
  private readonly chunks:Buffer[]=[];
  private request:ProvisionerAdmissionRequest|undefined;
  private pending:Pending|undefined;
  private stage:"awaiting_ready"|"suspended"|"admitting"|"accepted"|"go_sent"="awaiting_ready";
  private terminal:"closed"|"unconfirmed"|undefined;
  private evidence:ProvisionerStopRecordInput|undefined;
  private stopping=false;
  private draining=false;
  private corrupt=false;
  private ended=false;
  constructor(binding:NativeProvisionerChannelBinding,io:{send(frame:unknown):void;
    /** Always begin bounded transport drain/termination; send a stop frame only when true. */
    stop(sendStop:boolean):void},
    options:{readonly acknowledgementTimeoutMilliseconds?:number;readonly maximumOutputBytes?:number}={}) {
    const row=exact(binding,["attemptId","expectedPlan","owner","fencePlan","machineFingerprint"]),owner=exact(row.owner,["hostIdentifier","sessionId","applicationVersion"]),fence=exact(row.fencePlan,["namespace","directory"]);
    if(typeof owner.hostIdentifier!=="string" || !owner.hostIdentifier.trim() || typeof owner.applicationVersion!=="string" || !owner.applicationVersion.trim()
      || fence.namespace!=="acp-worktree-provisioner-v1" || typeof row.machineFingerprint!=="string" || !/^[0-9a-f]{64}$/u.test(row.machineFingerprint))throw new TypeError("exact original provisioner channel binding required");
    this.binding=freeze({attemptId:parseStableId(row.attemptId,"worktreeProvisionerAttempt"),expectedPlan:parseNativeProvisionerExpectedPlan(row.expectedPlan),
      owner:{hostIdentifier:owner.hostIdentifier,sessionId:parseStableId(owner.sessionId,"workerHostSession"),applicationVersion:owner.applicationVersion},
      fencePlan:{namespace:fence.namespace,directory:parseCanonicalWindowsBindingPath(fence.directory)},machineFingerprint:row.machineFingerprint});
    const timeout=options.acknowledgementTimeoutMilliseconds??3000,maximumOutput=options.maximumOutputBytes??65536;
    if(!Number.isSafeInteger(timeout) || timeout<1 || timeout>5000 || !Number.isSafeInteger(maximumOutput) || maximumOutput<1 || maximumOutput>1048576)throw new TypeError("bounded provisioner channel options required");
    this.timeout=timeout;this.maximumOutput=maximumOutput;this.send=io.send.bind(io);this.stop=io.stop.bind(io);
    void this.ready.catch(()=>{});void this.closed.catch(()=>{});
  }
  feed(data:Uint8Array):void {
    if(this.ended || this.corrupt)return;
    try {
      // Bound buffering per frame while allowing coalesced frames in one chunk.
      for(let offset=0;offset<data.byteLength;offset+=4096)this.consume(this.decoder.decode(data.subarray(offset,offset+4096),{stream:true}));
    } catch {this.protocolFailure();}
  }
  /** Transport I/O/timeout failure may still be followed by valid physical stop. */
  failTransport():void {this.requestStop();}
  terminate():Promise<void> {this.requestStop();return this.closed.then(()=>{});}
  transportClosed(exitCode:number|null,signal:string|null):void {
    if(this.ended)return;
    this.ended=true;
    try {if(!this.corrupt){this.consume(this.decoder.decode());if(this.buffered!=="")throw new Error("partial native frame");}}
    catch {this.protocolFailure();}
    this.rejectPending(new Error("native provisioner channel closed"));
    if(exitCode!==0 || signal!==null || !this.evidence || this.corrupt || this.stage!=="go_sent")this.failure.abort();
    if(this.evidence && !this.corrupt)this.completion.resolve(this.evidence);
    else this.completion.reject(new Error("native provisioner closure unconfirmed"));
    this.readiness.reject(new Error("native provisioner readiness ended"));
  }
  outputBytes():Buffer {
    if(!this.ended || !this.evidence || this.corrupt)throw new Error("native output unavailable before physical closure");
    return Buffer.concat(this.chunks);
  }
  private consume(text:string):void {
    this.buffered+=text;let newline:number;
    while((newline=this.buffered.indexOf("\n"))>=0) {
      const line=this.buffered.slice(0,newline);this.buffered=this.buffered.slice(newline+1);
      if(++this.frames>4096)throw new Error("native frame count bound");
      this.receive(exactRecord(parseBoundedJson(line,limits)));
    }
    if(this.buffered.length>65536 || Buffer.byteLength(this.buffered,"utf8")>65536)throw new Error("unterminated native frame bound");
  }
  private receive(frame:Record<string,unknown>):void {
    if(this.terminal)throw new Error("native frame after terminal evidence");
    if(frame.type==="ready") {
      exact(frame,["type","request"]);if(this.request || this.stage!=="awaiting_ready")throw new Error("duplicate native readiness");
      const request=freeze(parseProvisionerAdmissionRequest(frame.request)),b=this.binding;
      if(request.attemptId!==b.attemptId || request.fence.namespace!==b.fencePlan.namespace || request.fence.directory!==b.fencePlan.directory
        || request.fence.scope.machineFingerprint!==b.machineFingerprint)throw new Error("native readiness differs from original plan");
      this.request=request;this.stage="suspended";
      if(!this.stopping)this.readiness.resolve(Object.freeze({request,expectedPlan:b.expectedPlan,closed:this.closed,
        acceptAdmission:(ack:ProvisionerAdmissionAcknowledgement)=>this.accept(ack),go:()=>this.go(),terminate:()=>this.terminate()}));
    } else if(frame.type==="accepted") {
      exact(frame,["type","acceptance"]);if(this.stage!=="admitting" || (!this.pending && !this.stopping))throw new Error("unsolicited native acceptance");
      const row=exact(frame.acceptance,["attemptId","fence","root","challenge","reservationRevision"]);
      const request=parseProvisionerAdmissionRequest({attemptId:row.attemptId,fence:row.fence,root:row.root,challenge:row.challenge});
      if(!isDeepStrictEqual(request,this.request) || row.reservationRevision!==this.binding.expectedPlan.reservationRevision)throw new Error("native acceptance mismatch");
      const pending=this.pending;this.pending=undefined;this.stage="accepted";
      // A known in-flight ACK may arrive after cancellation rejected its wait.
      // Drain it once, still validating identity, without reviving GO authority.
      if(pending){clearTimeout(pending.timer);pending.resolve(freeze({...request,reservationRevision:row.reservationRevision as number}));}
    } else if(frame.type==="output") {
      exact(frame,["type","data"]);if(this.stage!=="go_sent" || typeof frame.data!=="string")throw new Error("native output before GO");
      const data=Buffer.from(frame.data,"base64");
      if(data.length<1 || data.length>8192 || data.toString("base64")!==frame.data || this.bytes+data.length>this.maximumOutput)throw new Error("native output bound or encoding");
      this.bytes+=data.length;this.chunks.push(data);
    } else if(frame.type==="closed") {
      exact(frame,["type","failed","stop"]);if(!this.request || typeof frame.failed!=="boolean")throw new Error("native closure requires exact readiness and failure flag");
      const stop=freeze(parseProvisionerStopRecord(frame.stop));
      if(stop.attemptId!==this.request.attemptId || !isDeepStrictEqual(stop.fence,this.request.fence)
        || stop.observation.state!=="terminated" || !isDeepStrictEqual(stop.observation.root,this.request.root))throw new Error("native stop differs from held root");
      // Mark terminal before abort: a synchronous listener may call terminate.
      this.terminal="closed";this.evidence=stop;this.rejectPending(new Error("native provisioner closed before acceptance"));
      if(frame.failed || this.stage!=="go_sent")this.failure.abort();
      this.beginDrain(false);
    } else if(frame.type==="unconfirmed") {
      exact(frame,["type"]);this.terminal="unconfirmed";this.rejectPending(new Error("native provisioner closure unconfirmed"));this.failure.abort();
      this.beginDrain(false);
    } else throw new Error("unknown native provisioner frame");
  }
  private accept(value:ProvisionerAdmissionAcknowledgement):Promise<NativeProvisionerAdmissionAcceptance> {
    try {
      if(this.stopping || this.ended || this.terminal || this.stage!=="suspended" || !this.request)throw new Error("native admission cannot repeat or resume");
      const ack=parseNativeProvisionerAcknowledgement(value,this.request,this.binding.expectedPlan,this.binding.owner),reply=Promise.withResolvers<NativeProvisionerAdmissionAcceptance>();
      const timer=setTimeout(()=>{this.rejectPending(new Error("native provisioner acceptance timed out"));this.requestStop();},this.timeout);
      this.pending={resolve:reply.resolve,reject:reply.reject,timer};this.stage="admitting";
      // Register pending state before send can synchronously deliver a reply.
      try{this.send({type:"admit",acknowledgement:ack});}catch{this.requestStop();}
      return reply.promise;
    } catch(error){this.requestStop();return Promise.reject(error);}
  }
  private go():void {
    if(this.stopping || this.ended || this.terminal || this.stage!=="accepted") {this.requestStop();throw new Error("native provisioner GO denied");}
    this.stage="go_sent";
    try{this.send({type:"go"});}catch{this.requestStop();throw new Error("native provisioner GO delivery uncertain");}
  }
  private rejectPending(error:Error):void {
    const pending=this.pending;this.pending=undefined;if(pending){clearTimeout(pending.timer);pending.reject(error);}
  }
  private requestStop():void {
    this.stopping=true;this.rejectPending(new Error("native provisioner stopping"));this.failure.abort();
    this.beginDrain(this.terminal===undefined);
  }
  private beginDrain(sendStop:boolean):void {
    if(this.draining || this.ended)return;
    this.draining=true;
    // Terminal evidence forbids another wire command, not physical cleanup.
    // The transport owns a bounded grace/kill path even after a valid CLOSED.
    try{this.stop(sendStop);}catch{this.failure.abort();}
  }
  private protocolFailure():void {this.corrupt=true;this.evidence=undefined;this.requestStop();}
}
function exactRecord(value:unknown):Record<string,unknown>{return expectRecord(value,"native provisioner channel");}
function exact(value:unknown,keys:readonly string[]):Record<string,unknown>{
  const row=exactRecord(value);expectOnlyKeys(row,keys,"native provisioner channel");
  if(keys.some(key=>!Object.hasOwn(row,key)))throw new TypeError("all exact native channel fields required");return row;
}
function freeze<T>(value:T):T {
  if(value!==null && typeof value==="object"){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;
}
