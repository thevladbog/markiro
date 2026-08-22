import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import process from "node:process";

import { isMainModule } from "./cli-main.mjs";

export function registryCredentials(payload) {
  if (!Array.isArray(payload?.entries) || payload.entries.length !== 2)
    throw new Error("registry credential payload is invalid");
  const values = Object.fromEntries(payload.entries.map((entry) => [entry?.key, entry?.textValue]));
  if (
    Object.keys(values).sort().join(",") !== "GHCR_TOKEN,GHCR_USERNAME" ||
    typeof values.GHCR_USERNAME !== "string" ||
    values.GHCR_USERNAME.length === 0 ||
    typeof values.GHCR_TOKEN !== "string" ||
    values.GHCR_TOKEN.length === 0
  )
    throw new Error("registry credential payload is invalid");
  return values;
}

export function parseRegistryEnvelope(value) {
  try {
    if (typeof value !== "string" || Buffer.byteLength(value) > 512 * 1024) throw new Error();
    const parsed = JSON.parse(value);
    if (
      !parsed ||
      !Array.isArray(parsed.entries) ||
      (parsed.commandInput !== undefined &&
        (typeof parsed.commandInput !== "string" ||
          Buffer.byteLength(parsed.commandInput) > 64 * 1024)) ||
      Object.keys(parsed).sort().join(",") !==
        (parsed.commandInput === undefined ? "entries" : "commandInput,entries")
    )
      throw new Error();
    registryCredentials({ entries: parsed.entries });
    return { payload: { entries: parsed.entries }, commandInput: parsed.commandInput };
  } catch {
    throw new Error("registry credential envelope is invalid");
  }
}

const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const VBTECH_DEPLOYMENT_STAGES = [
  "configuration",
  "validation",
  "active-markiro",
  "vbtech-state",
  "pending",
  "pull",
  "candidate-digest",
  "candidate-service",
  "candidate-health",
  "edge-activation",
  "private-smoke",
  "healthy",
];
const VBTECH_ROLLBACK_STAGES = [
  "rollback-service",
  "rollback-health",
  "rollback-edge",
  "rollback-readiness",
  "rollback-smoke",
  "failed-record",
];
const VBTECH_FAILURE_REPORT = new RegExp(
  `^MARKIRO_VBTECH_DEPLOY_FAILURE (?:${VBTECH_DEPLOYMENT_STAGES.join("|")})(?: ROLLBACK (?:${VBTECH_ROLLBACK_STAGES.join("|")}))?\\n$`,
);

function run(command, args, { input, environment = process.env, captureOutput = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: environment,
      shell: false,
      stdio: [
        input === undefined ? "ignore" : "pipe",
        captureOutput ? "pipe" : "ignore",
        captureOutput ? "pipe" : "ignore",
      ],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputExceeded = false;
    child.stdout?.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_COMMAND_OUTPUT_BYTES) outputExceeded = true;
      else stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_COMMAND_OUTPUT_BYTES) outputExceeded = true;
      else stderr.push(chunk);
    });
    child.once("error", () => reject(new Error("registry authentication command failed")));
    child.once("close", (code) =>
      resolve({
        code: outputExceeded ? 1 : (code ?? 1),
        stdout: captureOutput && !outputExceeded ? Buffer.concat(stdout).toString("utf8") : "",
        stderr: captureOutput && !outputExceeded ? Buffer.concat(stderr).toString("utf8") : "",
      }),
    );
    if (input !== undefined) child.stdin.end(input);
  });
}

async function readStandardInput() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 512 * 1024) throw new Error("registry credential envelope is invalid");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function withRegistryAuthentication(supplied, command, commandInput, options = {}) {
  const dependencies = {
    makeDirectory: () => mkdtemp("/run/markiro-registry-auth/session-"),
    run,
    remove: (path) => rm(path, { recursive: true, force: true }),
    ...supplied,
  };
  if (typeof dependencies.getPayload !== "function")
    throw new Error("registry credential payload is required");
  if (!Array.isArray(command) || command.length === 0)
    throw new Error("registry authentication command is required");
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => key !== "allowVbtechFailureReport") ||
    (options.allowVbtechFailureReport !== undefined &&
      typeof options.allowVbtechFailureReport !== "boolean")
  )
    throw new Error("registry authentication options are invalid");
  const credentials = registryCredentials(await dependencies.getPayload());
  const dockerConfig = await dependencies.makeDirectory();
  let primaryError;
  try {
    const login = await dependencies.run(
      "docker",
      ["login", "ghcr.io", "--username", credentials.GHCR_USERNAME, "--password-stdin"],
      {
        input: credentials.GHCR_TOKEN,
        environment: { ...process.env, DOCKER_CONFIG: dockerConfig },
      },
    );
    if (login.code !== 0) throw new Error("registry authentication failed");
    const result = await dependencies.run(command[0], command.slice(1), {
      environment: { ...process.env, DOCKER_CONFIG: dockerConfig },
      input: commandInput,
      captureOutput: true,
    });
    if (result.code !== 0) {
      if (
        options.allowVbtechFailureReport === true &&
        result.stdout === "" &&
        typeof result.stderr === "string" &&
        VBTECH_FAILURE_REPORT.test(result.stderr)
      )
        return result.stderr;
      throw new Error("deployment command failed");
    }
    if (
      typeof result.stdout !== "string" ||
      Buffer.byteLength(result.stdout, "utf8") > MAX_COMMAND_OUTPUT_BYTES
    )
      throw new Error("deployment command output is invalid");
    return result.stdout;
  } catch (error) {
    primaryError = error;
  } finally {
    await dependencies
      .run("docker", ["logout", "ghcr.io"], {
        environment: { ...process.env, DOCKER_CONFIG: dockerConfig },
      })
      .catch(() => undefined);
    await dependencies.remove(dockerConfig);
  }
  if (primaryError) throw primaryError;
}

if (isMainModule(import.meta.url)) {
  const mode = process.argv[2];
  if (!["run-stdin", "run-stdin-vbtech-report"].includes(mode)) {
    process.stderr.write("registry authentication failed\n");
    process.exitCode = 1;
  } else
    readStandardInput()
      .then(parseRegistryEnvelope)
      .then(({ payload, commandInput }) =>
        withRegistryAuthentication(
          { getPayload: async () => payload },
          process.argv.slice(3),
          commandInput,
          { allowVbtechFailureReport: mode === "run-stdin-vbtech-report" },
        ),
      )
      .then((output) => process.stdout.write(output))
      .catch(() => {
        process.stderr.write("registry authentication failed\n");
        process.exitCode = 1;
      });
}
