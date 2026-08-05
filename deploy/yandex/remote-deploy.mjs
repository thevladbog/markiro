import { parseReleaseManifest } from "../production/release-manifest.mjs";
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";

import { isMainModule } from "./cli-main.mjs";

const API_PREFIX = "ghcr.io/thevladbog/markiro-api@";
const EDGE_PREFIX = "ghcr.io/thevladbog/markiro-edge@";

function requireFunction(dependencies, name) {
  if (typeof dependencies[name] !== "function")
    throw new Error(`missing deployment dependency: ${name}`);
}

function digest(image, prefix) {
  if (typeof image !== "string" || !image.startsWith(prefix))
    throw new Error("invalid release manifest");
  return image.slice(prefix.length);
}

async function recordFailure(dependencies, manifest, error) {
  try {
    await dependencies.writeRelease({
      api: manifest.api,
      commit: manifest.commit,
      edge: manifest.edge,
      error: error instanceof Error ? error.message : "deployment failed",
      releaseWorkflowRunId: manifest.workflowRunId,
      state: "failed",
    });
  } catch {
    // The primary deployment failure remains authoritative.
  }
}

export async function deployRelease(dependencies, manifestText) {
  for (const name of [
    "verifyInfrastructure",
    "verifyBackup",
    "withRunner",
    "readPreviousRelease",
    "transferBundle",
    "refreshRuntime",
    "preflight",
    "pullDigests",
    "migrate",
    "startApi",
    "startEdge",
    "verifyAlb",
    "smoke",
    "rollback",
    "writeRelease",
  ])
    requireFunction(dependencies, name);

  dependencies.onPhase?.("validate manifest");
  const manifest = parseReleaseManifest(manifestText, dependencies.expectedWorkflowRunId);
  if (manifest.commit !== dependencies.expectedCommit) throw new Error("invalid release manifest");
  const images = { api: manifest.api, edge: manifest.edge };
  const digests = {
    api: digest(manifest.api, API_PREFIX),
    edge: digest(manifest.edge, EDGE_PREFIX),
  };

  await dependencies.verifyInfrastructure({ commit: manifest.commit });
  await dependencies.verifyBackup({ commit: manifest.commit });

  return dependencies.withRunner(async (runner) => {
    const previous = await dependencies.readPreviousRelease();
    let switched = false;
    try {
      await dependencies.transferBundle({
        destination: `/opt/markiro/releases/${manifest.commit}`,
        sources: ["compose.production.yml", "deploy/production", "release-manifest.json"],
        transport: { internalAddress: true, kind: "yandex-os-login", staticKey: false },
      });
      const deployment = {
        commit: manifest.commit,
        digests,
        images,
        releaseWorkflowRunId: manifest.workflowRunId,
        runnerId: runner.id,
      };
      await dependencies.refreshRuntime(deployment);
      await dependencies.preflight(deployment);
      await dependencies.pullDigests(deployment);
      await dependencies.migrate(deployment);
      switched = true;
      await dependencies.startApi(deployment);
      await dependencies.startEdge(deployment);
      await dependencies.verifyAlb(deployment);
      await dependencies.smoke(deployment);
      const record = {
        api: manifest.api,
        commit: manifest.commit,
        edge: manifest.edge,
        releaseWorkflowRunId: manifest.workflowRunId,
        state: "healthy",
      };
      await dependencies.writeRelease(record);
      return record;
    } catch (error) {
      if (switched) {
        try {
          await dependencies.rollback({ api: previous.api, edge: previous.edge });
        } catch {
          // Rollback failure is recorded by the injected operational boundary.
        }
      }
      await recordFailure(dependencies, manifest, error);
      throw error;
    }
  });
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error("remote deployment configuration is incomplete");
  return value;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      shell: false,
      stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const stdout = [];
    let stdoutBytes = 0;
    child.stdout.on("data", (chunk) => {
      if (stdoutBytes >= 64 * 1024) return;
      const bounded = chunk.subarray(0, 64 * 1024 - stdoutBytes);
      stdout.push(bounded);
      stdoutBytes += bounded.length;
    });
    child.stderr.on("data", () => undefined);
    child.once("error", () => reject(new Error(`${command} failed`)));
    child.once("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(new Error(`${command} failed`));
    });
    if (options.input) child.stdin.end(options.input);
  });
}

