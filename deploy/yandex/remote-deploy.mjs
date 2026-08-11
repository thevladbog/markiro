import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { parseReleaseManifest } from "../production/release-manifest.mjs";
import { validateProductionDomains } from "../production/production-domain.mjs";
import { productionBaseUrls, runPublicSmoke } from "../production/smoke.mjs";
import { isMainModule } from "./cli-main.mjs";
import { registryCredentials } from "./registry-auth.mjs";

const API_PREFIX = "ghcr.io/thevladbog/markiro-api@";
const EDGE_PREFIX = "ghcr.io/thevladbog/markiro-edge@";

function requireFunction(dependencies, name) {
  if (typeof dependencies[name] !== "function")
    throw new Error(`missing deployment dependency: ${name}`);
}

function requiredEnvironment(name, environment = process.env) {
  const value = environment[name];
  if (!value) throw new Error("remote deployment configuration is incomplete");
  return value;
}

function deploymentEmail(value) {
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/.test(value)
  )
    throw new Error("remote deployment configuration is incomplete");
  return value;
}

function publicIpv4(value) {
  const octets = typeof value === "string" ? value.split(".") : [];
  if (
    octets.length !== 4 ||
    octets.some((octet) => !/^(0|[1-9][0-9]{0,2})$/.test(octet) || Number(octet) > 255)
  )
    throw new Error("remote deployment configuration is incomplete");
  const numbers = octets.map(Number);
  if (
    numbers[0] === 0 ||
    numbers[0] === 10 ||
    numbers[0] === 127 ||
    (numbers[0] === 169 && numbers[1] === 254) ||
    (numbers[0] === 172 && numbers[1] >= 16 && numbers[1] <= 31) ||
    (numbers[0] === 192 && numbers[1] === 168) ||
    numbers[0] >= 224
  )
    throw new Error("remote deployment configuration is incomplete");
  return value;
}

function digest(image, prefix) {
  if (typeof image !== "string" || !image.startsWith(prefix))
    throw new Error("invalid release manifest");
  return image.slice(prefix.length);
}

function authenticatedKnownHosts(encodedKeys, address) {
  let text;
  try {
    const payload = Buffer.from(encodedKeys, "base64");
    text = payload.toString("utf8");
    if (!payload.equals(Buffer.from(text, "utf8"))) throw new Error();
  } catch {
    throw new Error("hosted SSH configuration is invalid");
  }
  const lines = text.split("\n").filter(Boolean);
  const algorithms = new Set();
  if (
    lines.length < 1 ||
    lines.length > 2 ||
    !lines.every((line) => {
      const match = line.match(/^(ssh-ed25519|ssh-rsa) ([A-Za-z0-9+/]+={0,2})$/);
      if (!match || algorithms.has(match[1])) return false;
      algorithms.add(match[1]);
      try {
        return Buffer.from(match[2], "base64").length >= 16;
      } catch {
        return false;
      }
    })
  )
    throw new Error("hosted SSH configuration is invalid");
  return `${lines.map((line) => `${address} ${line}`).join("\n")}\n`;
}

