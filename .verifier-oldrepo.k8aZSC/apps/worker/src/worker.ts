const intervalMs = 30_000;

console.log("worker placeholder started");

setInterval(() => {
  console.log(`worker heartbeat after ${intervalMs / 1000}s`);
}, intervalMs);
