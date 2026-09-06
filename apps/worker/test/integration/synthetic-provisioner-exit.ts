// Model-free fixed exit fixture; consume the fixed input before exiting.
for await (const _chunk of process.stdin) { /* Drain only. */ }
process.exit(23);
