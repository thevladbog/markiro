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
const ALB_TARGET_TIMEOUT_MS = 180_000;
const ALB_TARGET_INITIAL_BACKOFF_MS = 1_000;
const ALB_TARGET_MAX_BACKOFF_MS = 10_000;

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

function positiveMilliseconds(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function targetAddress(targetState) {
  const address = targetState?.target?.address;
  return typeof address === "string" && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(address) ? address : null;
}

function albTargetCause(payload, expectedAddress) {
  if (!payload || !Array.isArray(payload.targetStates)) return "malformed target response";
  const target = payload.targetStates.find(
    (targetState) => targetAddress(targetState) === expectedAddress,
  );
  if (!target) return "expected target unavailable";
  const zones = target.status?.zoneStatuses;
  if (!Array.isArray(zones)) return "malformed target response";
  if (zones.some((zone) => zone?.status === "HEALTHY")) return null;
  return "expected target is not healthy";
}

/**
 * Wait only for the app VM's exact private target identity. The provider can
 * report healthy stale targets while the newly prepared candidate is absent.
 */
export async function waitForAlbTarget({
  expectedAddress,
  fetchTargetStates,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  monotonicNow = () => performance.now(),
  timeoutMs = ALB_TARGET_TIMEOUT_MS,
  initialBackoffMs = ALB_TARGET_INITIAL_BACKOFF_MS,
  maxBackoffMs = ALB_TARGET_MAX_BACKOFF_MS,
}) {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(expectedAddress))
    throw new Error("production ALB gate failed");
  const deadline = positiveMilliseconds(timeoutMs, ALB_TARGET_TIMEOUT_MS);
  const initialBackoff = positiveMilliseconds(initialBackoffMs, ALB_TARGET_INITIAL_BACKOFF_MS);
  const maxBackoff = Math.max(
    initialBackoff,
    positiveMilliseconds(maxBackoffMs, ALB_TARGET_MAX_BACKOFF_MS),
  );
  const startedAt = monotonicNow();
  let delay = initialBackoff;
  let lastCause = "no target response";

  while (true) {
    const remaining = deadline - (monotonicNow() - startedAt);
    if (remaining <= 0) break;
    try {
      const payload = await fetchTargetStates({
        signal: AbortSignal.timeout(Math.max(1, Math.floor(remaining))),
      });
      const cause = albTargetCause(payload, expectedAddress);
      if (cause === null) return;
      lastCause = cause;
    } catch {
      lastCause = "target-state request failed";
    }
    const remainingAfterRequest = deadline - (monotonicNow() - startedAt);
    if (remainingAfterRequest <= 0) break;
    const pause = Math.min(delay, remainingAfterRequest);
    await sleep(pause);
    delay = Math.min(maxBackoff, delay * 2);
  }
  throw new Error(`production ALB gate failed after ${deadline}ms (last cause: ${lastCause})`);
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
  if (dependencies.rollbackRehearsal && phase !== "first")
    throw new Error("rollback rehearsal requires a first deployment");

  const manifest = parseReleaseManifest(manifestText, dependencies.expectedWorkflowRunId);
  if (manifest.commit !== dependencies.expectedCommit) throw new Error("invalid release manifest");
  await dependencies.transferBundle(manifest);
  await dependencies.refreshRuntime(manifest);
  let candidate;
  let rollbackAttempted = false;
  try {
    candidate = await dependencies.prepare(manifest);
    if (phase === "first" && candidate.previousTag !== null)
      throw new Error("first deployment already has a previous healthy release");
    if (phase === "repeat" && !candidate.previousTag)
      throw new Error("previous healthy release is unavailable for repeat deployment");
    await dependencies.verifyAlb(candidate);
    if (phase === "first") await dependencies.preDnsSmoke(candidate);
    else await dependencies.smoke(candidate);
    if (dependencies.rollbackRehearsal) {
      rollbackAttempted = true;
      const failed = await dependencies.rollback(candidate);
      if (failed?.state !== "failed" || candidate.previousTag !== null)
        throw new Error("rollback rehearsal recovery failed");
      return { state: "rehearsed", tag: candidate.tag };
    }
    return await dependencies.finalize(candidate);
  } catch (error) {
    if (candidate && !rollbackAttempted)
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

function assertExpectedReleaseHeader(headers, expectedReleaseSha) {
  const matches = String(headers).match(/^x-markiro-release-sha:\s*([^\r\n]+)$/gim);
  const value = matches
    ?.at(-1)
    ?.replace(/^x-markiro-release-sha:\s*/i, "")
    .trim();
  if (value !== expectedReleaseSha)
    throw new Error("live release identity does not match the expected release");
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
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    monotonicNow: () => performance.now(),
    smoke: ({ baseUrl, expectedReleaseSha }) => runPublicSmoke({ baseUrl, expectedReleaseSha }),
    ...supplied,
  };
  const manifestPath = requiredEnvironment("RELEASE_MANIFEST_PATH", environment);
  const expectedRunId = requiredEnvironment("EXPECTED_RELEASE_RUN_ID", environment);
  const expectedCommit = requiredEnvironment("EXPECTED_RELEASE_SHA", environment);
  const phase = deploymentPhase(requiredEnvironment("MARKIRO_DEPLOYMENT_PHASE", environment));
  const rollbackRehearsal = environment.MARKIRO_ROLLBACK_REHEARSAL === "1";
  if (rollbackRehearsal && phase !== "first")
    throw new Error("rollback rehearsal requires a first deployment");
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
          "MARKIRO_COMPOSE_PROJECT=markiro-production",
          `MARKIRO_DOMAIN=${domain}`,
          "MARKIRO_EDGE_MODE=behind-alb",
          `MARKIRO_REQUIRE_PREVIOUS_HEALTHY=${phase === "repeat" ? "1" : "0"}`,
          `MARKIRO_REQUIRE_NO_PREVIOUS_HEALTHY=${phase === "first" ? "1" : "0"}`,
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

    const replaceActiveRelease = (target, operation) =>
      system.run("ssh", [
        ...sshBase,
        "sudo",
        "/usr/bin/bash",
        "-c",
        'set -euo pipefail; temporary="$2.$$.new"; rm -f -- "$temporary"; ln -s -- "$1" "$temporary"; mv -Tf -- "$temporary" "$2"',
        operation,
        target,
        "/opt/markiro/active-release",
      ]);
    const activateRelease = () => replaceActiveRelease(releaseDirectory, "markiro-active-release");
    const restoreActiveRelease = (candidate) =>
      candidate.previousTag
        ? replaceActiveRelease(
            `/opt/markiro/releases/${candidate.previousTag}`,
            "markiro-restore-active-release",
          )
        : system.run("ssh", [...sshBase, "sudo", "rm", "-f", "--", "/opt/markiro/active-release"]);

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
          const targetStateUrl = `https://alb.api.cloud.yandex.net/apploadbalancer/v1/loadBalancers/${requiredEnvironment("YC_LOAD_BALANCER_ID", environment)}/targetStates/${requiredEnvironment("YC_BACKEND_GROUP_ID", environment)}/${requiredEnvironment("YC_TARGET_GROUP_ID", environment)}`;
          await waitForAlbTarget({
            expectedAddress: address,
            fetchTargetStates: async ({ signal }) => {
              const targets = await system.fetch(targetStateUrl, {
                headers: { Authorization: `Bearer ${token}` },
                signal,
              });
              if (!targets.ok) throw new Error("ALB target-state request failed");
              return targets.json();
            },
            sleep: system.sleep,
            monotonicNow: system.monotonicNow,
          });
        },
        deploymentPhase: phase,
        rollbackRehearsal,
        preDnsSmoke: async () => {
          const address = requiredIpv4("YC_LOAD_BALANCER_ADDRESS", environment);
          const localHeaders = await system.run("ssh", [
            ...sshBase,
            "curl",
            "--fail",
            "--silent",
            "--show-error",
            "--max-time",
            "30",
            "--dump-header",
            "-",
            "--output",
            "/dev/null",
            "-H",
            `Host: ${domain}`,
            "http://127.0.0.1:8080/health/ready",
          ]);
          assertExpectedReleaseHeader(localHeaders, manifest.commit);
          const albHeaders = await system.run("curl", [
            "--fail",
            "--silent",
            "--show-error",
            "--max-time",
            "30",
            "--dump-header",
            "-",
            "--output",
            "/dev/null",
            "--resolve",
            `${domain}:443:${address}`,
            `https://${domain}/health/ready`,
          ]);
          assertExpectedReleaseHeader(albHeaders, manifest.commit);
        },
        smoke: () =>
          system.smoke({
            baseUrl: productionBaseUrl({
              MARKIRO_DOMAIN: domain,
              MARKIRO_HTTPS_PORT: environment.MARKIRO_HTTPS_PORT,
            }),
            expectedReleaseSha: manifest.commit,
          }),
        async finalize(candidate) {
          const healthy = JSON.parse(await remoteStage("finalize", candidate));
          await activateRelease();
          return healthy;
        },
        async rollback(candidate) {
          const failed = JSON.parse(await remoteStage("rollback", candidate));
          await restoreActiveRelease(candidate);
          return failed;
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
    runRemoteDeploymentWithReporting()
      .then((result) => {
        if (result?.state === "rehearsed") process.stdout.write(`${JSON.stringify(result)}\n`);
      })
      .catch(() => {
        process.stderr.write("remote deployment failed\n");
        process.exitCode = 1;
      });
}
