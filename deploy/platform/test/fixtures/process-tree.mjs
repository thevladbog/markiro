import { spawn } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";

// All executable source is static; the socket path is passed only as argv data.
const [mode, socketPath] = process.argv.slice(2);
const fixture = fileURLToPath(import.meta.url);
if (mode === "exiting-parent") {
  const child = spawn(process.execPath, [fixture, "ipc-child", socketPath], {
    env: {},
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  child.once("message", () => {
    child.disconnect();
    child.unref();
  });
} else {
  if (!["wait", "tree", "ignore-term", "ipc-child"].includes(mode)) {
    throw new Error("Unknown process tree fixture mode.");
  }
  if (mode === "tree" || mode === "ignore-term") process.on("SIGTERM", () => {});
  const socket = connect(socketPath, () => {
    socket.write(`${process.pid}\n`);
    if (mode === "ipc-child") process.send("ready");
  });
  if (mode === "tree") {
    spawn(process.execPath, [fixture, "ignore-term", socketPath], {
      env: {},
      stdio: "ignore",
    });
  }
  setInterval(() => {}, 1000);
}
