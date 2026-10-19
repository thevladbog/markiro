import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { operationFixture } from "./host-command-fixture.mjs";
import { dockerFixture } from "./host-observe-fixture.mjs";
import { release, publisher, jobs } from "./admission-fixtures.mjs";
import { digest } from "../backup/schemas.mjs";
import { runHostProcess } from "../host/process.mjs";

const save = (path, value) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
export async function commandIntegrationFixture(t, failureMode = null) {
  const f = await operationFixture(t);
  const { record, receipt } = f;
  const op = record.deployment,
    policy = record.observationPolicy;
  const d = await dockerFixture(t, {
    fixture: f,
    policy,
    hbaPath: join(f.installed, "deploy/platform/postgres/pg_hba.conf"),
  });
  const { state } = d;
  const rolePolicySha256 = receipt.files["deploy/platform/postgres/roles.mjs"];
  const enforcementSha256 = digest({
    version: 1,
    kind: "platform-docker-private-database-fence",
    target: f.identity.target,
    dockerId: policy.dockerId,
    network: policy.networks.database,
    volume: policy.volume,
    postgresImageId: policy.postgresImageId,
    hbaSha256: receipt.files["deploy/platform/postgres/pg_hba.conf"],
  });
  op.preparedTarget.fence.enforcementSha256 = enforcementSha256;
  for (const pairs of [f.document.fence, f.evidence.fence])
    for (const fence of Object.values(pairs)) fence.enforcementSha256 = enforcementSha256;
  op.preparedPolicy.rolePolicySha256 = rolePolicySha256;
  Object.assign(op.preparedPolicy.postgres, { architecture: "amd64", uid: 70, gid: 70 });
  op.preparedPolicy.maxAgeMs = 86400000;
  await f.publishBackup();
  for (const observation of Object.values(op.preparedTarget.observations))
    observation.target = f.identity.target;
  const observed = op.preparedTarget.observations;
  Object.assign(observed.postgres.value, op.preparedPolicy.postgres);
  observed.rolePolicy.value.policySha256 = rolePolicySha256;
  Object.assign(observed.restoredSnapshot.value, {
    inventorySha256: f.backup.inventorySha256,
    restoreEvidenceSha256: f.restoreEvidence.evidenceSha256,
    workerArchitecture: "amd64",
  });
  receipt.ci = { runId: "124", runAttempt: "1" };
  await save(join(f.root, "installed-executor.json"), receipt);
  const { manifest, evidence } = release();
  await save(join(f.root, "release-input.json"), {
    "platform-manifest.json": JSON.stringify(manifest),
    "release-evidence.json": JSON.stringify(evidence),
  });
  await runHostProcess({
    executable: "/usr/bin/python3",
    args: [
      fileURLToPath(new URL("./fixtures/host-release-zip.py", import.meta.url)),
      join(f.root, "release-input.json"),
      join(f.root, "release.zip"),
    ],
    cwd: f.root,
    env: { PATH: "/usr/bin:/bin" },
    timeoutMs: 10000,
    outputLimitBytes: 65536,
  });
  const archive = await readFile(join(f.root, "release.zip"));
  op.identity.admission.artifact.sha256 = digest(archive);
  await writeFile(join(f.root, "github-token"), "synthetic-job-token", { mode: 0o600 });
  state.probeResult = { postgresVersion: "17.11", tls: observed.tls.value };
  state.adminResult = {
    system_id: f.identity.target.databaseId,
    version: "17.11",
    ssl: "on",
    hba_file: "/etc/postgresql/pg_hba.conf",
    started_at: Date.now(),
    sessions: [],
    prepared: 0,
    hba: [
      {
        rule_number: 1,
        type: "local",
        database: ["all"],
        user_name: ["all"],
        address: null,
        netmask: null,
        auth_method: "peer",
        options: null,
        error: null,
      },
      {
        rule_number: 2,
        type: "hostnossl",
        database: ["all"],
        user_name: ["all"],
        address: "all",
        netmask: null,
        auth_method: "reject",
        options: null,
        error: null,
      },
      {
        rule_number: 3,
        type: "hostssl",
        database: ["all"],
        user_name: ["all"],
        address: "all",
        netmask: null,
        auth_method: "scram-sha-256",
        options: null,
        error: null,
      },
    ],
  };
  const images = Object.fromEntries(
    Object.entries(op.identity.admission.registry).map(([name, image]) => [
      name,
      {
        Id: image.imageId,
        Os: "linux",
        Architecture: "amd64",
        RepoDigests: [image.reference],
        Config: {
          Entrypoint: ["docker-entrypoint.sh"],
          Cmd: name === "api" ? ["node", "dist/main.js"] : ["caddy", "run"],
        },
      },
    ]),
  );
  state.images.push(...Object.values(images));
  state.templates = {};
  for (const service of ["api", "edge", "migrate"]) {
    const c = structuredClone(state.containers[0]);
    const image = images[service === "edge" ? "edge" : "api"];
    const reference = image.RepoDigests[0];
    c.Id = { api: "4", edge: "5", migrate: "6" }[service].repeat(64);
    c.Name =
      service === "migrate"
        ? `/markiro-platform-migrate-${f.identity.operationId}`
        : `/markiro-platform-${service}-1`;
    c.Image = image.Id;
    c.Config.Image = reference;
    c.Config.User = "";
    c.Config.Entrypoint = image.Config.Entrypoint;
    c.Config.Cmd =
      service === "migrate"
        ? ["node", "node_modules/@markiro/db/dist/migrate-cli.js"]
        : image.Config.Cmd;
    c.Config.Labels["com.docker.compose.service"] = service;
    c.Config.Labels["com.docker.compose.oneoff"] = service === "migrate" ? "True" : "False";
    if (service === "migrate") c.Config.Labels["io.markiro.operation"] = f.identity.operationId;
    let env;
    if (service === "edge")
      env = {
        ...Object.fromEntries(
          [
            "MARKIRO_RETIRED_ADMIN_DOMAIN",
            "MARKIRO_SAAS_ADMIN_DOMAIN",
            "MARKIRO_RETIRED_KIOSK_DOMAIN",
            "MARKIRO_LANDING_DOMAIN",
            "S3_PUBLIC_ORIGIN",
            "ACME_EMAIL",
          ].map((k) => [k, f.env[k]]),
        ),
        SERVER_PROFILE: "platform-only",
        VITE_SERVER_PROFILE: "platform-only",
        MARKIRO_RELEASE_SHA: manifest.sourceSha,
      };
    else {
      const source =
        service === "api"
          ? f.env
          : Object.fromEntries(
              String(await readFile(op.configuration.migrationSnapshot.path))
                .trim()
                .split("\n")
                .map((line) => {
                  const i = line.indexOf("=");
                  return [line.slice(0, i), line.slice(i + 1)];
                }),
            );
      env = {
        ...source,
        SERVER_PROFILE: "platform-only",
        NODE_ENV: "production",
        PORT: "3000",
        TRUST_PROXY_HOPS: "1",
        NODE_OPTIONS: service === "api" ? "--max-old-space-size=1024" : "--max-old-space-size=384",
        ...(service === "api"
          ? {
              PLATFORM_PGBOSS_PREPROVISIONED_SCHEMA: "true",
              VALIDATION_DM_DUPLICATE_ENABLED: "false",
              NATIONAL_CATALOG_OWN_IMPORT_ENABLED: "false",
              NATIONAL_CATALOG_GTIN_IMPORT_ENABLED: "false",
              NATIONAL_CATALOG_IMAGE_IMPORT_ENABLED: "false",
            }
          : {}),
      };
    }
    c.Config.Env = Object.entries(env).map(([k, v]) => `${k}=${v}`);
    c.NetworkSettings.Networks = Object.fromEntries(
      Object.entries(policy.networks)
        .filter(([name]) => service !== "edge" || name === "default")
        .map(([, n]) => [n.name, { NetworkID: n.id, IPAddress: "172.20.0.3" }]),
    );
    c.HostConfig.NetworkMode = policy.networks.default.name;
    c.Mounts =
      service === "edge"
        ? ["data", "config"].map((k) => ({
            Type: "volume",
            Name: `markiro-platform_caddy-${k}`,
            Destination: `/${k}`,
            RW: true,
          }))
        : [
            {
              Type: "bind",
              Source: f.env.MARKIRO_POSTGRES_CA_FILE,
              Destination: "/run/markiro-postgres/ca.crt",
              RW: false,
            },
          ];
    state.templates[service] = c;
  }
  state.failureMode = failureMode;
  await d.publish();
  await f.publish();
  await save(join(f.root, "integration.json"), { installedRoot: f.installed, failureMode });
  await save(join(f.root, "external-calls.json"), { github: [], smoke: [] });
  return f;
}