async function validateHostedPrivateKey(path, system) {
  try {
    const details = await system.stat(path);
    if (
      !details.isFile() ||
      (details.mode & 0o777) !== 0o600 ||
      !Number.isSafeInteger(details.size) ||
      details.size < 70 ||
      details.size > 16 * 1024
    )
      throw new Error();
    const contents = await system.readFile(path, "utf8");
    if (
      Buffer.byteLength(contents, "utf8") !== details.size ||
      !/^-----BEGIN OPENSSH PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+\n-----END OPENSSH PRIVATE KEY-----\n?$/.test(
        contents,
      )
    )
      throw new Error();
  } catch {
    throw new Error("hosted SSH configuration is invalid");
  }
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

export async function streamArchive(tarArguments, sshArguments, options = {}) {
  await new Promise((resolve, reject) => {
    const spawnChild = options.spawn ?? spawn;
    const timeoutMs = options.timeoutMs ?? 120_000;
    const writeDiagnostic = options.writeDiagnostic ?? ((value) => process.stderr.write(value));
    let archive;
    let remote;
    let archiveCode;
    let remoteCode;
    const remoteStderr = [];
    let remoteStderrBytes = 0;
    let settled = false;
    let timer;
    const stop = (child) => {
      if (child?.exitCode === null) child.kill("SIGTERM");
    };
    const fail = (cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      archive?.stdout.destroy();
      remote?.stdin.destroy();
      stop(archive);
      stop(remote);
      writeDiagnostic(`MARKIRO_DEPLOY_FAILURE ${cause}\n`);
      reject(new Error("private release transfer failed"));
    };
    const finish = () => {
      if (settled || archiveCode === undefined || remoteCode === undefined) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    try {
      archive = spawnChild("tar", tarArguments, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      remote = spawnChild("ssh", sshArguments, {
        shell: false,
        stdio: ["pipe", "ignore", "pipe"],
      });
      remote.stdin.once("error", () => fail("transfer-pipe"));
      archive.stdout.pipe(remote.stdin);
    } catch {
      fail("transfer-spawn");
      return;
    }
    archive.stderr.on("data", () => undefined);
    remote.stderr.on("data", (chunk) => {
      if (remoteStderrBytes >= 8 * 1024) return;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      remoteStderr.push(value.subarray(0, 8 * 1024 - remoteStderrBytes));
      remoteStderrBytes += value.length;
    });
    timer = setTimeout(() => fail("transfer-timeout"), timeoutMs);
    archive.once("error", () => fail("archive-spawn"));
    remote.once("error", () => fail("ssh-spawn"));
    archive.once("close", (code) => {
      archiveCode = code;
      if (code !== 0) return fail("archive-exit");
      finish();
    });
    remote.once("close", (code) => {
      remoteCode = code;
      if (code !== 0) {
        const stderr = Buffer.concat(remoteStderr).toString("utf8");
        const cause = /host key verification failed|remote host identification has changed/i.test(
          stderr,
        )
          ? "ssh-host-key"
          : /permission denied \(publickey\)|no supported authentication methods/i.test(stderr)
            ? "ssh-auth"
            : /connect to host|connection (?:timed out|refused)|network is unreachable|no route to host|could not resolve hostname/i.test(
                  stderr,
                )
              ? "ssh-connect"
              : /(?:^|\n)sudo:/i.test(stderr)
                ? "remote-sudo"
                : /(?:^|\n)tar:/i.test(stderr)
                  ? "remote-tar"
                  : "ssh-exit";
        return fail(cause);
      }
      finish();
    });
  });
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

export async function deployRelease(dependencies, manifestText) {
  for (const name of [
    "transferBundle",
    "reconcileHost",
    "refreshRuntime",
    "prepare",
    "smoke",
    "finalize",
    "rollback",
  ])
    requireFunction(dependencies, name);
  const manifest = parseReleaseManifest(manifestText, dependencies.expectedWorkflowRunId);
  if (manifest.commit !== dependencies.expectedCommit) throw new Error("invalid release manifest");
  await dependencies.transferBundle(manifest);
  await dependencies.reconcileHost(manifest);
  await dependencies.refreshRuntime(manifest);
  let candidate;
  try {
    candidate = await dependencies.prepare(manifest);
    await dependencies.smoke(candidate);
    return await dependencies.finalize(candidate);
  } catch (error) {
    if (candidate) await dependencies.rollback(candidate);
    throw error;
  }
}

export async function runRemoteDeployment(environment = process.env, supplied = {}) {
  const system = {
    readFile,
    stat,
    mkdtemp,
    copyFile,
    writeFile,
    rm,
    streamArchive,
    run,
    smoke: ({ adminBaseUrl, kioskBaseUrl, expectedReleaseSha }) =>
      runPublicSmoke({ adminBaseUrl, kioskBaseUrl, expectedReleaseSha }),
    ...supplied,
  };
  const manifestPath = requiredEnvironment("RELEASE_MANIFEST_PATH", environment);
  const expectedRunId = requiredEnvironment("EXPECTED_RELEASE_RUN_ID", environment);
  const expectedCommit = requiredEnvironment("EXPECTED_RELEASE_SHA", environment);
  const { domain, kioskDomain } = validateProductionDomains(
    environment.MARKIRO_DOMAIN,
    environment.MARKIRO_KIOSK_DOMAIN,
  );
  const acmeEmail = deploymentEmail(requiredEnvironment("ACME_EMAIL", environment));
  const manifestText = await system.readFile(manifestPath, "utf8");
  const manifest = parseReleaseManifest(manifestText, expectedRunId);
  if (manifest.commit !== expectedCommit || process.cwd() === "/")
    throw new Error("invalid release manifest");

  const publicAddress = publicIpv4(requiredEnvironment("YC_APP_PUBLIC_ADDRESS", environment));
  const login = requiredEnvironment("YC_APP_DEPLOY_LOGIN", environment);
  if (login !== "markiro-deploy") throw new Error("hosted SSH configuration is invalid");
  const identity = requiredEnvironment("YC_APP_DEPLOY_SSH_PRIVATE_KEY_PATH", environment);
  await validateHostedPrivateKey(identity, system);
  const knownHostsContents = authenticatedKnownHosts(
    requiredEnvironment("APP_SSH_HOST_KEYS_B64", environment),
    publicAddress,
  );
  const registryPayload = {
    entries: [
      { key: "GHCR_USERNAME", textValue: requiredEnvironment("GHCR_USERNAME", environment) },
      { key: "GHCR_TOKEN", textValue: requiredEnvironment("GHCR_TOKEN", environment) },
    ],
  };
  registryCredentials(registryPayload);

  const credentialDirectory = await system.mkdtemp(join(tmpdir(), "markiro-direct-ssh-"));
  const manifestDirectory = await system.mkdtemp(join(tmpdir(), "markiro-release-manifest-"));
  try {
    const knownHosts = join(credentialDirectory, "known_hosts");
    await system.writeFile(knownHosts, knownHostsContents, { encoding: "utf8", mode: 0o600 });
    const sshBase = [
      "-i",
      identity,
      "-o",
      `UserKnownHostsFile=${knownHosts}`,
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=2",
      `${login}@${publicAddress}`,
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
          "--property=Requires=markiro-runtime-env.service",
          "--property=After=markiro-runtime-env.service",
          `--working-directory=${releaseDirectory}`,
          "env",
          `MARKIRO_IMAGE_TAG=${manifest.commit}`,
          `MARKIRO_API_IMAGE_DIGEST=${apiDigest}`,
          `MARKIRO_EDGE_IMAGE_DIGEST=${edgeDigest}`,
          "MARKIRO_COMPOSE_PROJECT=markiro-production",
          `MARKIRO_DOMAIN=${domain}`,
          `MARKIRO_KIOSK_DOMAIN=${kioskDomain}`,
          "MARKIRO_EDGE_MODE=direct",
          `ACME_EMAIL=${acmeEmail}`,
          "MARKIRO_REQUIRE_PREVIOUS_HEALTHY=0",
          "MARKIRO_REQUIRE_NO_PREVIOUS_HEALTHY=0",
          "MARKIRO_ENV_FILE=/etc/markiro/production.env",
          "MARKIRO_RELEASE_DIRECTORY=/var/lib/markiro/releases",
          "/usr/bin/node",
          "/usr/local/lib/markiro/registry-auth.mjs",
          "run-stdin",
          "/usr/bin/node",
          "deploy/production/deploy.mjs",
          stage,
        ],
        {
          input: `${JSON.stringify({
            entries: registryPayload.entries,
            ...(candidate ? { commandInput: `${JSON.stringify(candidate)}\n` } : {}),
          })}\n`,
        },
      );

    const replaceActiveRelease = async (target) => {
      const temporary = `/opt/markiro/active-release.${target.split("/").at(-1)}.new`;
      await system.run("ssh", [...sshBase, "sudo", "rm", "-f", "--", temporary]);
      await system.run("ssh", [...sshBase, "sudo", "ln", "-s", "--", target, temporary]);
      await system.run("ssh", [
        ...sshBase,
        "sudo",
        "mv",
        "-Tf",
        "--",
        temporary,
        "/opt/markiro/active-release",
      ]);
    };
    const restoreActiveRelease = (candidate) =>
      candidate.previousTag
        ? replaceActiveRelease(`/opt/markiro/releases/${candidate.previousTag}`)
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
              ".env.production.example",
              "deploy/production",
              "deploy/yandex/reconcile-host.sh",
              "deploy/yandex/runtime-env.mjs",
              "deploy/yandex/registry-auth.mjs",
              "deploy/yandex/cli-main.mjs",
              "deploy/yandex/systemd",
              "deploy/yandex/tmpfiles.d",
              "-C",
              manifestDirectory,
              "release-manifest.json",
            ],
            [...sshBase, "sudo", "tar", "-xf", "-", "-C", "/opt/markiro", "--no-same-owner"],
          );
        },
        reconcileHost: () =>
          system.run("ssh", [
            ...sshBase,
            "sudo",
            "/usr/bin/bash",
            `${releaseDirectory}/deploy/yandex/reconcile-host.sh`,
            releaseDirectory,
            "markiro-host-assets",
          ]),
        refreshRuntime: () =>
          system.run("ssh", [
            ...sshBase,
            "sudo",
            "systemctl",
            "restart",
            "markiro-runtime-env.service",
          ]),
        prepare: async () => parseCandidate(await remoteStage("prepare")),
        smoke: () => {
          const baseUrls = productionBaseUrls({
            MARKIRO_DOMAIN: domain,
            MARKIRO_KIOSK_DOMAIN: kioskDomain,
            MARKIRO_EDGE_MODE: "direct",
          });
          return system.smoke({
            adminBaseUrl: baseUrls.admin,
            kioskBaseUrl: baseUrls.kiosk,
            expectedReleaseSha: manifest.commit,
          });
        },
        async finalize(candidate) {
          const healthy = JSON.parse(await remoteStage("finalize", candidate));
          await replaceActiveRelease(releaseDirectory);
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
