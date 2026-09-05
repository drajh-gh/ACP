import { createWorkerFailureResult } from "@acp/domain";
import type { WorkerTransportRequest } from "../../src/worker-manager.ts";
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as WorkerTransportRequest;
process.stdout.write(JSON.stringify(createWorkerFailureResult({ runId: request.runId, packet: request.packet,
  attemptNumber: request.attemptNumber, status: "failed", code: "invalid_output",
  conclusion: "Synthetic supervised result; no model or external action.", wallMilliseconds: 1 })));
