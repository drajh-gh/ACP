import { spawn } from "node:child_process";
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { mode?: string; text?: string };
if (input.mode === "hold") setInterval(() => {}, 1000);
else if (input.mode === "overflow") process.stdout.write("x".repeat(65536));
else {
  const child = input.mode === "descendant" ? spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
    { stdio: "ignore", windowsHide: true, detached: true }) : undefined;
  child?.unref();
  process.stdout.write(JSON.stringify({ processId: process.pid, childId: child?.pid, text: input.text,
    leaked: process.env.ACP_TEST_SECRET !== undefined || process.env.NODE_OPTIONS !== undefined }));
}
