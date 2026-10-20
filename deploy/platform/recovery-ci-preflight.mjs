import { join } from "node:path";
import { runHostProcess } from "./host/process.mjs";
/** Safety gate for the disposable Linux recovery integration harness only. */
export function validateRecoveryCiHost(value) {
  const names = (values) =>
    Array.isArray(values) && values.every((name) => typeof name === "string" && name.length > 0);
  const accepted =
    value?.argv?.length === 1 &&
    value.argv[0] === "--local-ci" &&
    value.platform === "linux" &&
    value.arch === "x64" &&
    value.endpoint === "unix:///var/run/docker.sock" &&
    value.executable === "/usr/bin/docker" &&
    value.info?.OSType === "linux" &&
    ["x86_64", "amd64"].includes(value.info.Architecture) &&
    typeof value.info.ID === "string" &&
    value.info.ID.length > 0 &&
    names(value.containers) &&
    value.containers.length === 0 &&
    names(value.volumes) &&
    value.volumes.length === 0 &&
    names(value.networks) &&
    value.networks.length === 3 &&
    ["bridge", "host", "none"].every((name) => value.networks.includes(name));
  if (!accepted) {
    const error = new Error(
      "Recovery integration requires an empty disposable local Linux Docker host.",
    );
    error.code = "ERR_RECOVERY_CI_HOST";
    throw error;
  }
  return value.info.ID;
}

// Test injection is trusted local code; the CLI never accepts observations or
// executable/endpoint overrides from arguments or inherited Docker variables.
export async function inspectRecoveryCiHost(
  { root, argv },
  { runProcess = runHostProcess, platform = process.platform, arch = process.arch } = {},
) {
  try {
    if (platform !== "linux" || arch !== "x64" || argv.length !== 1 || argv[0] !== "--local-ci")
      throw new Error("Unsupported harness invocation");
    const endpoint = "unix:///var/run/docker.sock";
    const executable = "/usr/bin/docker";
    const command = async (args) =>
      (
        await runProcess({
          executable,
          args: ["--host", endpoint, ...args],
          cwd: root,
          env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", DOCKER_CONFIG: join(root, "docker") },
          timeoutMs: 10000,
          outputLimitBytes: 1048576,
        })
      ).stdout;
    const rows = (text) => String(text).trim().split("\n").filter(Boolean);
    const info = JSON.parse(await command(["info", "--format", "{{json .}}"]));
    const containers = rows(await command(["container", "ls", "--all", "--quiet", "--no-trunc"]));
    const volumes = rows(await command(["volume", "ls", "--format", "{{.Name}}"]));
    const networks = rows(await command(["network", "ls", "--format", "{{.Name}}"]));
    const identity = validateRecoveryCiHost({
      argv,
      platform,
      arch,
      endpoint,
      executable,
      info,
      containers,
      volumes,
      networks,
    });
    const finalInfo = JSON.parse(await command(["info", "--format", "{{json .}}"]));
    if (
      validateRecoveryCiHost({
        argv,
        platform,
        arch,
        endpoint,
        executable,
        info: finalInfo,
        containers,
        volumes,
        networks,
      }) !== identity
    )
      throw new Error("Daemon changed");
    return identity;
  } catch {
    const error = new Error("Recovery integration host inspection failed.");
    error.code = "ERR_RECOVERY_CI_HOST";
    throw error;
  }
}