async function streamArchive(tarArguments, sshArguments) {
  await new Promise((resolve, reject) => {
    const archive = spawn("tar", tarArguments, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const remote = spawn("ssh", sshArguments, {
      shell: false,
      stdio: [archive.stdout, "ignore", "pipe"],
    });
    archive.stderr.on("data", () => undefined);
    remote.stderr.on("data", () => undefined);
    let archiveCode;
    let remoteCode;
    const finish = () => {
      if (archiveCode === undefined || remoteCode === undefined) return;
      if (archiveCode === 0 && remoteCode === 0) resolve();
      else reject(new Error("private release transfer failed"));
    };
    archive.once("error", () => reject(new Error("private release transfer failed")));
    remote.once("error", () => reject(new Error("private release transfer failed")));
    archive.once("close", (code) => {
      archiveCode = code;
      finish();
    });
    remote.once("close", (code) => {
      remoteCode = code;
      finish();
    });
  });
}

async function metadataIamToken() {
  const response = await fetch(
    "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } },
  );
  if (!response.ok) throw new Error("runner identity request failed");
  const payload = await response.json();
  if (typeof payload.access_token !== "string" || payload.access_token.length === 0)
    throw new Error("runner identity request failed");
  return payload.access_token;
}

async function runRemoteDeployment() {
  const manifestPath = requiredEnvironment("RELEASE_MANIFEST_PATH");
  const expectedRunId = requiredEnvironment("EXPECTED_RELEASE_RUN_ID");
  const expectedCommit = requiredEnvironment("EXPECTED_RELEASE_SHA");
  const manifestText = await readFile(manifestPath, "utf8");
  const manifest = parseReleaseManifest(manifestText, expectedRunId);
  if (manifest.commit !== expectedCommit || process.cwd() === "/")
    throw new Error("invalid release manifest");

  const token = await metadataIamToken();
  const appInstanceId = requiredEnvironment("YC_APP_INSTANCE_ID");
  const login = requiredEnvironment("YC_OS_LOGIN");
  const organizationId = requiredEnvironment("YC_ORGANIZATION_ID");
  const instanceResponse = await fetch(
    `https://compute.api.cloud.yandex.net/compute/v1/instances/${appInstanceId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!instanceResponse.ok) throw new Error("application instance lookup failed");
  const instance = await instanceResponse.json();
  const address = instance.networkInterfaces?.[0]?.primaryV4Address?.address;
  if (typeof address !== "string" || instance.networkInterfaces?.[0]?.primaryV4Address?.oneToOneNat)
    throw new Error("application instance is not private");

  const credentialDirectory = await mkdtemp(join(tmpdir(), "markiro-os-login-"));
  const manifestDirectory = await mkdtemp(join(tmpdir(), "markiro-release-manifest-"));
  try {
    const ycEnvironment = { ...process.env, YC_TOKEN: token };
    await run(
      "yc",
      [
        "compute",
        "ssh",
        "certificate",
        "export",
        "--id",
        appInstanceId,
        "--internal-address",
        "--login",
        login,
        "--organization-id",
        organizationId,
        "--directory",
        credentialDirectory,
        "--no-user-output",
      ],
      { env: ycEnvironment },
    );
    const credentialFiles = await readdir(credentialDirectory);
    const identityName = credentialFiles.find(
      (name) => !name.endsWith("-cert.pub") && !name.endsWith(".pub"),
    );
    if (!identityName) throw new Error("OS Login certificate export failed");
    const identity = join(credentialDirectory, identityName);
    const certificate = `${identity}-cert.pub`;
    if (!credentialFiles.includes(`${identityName}-cert.pub`))
      throw new Error("OS Login certificate export failed");
    const knownHosts = join(credentialDirectory, "known_hosts");
    const target = `${login}@${address}`;
    const sshBase = [
      "-i",
      identity,
      "-o",
      `CertificateFile=${certificate}`,
      "-o",
      `UserKnownHostsFile=${knownHosts}`,
      "-o",
      "StrictHostKeyChecking=accept-new",
      target,
    ];
    const copiedManifest = join(manifestDirectory, "release-manifest.json");
    await copyFile(manifestPath, copiedManifest);
    const prefix = `releases/${manifest.commit}/`;
    await streamArchive(
      [
        "-cf",
        "-",
        `--transform=s,^,${prefix},`,
        "-C",
        process.cwd(),
        "compose.production.yml",
        "deploy/production",
        "-C",
        manifestDirectory,
        "release-manifest.json",
      ],
      [...sshBase, "sudo", "tar", "-xf", "-", "-C", "/opt/markiro", "--no-same-owner"],
    );
    await run("ssh", [...sshBase, "sudo", "systemctl", "restart", "markiro-runtime-env.service"]);
    const apiDigest = digest(manifest.api, API_PREFIX);
    const edgeDigest = digest(manifest.edge, EDGE_PREFIX);
    const releaseDirectory = `/opt/markiro/releases/${manifest.commit}`;
    await run("ssh", [
      ...sshBase,
      "sudo",
      "env",
      `MARKIRO_IMAGE_TAG=${manifest.commit}`,
      `MARKIRO_API_IMAGE_DIGEST=${apiDigest}`,
      `MARKIRO_EDGE_IMAGE_DIGEST=${edgeDigest}`,
      "MARKIRO_EDGE_MODE=behind-alb",
      "MARKIRO_ENV_FILE=/etc/markiro/production.env",
      "/usr/bin/bash",
      "-c",
      'cd "$1" && exec node deploy/production/deploy.mjs',
      "markiro-deploy",
      releaseDirectory,
    ]);
    const targets = await fetch(
      `https://alb.api.cloud.yandex.net/apploadbalancer/v1/loadBalancers/${requiredEnvironment("YC_LOAD_BALANCER_ID")}/targetStates/${requiredEnvironment("YC_BACKEND_GROUP_ID")}/${requiredEnvironment("YC_TARGET_GROUP_ID")}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const state = targets.ok ? await targets.json() : {};
    if (
      !state.targetStates?.some((targetState) =>
        targetState.status?.zoneStatuses?.some((zone) => zone.status === "HEALTHY"),
      )
    )
      throw new Error("production ALB gate failed");
  } finally {
    await rm(credentialDirectory, { recursive: true, force: true });
    await rm(manifestDirectory, { recursive: true, force: true });
  }
}

if (isMainModule(import.meta.url)) {
  if (process.argv[2] !== "run") {
    process.stderr.write("remote deployment failed\n");
    process.exitCode = 1;
  } else
    runRemoteDeployment().catch(() => {
      process.stderr.write("remote deployment failed\n");
      process.exitCode = 1;
    });
}
