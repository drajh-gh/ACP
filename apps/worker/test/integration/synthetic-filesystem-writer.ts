import { spawn } from "node:child_process";
import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Model-free fixture only: fixed filenames in the native root's disposable cwd.
// No arbitrary path, shell command, Git operation, credentials or network input.
// Independent fixture runaway bound, not evidence of lease-driven shutdown.
setTimeout(() => process.exit(77),15000);
function writeUntilStopped(role:"root"|"child") {
  let sequence=0;
  const append=() => appendFileSync(`acp-native-${role}-writes.log`,`${++sequence}\n`);
  append(); setInterval(append,100);
}

if(process.argv[2]==="--child") {
  process.once("message",(value) => {
    if(value!=="recorded") process.exit(78);
    process.disconnect(); writeUntilStopped("child");
  });
} else {
  const chunks:Buffer[]=[]; let bytes=0;
  for await(const chunk of process.stdin) {
    const value=Buffer.from(chunk as Uint8Array); bytes+=value.length;
    if(bytes>128) throw new Error("oversized synthetic writer request"); chunks.push(value);
  }
  const request=JSON.parse(Buffer.concat(chunks).toString("utf8")) as { mode:string };
  if(Object.keys(request).length!==1 || request.mode!=="start-disposable-writes") throw new Error("exact fixture request required");
  const child=spawn(process.execPath,["--experimental-strip-types",fileURLToPath(import.meta.url),"--child"],
    { stdio:["ignore","ignore","ignore","ipc"],windowsHide:true,detached:true });
  if(!child.pid) throw new Error("synthetic descendant not created");
  // Record before allowing either process to write the probe files. The outer
  // job owns cleanup; these PIDs are diagnostics, never PID-only kill authority.
  writeFileSync("acp-native-writer-pids.pending",JSON.stringify({ root:process.pid,child:child.pid }),{ flag:"wx" });
  renameSync("acp-native-writer-pids.pending","acp-native-writer-pids.json");
  child.on("error",() => process.exit(79));
  child.send("recorded"); child.unref(); writeUntilStopped("root");
}
