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

const PROVISION_STAGES = new Set(["configuration", "container", "cli", "response", "remote"]);

class PlatformAdminProvisionStageError extends Error {
  constructor(stage) {
    super("platform admin provisioning failed");
    this.stage = PROVISION_STAGES.has(stage) ? stage : "remote";
  }
}

function requiredEnvironment(name, environment) {
  const value = environment[name];
  if (!value) throw new Error("platform admin provisioning configuration is invalid");
  return value;
}

export function provisionEmail(value) {
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/.test(value)
  ) {
    throw new Error("platform admin provisioning configuration is invalid");
  }
  return value;
}

function boundedIdentifier(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error("platform admin provisioning response is invalid");
  }
  return value;
}

export function parseProvisionResult(output) {
  if (
    typeof output !== "string" ||
    !output.endsWith("\n") ||
    output.indexOf("\n") !== output.length - 1
  ) {
    throw new Error("platform admin provisioning response is invalid");
  }
  let parsed;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    throw new Error("platform admin provisioning response is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("platform admin provisioning response is invalid");
  }
  const keys = Object.keys(parsed).sort();
  if (keys.length !== 2 || keys[0] !== "deliveryId" || keys[1] !== "userId") {
    throw new Error("platform admin provisioning response is invalid");
  }
  return {
    userId: boundedIdentifier(parsed.userId),
    deliveryId: boundedIdentifier(parsed.deliveryId),
  };
}

function parseRemoteProvisionResponse(output) {
  const match = output.match(/^MARKIRO_PLATFORM_ADMIN_PROVISIONED (\{[^\n]+\})\n$/);
  if (!match) {
    const failure = output.match(
      /^MARKIRO_PLATFORM_ADMIN_PROVISION_FAILURE (configuration|container|cli|response|remote)\n$/,
    );
    throw new PlatformAdminProvisionStageError(failure?.[1] ?? "response");
  }
  try {
    return parseProvisionResult(`${match[1]}\n`);
  } catch {
    throw new PlatformAdminProvisionStageError("response");
  }
}

export async function runHostedPlatformAdminProvision(environment = process.env, supplied = {}) {
  const system = {
    mkdtemp,
    writeFile,
    rm,
    validatePrivateKey: (path) => validateHostedPrivateKey(path, { readFile, stat }),
    readProbe: () =>
      readFile(new URL("./platform-admin-provision-probe.mjs", import.meta.url), "utf8"),
    run: (command, args, options) => runCommand(command, args, options),
    ...supplied,
  };
  const email = provisionEmail(requiredEnvironment("PLATFORM_ADMIN_EMAIL", environment));
  const address = publicIpv4(requiredEnvironment("YC_APP_PUBLIC_ADDRESS", environment));
  const login = requiredEnvironment("YC_APP_DEPLOY_LOGIN", environment);
  if (login !== "markiro-deploy") {
    throw new Error("platform admin provisioning configuration is invalid");
  }
  const identity = requiredEnvironment("YC_APP_DEPLOY_SSH_PRIVATE_KEY_PATH", environment);
  const knownHosts = authenticatedKnownHosts(
    requiredEnvironment("APP_SSH_HOST_KEYS_B64", environment),
    address,
  );
  await system.validatePrivateKey(identity);

  const directory = await system.mkdtemp(join(tmpdir(), "markiro-platform-admin-provision-"));
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
        "MARKIRO_PLATFORM_ADMIN_PROVISION_PROBE=1",
        `PLATFORM_ADMIN_EMAIL=${email}`,
        "/usr/bin/node",
        "--input-type=module",
        "-",
      ],
      { input: probe },
    );
    result = parseRemoteProvisionResponse(output);
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

export async function runPlatformAdminProvisionCli(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  try {
    const argv = options.argv ?? process.argv.slice(2);
    if (argv.length !== 1 || argv[0] !== "run") {
      throw new PlatformAdminProvisionStageError("configuration");
    }
    const result = await (options.runProvision ?? runHostedPlatformAdminProvision)(
      options.environment ?? process.env,
      options.supplied ?? {},
    );
    stdout.write(`MARKIRO_PLATFORM_ADMIN_PROVISIONED ${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const stage =
      error instanceof PlatformAdminProvisionStageError
        ? error.stage
        : error instanceof Error && error.message.includes("configuration")
          ? "configuration"
          : "remote";
    stderr.write(`MARKIRO_PLATFORM_ADMIN_PROVISION_FAILURE ${stage}\n`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runPlatformAdminProvisionCli();
}
