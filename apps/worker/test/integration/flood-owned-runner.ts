// Deliberately fill stdout while the synthetic parent stops draining it.
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write("x".repeat(1048576)));
