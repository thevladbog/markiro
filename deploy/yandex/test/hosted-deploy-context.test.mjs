import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const CONTEXT_MODULE = "../hosted-deploy-context.mjs";
const PRIVATE_ADDRESS = "10.64.1.11";
const PUBLIC_ADDRESS = "203.0.113.44";

function sshField(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function publicKey(algorithm, seed = 1) {
  const blob =
    algorithm === "ssh-ed25519"
      ? Buffer.concat([sshField(algorithm), sshField(Buffer.alloc(32, seed))])
      : Buffer.concat([
          sshField(algorithm),
          sshField(Buffer.from([1, 0, 1])),
          sshField(Buffer.alloc(64, seed)),
        ]);
  return `${algorithm} ${blob.toString("base64")}`;
}

const ED25519_KEY = publicKey("ssh-ed25519");
const RSA_KEY = publicKey("ssh-rsa");
const HOST_KEYS_B64 = Buffer.from(`${ED25519_KEY}\n${RSA_KEY}`, "utf8").toString("base64");
const CONTEXT_PATH = fileURLToPath(new URL(CONTEXT_MODULE, import.meta.url));
const ENVIRONMENT = Object.freeze({
  MARKIRO_DEPLOYMENT_PHASE: "repeat",
  YC_APP_INSTANCE_ID: "fv4app123",
  YC_POSTGRES_CLUSTER_ID: "c9qpostgres123",
  YC_LOAD_BALANCER_ID: "ds7loadbalancer123",
  YC_BACKEND_GROUP_ID: "ds7backend123",
  YC_TARGET_GROUP_ID: "ds7target123",
});

function marker(key) {
  return `MARKIRO_SSH_HOST_KEY_V1 ${key}`;
}

async function runCliWithProviderBytes({ instancePaddingBytes = 0, serialBytes }) {
  const directory = await mkdtemp(join(tmpdir(), "markiro-hosted-context-cli-test-"));
  const contextPath = join(directory, "context.json");
  const preloadPath = join(directory, "provider-fetch.mjs");
  const providerFixtures = {
    instance: {
      id: ENVIRONMENT.YC_APP_INSTANCE_ID,
      padding: "x".repeat(instancePaddingBytes),
      status: "RUNNING",
      networkInterfaces: [
        {
          primaryV4Address: {
            address: PRIVATE_ADDRESS,
            oneToOneNat: { address: PUBLIC_ADDRESS, ipVersion: "IPV4" },
          },
        },
      ],
    },
    backups: {
      backups: [{ createdAt: new Date().toISOString() }],
    },
    targetStates: {
      targetStates: [
        {
          target: { ipAddress: PRIVATE_ADDRESS },
          status: { zoneStatuses: [{ status: "HEALTHY", zoneId: "ru-central1-d" }] },
        },
      ],
    },
    serial: {
      contents: `${"x".repeat(serialBytes)}\n${marker(ED25519_KEY)}\n${marker(RSA_KEY)}`,
    },
  };
  const preload = `
const fixtures = ${JSON.stringify(providerFixtures)};
globalThis.fetch = async (url) => {
  const target = String(url);
  let payload;
  if (target.includes(":serialPortOutput")) payload = fixtures.serial;
  else if (target.includes("/compute/v1/instances/")) payload = fixtures.instance;
  else if (target.endsWith("/backups")) payload = fixtures.backups;
  else if (target.includes("/targetStates/")) payload = fixtures.targetStates;
  else return new Response("not found", { status: 404 });
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
`;
  await writeFile(preloadPath, preload, { encoding: "utf8", mode: 0o600 });
  try {
    const result = await new Promise((resolveResult, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", pathToFileURL(preloadPath).href, CONTEXT_PATH, "resolve"],
        {
          env: {
            ...process.env,
            ...ENVIRONMENT,
            HOSTED_DEPLOY_CONTEXT_PATH: contextPath,
            MARKIRO_DEPLOYMENT_PHASE: "first",
            RUNNER_TEMP: directory,
            YC_IAM_TOKEN: "test-iam-token",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code, signal) => resolveResult({ code, signal, stderr, stdout }));
    });
    let context;
    try {
      context = JSON.parse(await readFile(contextPath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return { ...result, context };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function providerFixture(overrides = {}) {
  const requests = [];
  const instance = {
    id: ENVIRONMENT.YC_APP_INSTANCE_ID,
    folderId: "b1gfolder123",
    status: "RUNNING",
    networkInterfaces: [
      {
        index: "0",
        macAddress: "d0:0d:00:00:00:01",
        subnetId: "e2lsubnet123",
        primaryV4Address: {
          address: PRIVATE_ADDRESS,
          oneToOneNat: { address: PUBLIC_ADDRESS, ipVersion: "IPV4" },
        },
      },
    ],
    ...overrides.instance,
  };
  const backups = overrides.backups ?? {
    backups: [
      {
        createdAt: "2026-08-09T09:00:00.000Z",
        id: "mdbbackup123",
        sourceClusterId: ENVIRONMENT.YC_POSTGRES_CLUSTER_ID,
      },
    ],
  };
  const targetStates = overrides.targetStates ?? {
    targetStates: [
      {
        target: { ipAddress: PRIVATE_ADDRESS, subnetId: "e2lsubnet123" },
        status: {
          zoneStatuses: [
            {
              failedActiveHc: false,
              status: "HEALTHY",
              zoneId: "ru-central1-d",
            },
          ],
        },
      },
    ],
  };
  const serial = overrides.serial ?? {
    contents: ["ordinary boot output", marker(RSA_KEY), marker(ED25519_KEY)].join("\n"),
  };
  return {
    requests,
    options: {
      environment: { ...ENVIRONMENT, ...overrides.environment },
      now: () => Date.parse("2026-08-09T10:00:00.000Z"),
      async request(url, options) {
        requests.push({ options, url });
        if (url.includes(":serialPortOutput")) return serial;
        if (url.includes("/compute/v1/instances/")) return instance;
        if (url.endsWith("/backups")) return backups;
        if (url.includes("/targetStates/")) return targetStates;
        assert.fail(`unexpected provider request: ${url}`);
      },
    },
  };
}

test("hosted context resolves one exact public SSH address while retaining the private ALB target", async () => {
  const { resolveHostedDeployContext } = await import(CONTEXT_MODULE);
  const fixture = providerFixture();

  assert.deepEqual(await resolveHostedDeployContext("iam-token", fixture.options), {
    appHostKeysB64: HOST_KEYS_B64,
    appPrivateAddress: PRIVATE_ADDRESS,
    appPublicAddress: PUBLIC_ADDRESS,
  });
  assert.equal(fixture.requests.length, 4);
  for (const { options } of fixture.requests)
    assert.deepEqual(options.headers, { Authorization: "Bearer iam-token" });
});

test("hosted context accepts only the exact first-release target through allowed transitional health", async () => {
  const { resolveHostedDeployContext } = await import(CONTEXT_MODULE);
  const fixture = providerFixture({
    environment: { MARKIRO_DEPLOYMENT_PHASE: "first" },
    targetStates: {
      targetStates: [
        {
          target: { ipAddress: PRIVATE_ADDRESS, subnetId: "e2lsubnet123" },
          status: {
            zoneStatuses: [{ failedActiveHc: true, status: "UNHEALTHY", zoneId: "ru-central1-d" }],
          },
        },
      ],
    },
  });

  assert.equal(
    (await resolveHostedDeployContext("iam-token", fixture.options)).appPublicAddress,
    PUBLIC_ADDRESS,
  );
});

test("hosted context rejects invalid app, backup and ALB boundaries without reflecting provider data", async () => {
  const { resolveHostedDeployContext } = await import(CONTEXT_MODULE);
  const cases = [
    ["stopped app", { instance: { status: "STOPPED" } }],
    ["missing interface", { instance: { networkInterfaces: [] } }],
    [
      "missing public NAT",
      {
        instance: {
          networkInterfaces: [
            { primaryV4Address: { address: PRIVATE_ADDRESS }, subnetId: "e2lsubnet123" },
          ],
        },
      },
    ],
    [
      "private public NAT",
      {
        instance: {
          networkInterfaces: [
            {
              primaryV4Address: {
                address: PRIVATE_ADDRESS,
                oneToOneNat: { address: "10.64.1.12", ipVersion: "IPV4" },
              },
              subnetId: "e2lsubnet123",
            },
          ],
        },
      },
    ],
    ["missing backup", { backups: { backups: [] } }],
    [
      "stale backup",
      {
        backups: {
          backups: [
            {
              createdAt: "2026-08-07T09:00:00.000Z",
              id: "provider-secret-backup",
              sourceClusterId: ENVIRONMENT.YC_POSTGRES_CLUSTER_ID,
            },
          ],
        },
      },
    ],
    [
      "foreign target",
      {
        targetStates: {
          targetStates: [
            {
              target: { ipAddress: "10.64.1.99", subnetId: "e2lsubnet123" },
              status: {
                zoneStatuses: [{ status: "HEALTHY", zoneId: "ru-central1-d" }],
              },
            },
          ],
        },
      },
    ],
    [
      "unhealthy repeat target",
      {
        targetStates: {
          targetStates: [
            {
              target: { ipAddress: PRIVATE_ADDRESS, subnetId: "e2lsubnet123" },
              status: {
                zoneStatuses: [{ status: "UNHEALTHY", zoneId: "ru-central1-d" }],
              },
            },
          ],
        },
      },
    ],
  ];

  for (const [name, overrides] of cases) {
    const fixture = providerFixture(overrides);
    await assert.rejects(
      resolveHostedDeployContext("iam-token", fixture.options),
      (error) => {
        assert.match(
          error.message,
          /production (?:infrastructure|backup|ALB) (?:gate|target inventory) failed/,
        );
        assert.doesNotMatch(error.message, /iam-token|provider-secret|10\.64\.1\.99/);
        return true;
      },
      name,
    );
  }
});

test("hosted context canonicalizes authenticated host keys for the public address", async () => {
  const { authenticatedKnownHosts, parseAuthenticatedHostKeys, parseSerialHostKeys } = await import(
    CONTEXT_MODULE
  );
  const serial = [marker(RSA_KEY), marker(ED25519_KEY), ""].join("\r\n");
  const encoded = parseSerialHostKeys(serial);

  assert.equal(encoded, HOST_KEYS_B64);
  assert.deepEqual(parseAuthenticatedHostKeys(encoded), [ED25519_KEY, RSA_KEY]);
  assert.equal(
    authenticatedKnownHosts(encoded, PUBLIC_ADDRESS),
    `${PUBLIC_ADDRESS} ${ED25519_KEY}\n${PUBLIC_ADDRESS} ${RSA_KEY}\n`,
  );
});

test("hosted context accepts a bounded serial response larger than ordinary provider payloads", async () => {
  const result = await runCliWithProviderBytes({ serialBytes: 70 * 1024 });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "");
  assert.deepEqual(result.context, {
    appHostKeysB64: HOST_KEYS_B64,
    appPrivateAddress: PRIVATE_ADDRESS,
    appPublicAddress: PUBLIC_ADDRESS,
  });
});

test("hosted context rejects a serial response beyond its dedicated bound", async () => {
  const result = await runCliWithProviderBytes({ serialBytes: 257 * 1024 });

  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "hosted deployment context failed\n");
  assert.equal(result.stdout, "");
  assert.equal(result.context, undefined);
});

test("hosted context retains the smaller bound for ordinary provider responses", async () => {
  const result = await runCliWithProviderBytes({
    instancePaddingBytes: 65 * 1024,
    serialBytes: 1,
  });

  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "hosted deployment context failed\n");
  assert.equal(result.stdout, "");
  assert.equal(result.context, undefined);
});

test("hosted context rejects malformed or duplicate authenticated serial host keys", async () => {
  const { parseSerialHostKeys } = await import(CONTEXT_MODULE);
  for (const output of [
    "boot complete",
    `${marker(ED25519_KEY)}\n${marker(RSA_KEY)}\n${marker(publicKey("ssh-ed25519", 2))}`,
    `${marker(ED25519_KEY)}\n${marker(publicKey("ssh-ed25519", 2))}`,
    `${marker(ED25519_KEY)}\nMARKIRO_SSH_HOST_KEY_V1 ssh-rsa !!!!`,
    `${marker(ED25519_KEY)}\nprefix ${marker(RSA_KEY)}`,
  ])
    assert.throws(() => parseSerialHostKeys(output), /authenticated SSH host keys are invalid/);
});

test("hosted context writes one owner-only bounded file and refuses overwrite or escape", async () => {
  const { writeHostedDeployContext } = await import(CONTEXT_MODULE);
  const directory = await mkdtemp(join(tmpdir(), "markiro-hosted-context-test-"));
  const outputPath = join(directory, "context.json");
  const context = {
    appHostKeysB64: HOST_KEYS_B64,
    appPrivateAddress: PRIVATE_ADDRESS,
    appPublicAddress: PUBLIC_ADDRESS,
  };
  try {
    await writeHostedDeployContext(outputPath, context, { runnerTemp: directory });

    assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), context);
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
    await assert.rejects(
      writeHostedDeployContext(outputPath, context, { runnerTemp: directory }),
      (error) => error.code === "EEXIST",
    );
    await assert.rejects(
      writeHostedDeployContext(join(directory, "..", "escaped.json"), context, {
        runnerTemp: directory,
      }),
      /hosted deployment context configuration is incomplete/,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
