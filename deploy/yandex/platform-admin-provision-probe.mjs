import { execFile } from "node:child_process";
import { promisify } from "node:util";
import process from "node:process";

const execFileAsync = promisify(execFile);
const CONTAINER_ID = /^[0-9a-f]{12,64}$/;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const CLI_PATH = "/app/dist/cli/provision-platform-admin.js";

class ProvisionStageError extends Error {
  constructor(stage) {
    super("platform admin provisioning failed");
    this.stage = stage;
  }
}

async function defaultRun(command, args) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      timeout: 30_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: Number.isSafeInteger(error?.code) ? error.code : 1,
      stdout: typeof error?.stdout === "string" ? error.stdout : "",
      stderr: typeof error?.stderr === "string" ? error.stderr : "",
    };
  }
}

function provisionEmail(value) {
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/.test(value)
  ) {
    throw new ProvisionStageError("configuration");
  }
  return value;
}

function parseState(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed?.Status === "running" && parsed?.Health?.Status === "healthy";
  } catch {
    return false;
  }
}

function parseProvisionResult(output) {
  if (
    typeof output !== "string" ||
    output.length > 1024 ||
    !output.endsWith("\n") ||
    output.indexOf("\n") !== output.length - 1
  ) {
    throw new ProvisionStageError("response");
  }
  let parsed;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    throw new ProvisionStageError("response");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(",") !== "deliveryId,userId" ||
    !IDENTIFIER.test(parsed.userId) ||
    !IDENTIFIER.test(parsed.deliveryId)
  ) {
    throw new ProvisionStageError("response");
  }
  return { userId: parsed.userId, deliveryId: parsed.deliveryId };
}

async function resolveApiContainer(run) {
  const result = await run("docker", [
    "ps",
    "-a",
    "--filter",
    "label=com.docker.compose.project=markiro-production",
    "--filter",
    "label=com.docker.compose.service=api",
    "--format",
    "{{.ID}}",
  ]);
  const ids = result.stdout
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  if (result.code !== 0 || ids.length !== 1 || !CONTAINER_ID.test(ids[0])) {
    throw new ProvisionStageError("container");
  }
  const id = ids[0];
  const inspected = await run("docker", ["inspect", "--format", "{{json .State}}", id]);
  if (inspected.code !== 0 || !parseState(inspected.stdout.trim())) {
    throw new ProvisionStageError("container");
  }
  return id;
}

export async function runPlatformAdminProvisionProbeCli(options = {}) {
  const environment = options.environment ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const run = options.dependencies?.run ?? defaultRun;
  try {
    if (environment.MARKIRO_PLATFORM_ADMIN_PROVISION_PROBE !== "1") {
      throw new ProvisionStageError("configuration");
    }
    const email = provisionEmail(environment.PLATFORM_ADMIN_EMAIL);
    const containerId = await resolveApiContainer(run);
    const cli = await run("docker", ["exec", containerId, "/usr/bin/test", "-f", CLI_PATH]);
    if (cli.code !== 0) throw new ProvisionStageError("cli");
    const provision = await run("docker", [
      "exec",
      containerId,
      "node",
      CLI_PATH,
      "--email",
      email,
    ]);
    if (provision.code !== 0) throw new ProvisionStageError("cli");
    const result = parseProvisionResult(provision.stdout);
    stdout.write(`MARKIRO_PLATFORM_ADMIN_PROVISIONED ${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const stage = error instanceof ProvisionStageError ? error.stage : "remote";
    stdout.write(`MARKIRO_PLATFORM_ADMIN_PROVISION_FAILURE ${stage}\n`);
    return 0;
  }
}

if (process.env.MARKIRO_PLATFORM_ADMIN_PROVISION_PROBE === "1") {
  process.exitCode = await runPlatformAdminProvisionProbeCli();
}
