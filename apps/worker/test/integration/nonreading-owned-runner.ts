// Deliberately never opens stdin: a large input must not stall supervision.
setInterval(() => {}, 1000);
