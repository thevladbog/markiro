import { parseReleaseManifest } from "../production/release-manifest.mjs";
import { validateProductionDomain } from "../production/production-domain.mjs";
import { productionBaseUrl, runPublicSmoke } from "../production/smoke.mjs";
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";

import { isMainModule } from "./cli-main.mjs";
import { parseAuthenticatedHostKeys } from "./runner-control.mjs";
import { writeMetrics } from "./monitoring-producer.mjs";
import { registryCredentials } from "./registry-auth.mjs";

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

function deploymentPhase(value) {
  if (value !== "first" && value !== "repeat") throw new Error("invalid deployment phase");
  return value;
}

export async function deployRelease(dependencies, manifestText) {
  for (const name of [
    "transferBundle",
    "refreshRuntime",
    "prepare",
    "verifyAlb",
    "finalize",
    "rollback",
  ])
    requireFunction(dependencies, name);
  const phase = deploymentPhase(dependencies.deploymentPhase || "repeat");
  requireFunction(dependencies, phase === "first" ? "preDnsSmoke" : "smoke");

  const manifest = parseReleaseManifest(manifestText, dependencies.expectedWorkflowRunId);
  if (manifest.commit !== dependencies.expectedCommit) throw new Error("invalid release manifest");
  await dependencies.transferBundle(manifest);
  await dependencies.refreshRuntime(manifest);
  let candidate;
  try {
    candidate = await dependencies.prepare(manifest);
    if (phase === "first" && candidate.previousTag !== null)
      throw new Error("first deployment already has a previous healthy release");
    if (phase === "repeat" && !candidate.previousTag)
      throw new Error("previous healthy release is unavailable for repeat deployment");
    await dependencies.verifyAlb(candidate);
    if (phase === "first") await dependencies.preDnsSmoke(candidate);
    else await dependencies.smoke(candidate);
    return await dependencies.finalize(candidate);
  } catch (error) {
    if (candidate)
      try {
        await dependencies.rollback(candidate);
      } catch (recoveryError) {
        throw new AggregateError(
          [error, recoveryError],
          error instanceof Error ? error.message : "deployment failed",
          { cause: error },
        );
      }
    throw error;
  }
}

function requiredEnvironment(name, environment = process.env) {
  const value = environment[name];
  if (!value) throw new Error("remote deployment configuration is incomplete");
  return value;
}

