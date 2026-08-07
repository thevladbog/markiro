import { spawn } from "node:child_process";
import process from "node:process";

import { isMainModule } from "./cli-main.mjs";

const DEFAULT_ENGINE_VERSION = "28.5.2";
const DEFAULT_COMPOSE_VERSION = "2.40.3";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "ignore"] });
    const output = [];
    let bytes = 0;
    child.stdout.on("data", (chunk) => {
      if (bytes >= 4096) return;
      const bounded = chunk.subarray(0, 4096 - bytes);
      output.push(bounded);
      bytes += bounded.length;
    });
    child.once("error", () => reject(new Error("container runtime contract failed")));
    child.once("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(output).toString("utf8"))
        : reject(new Error("container runtime contract failed")),
    );
  });
}

export async function verifyContainerRuntime({
  engineVersion = DEFAULT_ENGINE_VERSION,
  composeVersion = DEFAULT_COMPOSE_VERSION,
  run: runCommand = run,
} = {}) {
  try {
    const actualEngine = (
      await runCommand("docker", ["version", "--format", "{{.Server.Version}}"])
    ).trim();
    if (actualEngine !== engineVersion) throw new Error();
    const actualCompose = (await runCommand("docker", ["compose", "version", "--short"])).trim();
    if (actualCompose !== composeVersion) throw new Error();
    await runCommand("docker", [
      "compose",
      "--env-file",
      "/etc/markiro/compose-contract.env",
      "-f",
      "/opt/markiro/compose.production.yml",
      "config",
      "--quiet",
    ]);
  } catch {
    throw new Error("container runtime contract failed");
  }
}

if (isMainModule(import.meta.url))
  verifyContainerRuntime().catch(() => {
    process.stderr.write("container runtime contract failed\n");
    process.exitCode = 1;
  });
