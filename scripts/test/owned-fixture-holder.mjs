import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
const [directory,mode]=process.argv.slice(2);
if(!directory || !["hold","root-exit"].includes(mode)) throw new Error("exact owned fixture arguments required");
const child=spawn(process.execPath,["-e","setInterval(() => {},1000)"],{ stdio:"ignore",windowsHide:true,detached:true });
child.unref();
await writeFile(join(directory,"owned-pids.json"),JSON.stringify({ root:process.pid,child:child.pid }),{ flag:"wx" });
if(mode==="hold") setInterval(() => {},1000);