function requiredIpv4(name, environment) {
  const value = requiredEnvironment(name, environment);
  const octets = value.split(".");
  if (
    octets.length !== 4 ||
    octets.some((octet) => !/^(0|[1-9][0-9]{0,2})$/.test(octet) || Number(octet) > 255)
  )
    throw new Error("remote deployment configuration is incomplete");
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

async function metadataIamToken(fetchImpl = fetch) {
  const response = await fetchImpl(
    "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } },
  );
  if (!response.ok) throw new Error("runner identity request failed");
  const payload = await response.json();
  if (typeof payload.access_token !== "string" || payload.access_token.length === 0)
    throw new Error("runner identity request failed");
  return payload.access_token;
}

function authenticatedKnownHosts(encodedKeys, address) {
  const keys = parseAuthenticatedHostKeys(encodedKeys);
  return `${keys.map((key) => `${address} ${key}`).join("\n")}\n`;
}

function parseCandidate(output) {
  try {
    const candidate = JSON.parse(output);
    if (
      !candidate ||
      candidate.state !== "pending" ||
      !/^[0-9a-f]{40}$/.test(candidate.tag) ||
      !/^ghcr\.io\/thevladbog\/markiro-api@sha256:[0-9a-f]{64}$/.test(candidate.apiDigest) ||
      !/^ghcr\.io\/thevladbog\/markiro-edge@sha256:[0-9a-f]{64}$/.test(candidate.edgeDigest)
    )
      throw new Error();
    return candidate;
  } catch {
    throw new Error("remote deployment candidate is invalid");
  }
}

export async function runRemoteDeployment(environment = process.env, supplied = {}) {
  const system = {
    readFile,
    metadataIamToken,
    fetch,
    mkdtemp,
    readdir,
    copyFile,
    writeFile,
    rm,
    streamArchive,
    run,
    smoke: ({ baseUrl }) => runPublicSmoke({ baseUrl }),
    ...supplied,
  };
  const manifestPath = requiredEnvironment("RELEASE_MANIFEST_PATH", environment);
  const expectedRunId = requiredEnvironment("EXPECTED_RELEASE_RUN_ID", environment);
  const expectedCommit = requiredEnvironment("EXPECTED_RELEASE_SHA", environment);
  const phase = deploymentPhase(requiredEnvironment("MARKIRO_DEPLOYMENT_PHASE", environment));
  const domain = validateProductionDomain(environment.MARKIRO_DOMAIN);
  const manifestText = await system.readFile(manifestPath, "utf8");
  const manifest = parseReleaseManifest(manifestText, expectedRunId);
  if (manifest.commit !== expectedCommit || process.cwd() === "/")
    throw new Error("invalid release manifest");

  const token = await system.metadataIamToken(system.fetch);
  const registrySecretId = requiredEnvironment("YC_REGISTRY_SECRET_ID", environment);
  const registryResponse = await system.fetch(
    `https://payload.lockbox.api.cloud.yandex.net/lockbox/v1/secrets/${registrySecretId}/payload`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!registryResponse.ok) throw new Error("registry credential request failed");
  const registryPayload = await registryResponse.json();
  registryCredentials(registryPayload);
  const appInstanceId = requiredEnvironment("YC_APP_INSTANCE_ID", environment);
  const login = requiredEnvironment("YC_OS_LOGIN", environment);
  const organizationId = requiredEnvironment("YC_ORGANIZATION_ID", environment);
  const instanceResponse = await system.fetch(
    `https://compute.api.cloud.yandex.net/compute/v1/instances/${appInstanceId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!instanceResponse.ok) throw new Error("application instance lookup failed");
  const instance = await instanceResponse.json();
  const address = instance.networkInterfaces?.[0]?.primaryV4Address?.address;
  if (typeof address !== "string" || instance.networkInterfaces?.[0]?.primaryV4Address?.oneToOneNat)
    throw new Error("application instance is not private");

  const credentialDirectory = await system.mkdtemp(join(tmpdir(), "markiro-os-login-"));
  const manifestDirectory = await system.mkdtemp(join(tmpdir(), "markiro-release-manifest-"));
  try {
    await system.run(
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
      { env: { ...process.env, YC_TOKEN: token } },
    );
    const credentialFiles = await system.readdir(credentialDirectory);
    const identityName = credentialFiles.find(
      (name) => !name.endsWith("-cert.pub") && !name.endsWith(".pub"),
    );
    if (!identityName || !credentialFiles.includes(`${identityName}-cert.pub`))
      throw new Error("OS Login certificate export failed");
    const identity = join(credentialDirectory, identityName);
    const knownHosts = join(credentialDirectory, "known_hosts");
    await system.writeFile(
      knownHosts,
      authenticatedKnownHosts(requiredEnvironment("APP_SSH_HOST_KEYS_B64", environment), address),
      { encoding: "utf8", mode: 0o600 },
    );
    const sshBase = [
      "-i",
      identity,
      "-o",
      `CertificateFile=${identity}-cert.pub`,
      "-o",
      `UserKnownHostsFile=${knownHosts}`,
      "-o",
      "StrictHostKeyChecking=yes",
      `${login}@${address}`,
    ];
    const apiDigest = digest(manifest.api, API_PREFIX);
    const edgeDigest = digest(manifest.edge, EDGE_PREFIX);
    const releaseDirectory = `/opt/markiro/releases/${manifest.commit}`;
    const remoteStage = (stage, candidate) =>
      system.run(
        "ssh",
        [
          ...sshBase,
          "sudo",
          "/usr/bin/systemd-run",
          "--quiet",
          "--wait",
          "--pipe",
          "--collect",
          "--unit=markiro-deploy",
          "env",
          `MARKIRO_IMAGE_TAG=${manifest.commit}`,
          `MARKIRO_API_IMAGE_DIGEST=${apiDigest}`,
          `MARKIRO_EDGE_IMAGE_DIGEST=${edgeDigest}`,
          `MARKIRO_DOMAIN=${domain}`,
          "MARKIRO_EDGE_MODE=behind-alb",
          `MARKIRO_REQUIRE_PREVIOUS_HEALTHY=${phase === "repeat" ? "1" : "0"}`,
          "MARKIRO_ENV_FILE=/etc/markiro/production.env",
          "MARKIRO_RELEASE_DIRECTORY=/var/lib/markiro/releases",
          "/usr/bin/bash",
          "-c",
          'cd "$1" && exec /usr/bin/node /usr/local/lib/markiro/registry-auth.mjs run-stdin /usr/bin/node deploy/production/deploy.mjs "$2"',
          "markiro-deploy",
          releaseDirectory,
          stage,
        ],
        {
          input: `${JSON.stringify({
            entries: registryPayload.entries,
            ...(candidate ? { commandInput: `${JSON.stringify(candidate)}\n` } : {}),
          })}\n`,
        },
      );

    return await deployRelease(
      {
        expectedWorkflowRunId: expectedRunId,
        expectedCommit,
        async transferBundle() {
          const copiedManifest = join(manifestDirectory, "release-manifest.json");
          await system.copyFile(manifestPath, copiedManifest);
          const prefix = `releases/${manifest.commit}/`;
          await system.streamArchive(
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
        },
        refreshRuntime: () =>
          system.run("ssh", [
            ...sshBase,
            "sudo",
            "systemctl",
            "restart",
            "markiro-runtime-env.service",
          ]),
        async prepare() {
          return parseCandidate(await remoteStage("prepare"));
        },
        async verifyAlb() {
          const targets = await system.fetch(
            `https://alb.api.cloud.yandex.net/apploadbalancer/v1/loadBalancers/${requiredEnvironment("YC_LOAD_BALANCER_ID", environment)}/targetStates/${requiredEnvironment("YC_BACKEND_GROUP_ID", environment)}/${requiredEnvironment("YC_TARGET_GROUP_ID", environment)}`,
            { headers: { Authorization: `Bearer ${token}` } },
          );
          const state = targets.ok ? await targets.json() : {};
          if (
            !state.targetStates?.some((targetState) =>
              targetState.status?.zoneStatuses?.some((zone) => zone.status === "HEALTHY"),
            )
          )
            throw new Error("production ALB gate failed");
        },
        deploymentPhase: phase,
        preDnsSmoke: async () => {
          const address = requiredIpv4("YC_LOAD_BALANCER_ADDRESS", environment);
          await system.run("ssh", [
            ...sshBase,
            "curl",
            "--fail",
            "--silent",
            "--show-error",
            "--max-time",
            "30",
            "-H",
            `Host: ${domain}`,
            "http://127.0.0.1:8080/health/ready",
          ]);
          await system.run("curl", [
            "--fail",
            "--silent",
            "--show-error",
            "--max-time",
            "30",
            "--resolve",
            `${domain}:443:${address}`,
            `https://${domain}/health/ready`,
          ]);
        },
        smoke: () =>
          system.smoke({
            baseUrl: productionBaseUrl({
              MARKIRO_DOMAIN: domain,
              MARKIRO_HTTPS_PORT: environment.MARKIRO_HTTPS_PORT,
            }),
          }),
        async finalize(candidate) {
          return JSON.parse(await remoteStage("finalize", candidate));
        },
        async rollback(candidate) {
          return JSON.parse(await remoteStage("rollback", candidate));
        },
      },
      manifestText,
    );
  } finally {
    await system.rm(credentialDirectory, { recursive: true, force: true });
    await system.rm(manifestDirectory, { recursive: true, force: true });
  }
}

