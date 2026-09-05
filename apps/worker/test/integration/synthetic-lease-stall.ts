import { probe,accept,type Frame } from "./native-lease-probe.ts";
const p=await probe("nonreading-owned-runner.ts",30000,(pid,purpose) => process.send?.({ pid,purpose }));
try {
  await accept(p,(await p.next("ready")).filesystemLeaseChallenge as Frame,1,1500);
  p.send({ type:"go",input:"{}" });
  process.send?.({ ready:true,rootPid:p.rootPid,bridgePid:p.bridge.pid });
  // No CPU spin, pipe closure, abort or daemon exit can prove the native guard.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,12000);
  await p.exited;
} finally { await p.close(); }