export async function integrationOptions(root) {
  const { installedRoot, failureMode } = JSON.parse(
    await readFile(join(root, "integration.json"), "utf8"),
  );
  const record = JSON.parse(await readFile(join(root, "operation.json"), "utf8"));
  const op = record.deployment;
  const archive = await readFile(join(root, "release.zip"));
  const external = JSON.parse(await readFile(join(root, "external-calls.json"), "utf8"));
  const recordExternal = () => save(join(root, "external-calls.json"), external);
  return {
    installedRoot,
    ambient: {},
    readMachineId: async () => record.observationPolicy.machineId,
    runProcess: async (request) => {
      if (request.executable === "/usr/bin/python3") return runHostProcess(request);
      assert.equal(request.executable, "/usr/bin/docker");
      assert.deepEqual(request.args.slice(0, 2), ["--host", "unix:///var/run/docker.sock"]);
      assert.equal(request.env.DOCKER_HOST, undefined);
      assert.equal(request.env.DOCKER_CONTEXT, undefined);
      const args = request.args.slice(2);
      const result = await runHostProcess({
        ...request,
        executable: process.execPath,
        args: [
          fileURLToPath(new URL("./fixtures/host-docker.mjs", import.meta.url)),
          join(root, "daemon.json"),
          JSON.stringify(args),
        ],
      });
      if (failureMode === "uncertain-migration" && args[0] === "compose" && args[7] === "run")
        throw Object.assign(new Error("secret-private-unreaped-output"), {
          terminationConfirmed: false,
          durabilityUncertain: true,
        });
      return result;
    },
    request: async (url, options) => {
      external.github.push(url);
      await recordExternal();
      if (url === "https://signed.invalid/release.zip") {
        assert.equal(options.headers.Authorization, undefined);
        return new Response(archive);
      }
      assert.equal(options.headers.Authorization, "Bearer synthetic-job-token");
      assert.equal(options.redirect, "manual");
      const path = new URL(url).pathname;
      let value;
      if (path.endsWith("/artifacts/789/zip"))
        return new Response(null, {
          status: 302,
          headers: { location: "https://signed.invalid/release.zip" },
        });
      if (path.endsWith("/artifacts/789"))
        value = {
          id: 789,
          name: "markiro-platform-release-456-2",
          expired: false,
          expires_at: new Date(Date.now() + 86400000).toISOString(),
          size_in_bytes: archive.length,
          digest: `sha256:${digest(archive)}`,
          workflow_run: {
            id: 456,
            head_sha: op.identity.admission.manifest.sourceSha,
            head_branch: "main",
            repository_id: 10,
            head_repository_id: 10,
          },
        };
      else if (path.includes("/runs/456")) value = path.endsWith("/jobs") ? jobs() : publisher();
      else {
        const executor = path.includes("/runs/124");
        assert.ok(executor || path.includes("/runs/123"));
        const run = {
          id: executor ? 124 : 123,
          run_attempt: executor ? 1 : 3,
          name: "CI",
          path: ".github/workflows/ci.yml",
          event: "push",
          head_branch: "main",
          head_sha: executor ? op.identity.executorSha : op.identity.admission.manifest.sourceSha,
          status: "completed",
          conclusion: "success",
          repository: { full_name: "thevladbog/markiro" },
          head_repository: { full_name: "thevladbog/markiro" },
        };
        value = path.endsWith("/jobs") ? jobs(run, ["production-bundle", "ci-required"]) : run;
      }
      return new Response(JSON.stringify(value));
    },
    httpsRequest: (options, receive) => {
      assert.equal(options.hostname, "127.0.0.1");
      assert.equal(options.rejectUnauthorized, true);
      external.smoke.push({ host: options.servername, path: options.path });
      const request = new EventEmitter();
      request.end = () =>
        queueMicrotask(async () => {
          await recordExternal();
          const response = new EventEmitter();
          response.statusCode =
            options.path === "/api/platform/tenants"
              ? 401
              : options.path === "/station/sync"
                ? 404
                : ["/api/auth/get-session", "/kiosk/sync"].includes(options.path)
                  ? 410
                  : 200;
          response.headers = {
            "x-markiro-server-profile": "platform-only",
            "x-markiro-release-sha": op.identity.admission.manifest.sourceSha,
          };
          receive(response);
          response.emit("end");
          request.emit("close");
        });
      request.destroy = (error) => request.emit("error", error);
      return request;
    },
  };
}