export async function runRemoteDeploymentWithReporting(
  environment = process.env,
  supplied = {},
  reporting = {},
) {
  const runDeployment = reporting.runDeployment ?? runRemoteDeployment;
  const getToken = reporting.metadataIamToken ?? metadataIamToken;
  const emit = reporting.writeMetrics ?? writeMetrics;
  const folderId = requiredEnvironment("MARKIRO_FOLDER_ID", environment);
  const appInstanceId = requiredEnvironment("YC_APP_INSTANCE_ID", environment);
  let result;
  let primaryError;
  try {
    result = await runDeployment(environment, supplied);
  } catch (error) {
    primaryError = error;
  }
  try {
    const token = await getToken();
    await emit({
      folderId,
      iamToken: token,
      metrics: [
        {
          name: "markiro.deployment.failure",
          labels: { resource_id: appInstanceId },
          type: "DGAUGE",
          value: primaryError ? 1 : 0,
        },
      ],
    });
  } catch (reportingError) {
    if (!primaryError) throw reportingError;
  }
  if (primaryError) throw primaryError;
  return result;
}

if (isMainModule(import.meta.url)) {
  if (process.argv[2] !== "run") {
    process.stderr.write("remote deployment failed\n");
    process.exitCode = 1;
  } else
    runRemoteDeploymentWithReporting().catch(() => {
      process.stderr.write("remote deployment failed\n");
      process.exitCode = 1;
    });
}
