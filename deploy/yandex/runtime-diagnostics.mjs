import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { isMainModule } from "./cli-main.mjs";
import {
  authenticatedKnownHosts,
  publicIpv4,
  runCommand,
  validateHostedPrivateKey,
} from "./remote-deploy.mjs";
import { validateRuntimeSnapshot } from "./runtime-diagnostics-probe.mjs";

const MAX_REMOTE_DIAGNOSTIC_BYTES = 16 * 1024;

function requiredEnvironment(name, environment) {
  const value = environment[name];
  if (!value) throw new Error("runtime diagnostic configuration is incomplete");
  return value;
}

function parseRemoteResponse(output) {
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > MAX_REMOTE_DIAGNOSTIC_BYTES)
    throw new Error("runtime diagnostic response is invalid");
  const match = output.match(/^MARKIRO_RUNTIME_DIAGNOSTICS (\{[^\n]+\})\n$/);
  if (!match) throw new Error("runtime diagnostic response is invalid");
  try {
    return validateRuntimeSnapshot(JSON.parse(match[1]));
  } catch {
    throw new Error("runtime diagnostic response is invalid");
  }
}

export async function runHostedRuntimeDiagnostics(environment = process.env, supplied = {}) {
  const system = {
    mkdtemp,
    writeFile,
    rm,
    validatePrivateKey: (path) => validateHostedPrivateKey(path, { readFile, stat }),
    readProbe: () => readFile(new URL("./runtime-diagnostics-probe.mjs", import.meta.url), "utf8"),
    run: (command, args, options) => runCommand(command, args, options),
    ...supplied,
  };
  const address = publicIpv4(requiredEnvironment("YC_APP_PUBLIC_ADDRESS", environment));
  const login = requiredEnvironment("YC_APP_DEPLOY_LOGIN", environment);
  if (login !== "markiro-deploy") throw new Error("runtime diagnostic configuration is incomplete");
  const identity = requiredEnvironment("YC_APP_DEPLOY_SSH_PRIVATE_KEY_PATH", environment);
  const knownHosts = authenticatedKnownHosts(
    requiredEnvironment("APP_SSH_HOST_KEYS_B64", environment),
    address,
  );
  await system.validatePrivateKey(identity);
  const directory = await system.mkdtemp(join(tmpdir(), "markiro-runtime-diagnostics-"));
  let failure;
  let result;
  try {
    const knownHostsPath = join(directory, "known_hosts");
    await system.writeFile(knownHostsPath, knownHosts, { encoding: "utf8", mode: 0o600 });
    const probe = await system.readProbe();
    const output = await system.run(
      "ssh",
      [
        "-i",
        identity,
        "-o",
        `UserKnownHostsFile=${knownHostsPath}`,
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=15",
        `${login}@${address}`,
        "sudo",
        "/usr/bin/env",
        "MARKIRO_RUNTIME_DIAGNOSTICS_PROBE=1",
        "/usr/bin/node",
        "--input-type=module",
        "-",
      ],
      { input: probe },
    );
    result = parseRemoteResponse(output);
  } catch (error) {
    failure = error;
  }
  let cleanupFailure;
  try {
    await system.rm(directory, { recursive: true, force: true });
  } catch (error) {
    cleanupFailure = error;
  }
  if (failure) throw failure;
  if (cleanupFailure) throw cleanupFailure;
  return result;
}

export async function runRuntimeDiagnosticsCli(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  try {
    const argv = options.argv ?? process.argv.slice(2);
    if (argv.length !== 1 || argv[0] !== "run") throw new Error();
    const snapshot = await (options.runDiagnostics ?? runHostedRuntimeDiagnostics)(
      options.environment ?? process.env,
      options.supplied ?? {},
    );
    stdout.write(`MARKIRO_RUNTIME_DIAGNOSTICS ${JSON.stringify(snapshot)}\n`);
    return 0;
  } catch {
    stderr.write("MARKIRO_RUNTIME_DIAGNOSTICS_FAILURE\n");
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runRuntimeDiagnosticsCli();
}
