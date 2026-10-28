import { createServer } from "node:http";
import { parentPort, workerData } from "node:worker_threads";
const signal = new Int32Array(workerData);
let idle;
const server = createServer((request, response) => {
  idle = request.socket;
  response.setHeader("Content-Type", "application/json");
  response.end("synthetic private package");
});
server.listen(0, "127.0.0.1", () => parentPort.postMessage(server.address().port));
parentPort.on("message", (message) => {
  if (message === "expire") {
    if (!idle) throw new Error("No owned warm socket");
    idle.once("close", () => {
      Atomics.store(signal, 0, 1);
      Atomics.notify(signal, 0);
    });
    server.closeIdleConnections();
  } else if (message === "close") {
    server.closeAllConnections();
    server.close(() => parentPort.close());
  }
});
