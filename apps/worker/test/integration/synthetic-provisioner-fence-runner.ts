import { spawn } from "node:child_process";
// Test-only tree with no filesystem, Git, database or provider work.
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true, detached: true });
child.unref();
process.stdout.write(JSON.stringify({ processId: process.pid, childId: child.pid }) + "\n");
setInterval(() => {}, 1000);
