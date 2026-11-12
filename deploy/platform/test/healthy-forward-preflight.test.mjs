import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { digest } from "../backup/schemas.mjs";
import { containerRecipe } from "../host/container-recipe.mjs";
import { forwardMigrationQuery } from "../host/forward-ledger.mjs";
import { withForwardActivationState, withForwardPreparationState } from "../host/forward-state.mjs";
import {
  verifyHealthyForwardPreflight,
  withStoppedHealthyForwardSource,
} from "../host/healthy-forward-preflight.mjs";
import { forwardEdgeSuccessorFixture } from "./forward-edge-successor-fixture.mjs";
import { forwardDecision, forwardPrepared } from "./forward-fixture.mjs";

async function fixture(t) {
  const f = await forwardEdgeSuccessorFixture(t);
  t.mock.method(Date, "now", () => f.now);
  const prepared = forwardPrepared(f);
  await withForwardPreparationState(
    f.root,
    f.input,
    async (store) => {
      await store.complete("admitted", prepared.sourceRuntime);
      await store.enter("source-held");
      await store.complete("source-held");
      await store.enter("backup-verified");
      await store.complete("backup-verified", prepared.backup, prepared.preparation);
    },
    f.options,
  );
  const operationId = f.input.identity.operationId;
  const path = (file) => join(f.root, "forward-recovery-operations", operationId, file);
  const decision = forwardDecision(f, JSON.parse(await readFile(path("state.json"))));
  delete decision.expiresAt;
  decision.version = 2;
  decision.authority = "protected-dispatch-once";
  await withForwardActivationState(
    f.root,
    decision,
    async (store) => {
      for (const phase of ["activation-admitted", "api-started", "edge-started", "healthy"]) {
        if (phase !== "activation-admitted") await store.enter(phase);
        await store.complete(phase);
      }
    },
    f.options,
  );

  const sha256 = async (file) => digest(await readFile(file));
  const predecessor = {
    operationId,
    indexSha256: await sha256(join(f.root, "upgrade-index.json")),
    stateSha256: await sha256(path("state.json")),
    beforeActivationSha256: await sha256(path("before-post-migration-activate.json")),
    prepareConsumptionSha256: await sha256(path("prepare-consumption.json")),
    activateConsumptionSha256: await sha256(path("activate-consumption.json")),
  };

  const host = dirname(f.root);
  const receiptPath = "manual-configurations/reviewed-drift/result.json";
  const runtimePath = "manual-configurations/reviewed-drift/runtime.env";
  const candidatePath = "state/reviewed-candidate/runtime.env";
  const sourceSha = "a".repeat(40);
  const apiDigest = `sha256:${"b".repeat(64)}`;
  const edgeDigest = `sha256:${"c".repeat(64)}`;
  const postgresDigest = `sha256:${"d".repeat(64)}`;
  const repository = "thevladbog/markiro";
  const publisherIdentity = { repository, repositoryId: "1", ownerId: "2" };
  const legacy = {
    product: "handheld",
    environment: "handheld-release",
    workflowSha: sourceSha,
    workflowRef: `${repository}/.github/workflows/handheld-release.yml@refs/heads/main`,
    subject: `repo:${repository}:environment:handheld-release`,
  };
  const pinnedPublisherConfig = {
    ...publisherIdentity,
    workflows: ["handheld", "standalone"].map((product) => {
      const environment = `${product}-stable-publisher`;
      const workflowRef = `${repository}/.github/workflows/${product}-stable-release.yml@refs/tags/${product}-publisher-v1`;
      return {
        product,
        environment,
        mode: "pinned-tag",
        workflowRef,
        jobWorkflowRef: workflowRef,
        workflowSha: sourceSha,
        jobWorkflowSha: sourceSha,
        subject: `repo:${repository}:environment:${environment}`,
      };
    }),
  };
  const environment = {
    MARKIRO_SOURCE_SHA: sourceSha,
    MARKIRO_TOOLING_SHA: sourceSha,
    MARKIRO_API_IMAGE_DIGEST: apiDigest,
    MARKIRO_PLATFORM_EDGE_IMAGE_DIGEST: edgeDigest,
    MARKIRO_POSTGRES_IMAGE_DIGEST: postgresDigest,
    MARKIRO_RELEASES_BUCKET: "markiro-releases",
    RELEASE_CATALOG_S3_ENDPOINT: "https://s3.twcstorage.ru",
    RELEASE_CATALOG_S3_REGION: "ru-1",
    RELEASE_CATALOG_S3_BUCKET: "markiro-releases",
    RELEASE_CATALOG_S3_ACCESS_KEY_ID: "fixture",
    RELEASE_CATALOG_S3_SECRET_ACCESS_KEY: "synthetic-key",
    RELEASE_CATALOG_CACHE_DIR: "/opt/markiro-platform/release-catalog/cache",
    RELEASE_CATALOG_JOURNAL_DIR: "/opt/markiro-platform/release-catalog/journal",
    RELEASE_CATALOG_CACHE_BYTES: "1048576",
    RELEASE_CATALOG_OBJECT_BYTES: "524288",
    RELEASE_CATALOG_DISK_RESERVE_BYTES: "1048576",
    RELEASE_CATALOG_DOWNLOADS: "2",
    RELEASE_CATALOG_TIMEOUT_MS: "30000",
    RELEASE_CATALOG_WRITERS_ENABLED: "true",
    RELEASE_CATALOG_PUBLISHERS_JSON: JSON.stringify({ ...publisherIdentity, workflows: [legacy] }),
  };
  const env = (values) => Object.entries(values).map(([key, value]) => `${key}=${value}`);
  const putEnv = (path, values) =>
    f.put(join(host, path), Buffer.from(env(values).join("\n") + "\n"));
  await putEnv(runtimePath, environment);
  const runtimeSha256 = await sha256(join(host, runtimePath));

  const volumeName = "markiro-platform_postgres-data";
  const volume = {
    Name: volumeName,
    CreatedAt: "2026-10-25T00:00:00Z",
    Driver: "local",
    Options: null,
    Mountpoint: `/var/lib/docker/volumes/${volumeName}/_data`,
    Labels: {
      "com.docker.compose.project": "markiro-platform",
      "com.docker.compose.volume": "postgres-data",
    },
  };
  const networks = Object.fromEntries(
    ["default", "database"].map((name, index) => [
      name,
      {
        Name: `markiro-platform_${name}`,
        Id: String(index + 1).repeat(64),
        Driver: "bridge",
        Scope: "local",
        Internal: name === "database",
        Attachable: false,
        Ingress: false,
        Labels: {
          "com.docker.compose.project": "markiro-platform",
          "com.docker.compose.network": name,
        },
      },
    ]),
  );
  const target = f.input.identity.target;
  assert.equal(target.volumeId, volumeName);
  const databaseMount = {
    Name: volume.Name,
    Type: "volume",
    Source: volume.Mountpoint,
    Destination: "/var/lib/postgresql/data",
  };
  const images = {
    api: `ghcr.io/thevladbog/markiro-api@${apiDigest}`,
    edge: `ghcr.io/thevladbog/markiro-platform-edge@${edgeDigest}`,
    postgres: `postgres:17-alpine@${postgresDigest}`,
  };
  const inspected = Object.fromEntries(
    Object.keys(images).map((service, index) => [
      service,
      {
        Id:
          service === "postgres"
            ? f.input.baseline.containers.postgres
            : String(index + 6).repeat(64),
        Image: `sha256:${String(index + 4).repeat(64)}`,
        Config: {
          Image: images[service],
          Env:
            service === "api"
              ? env(environment)
              : service === "edge"
                ? [`MARKIRO_RELEASE_SHA=${sourceSha}`]
                : [],
          Labels: {
            "com.docker.compose.project": "markiro-platform",
            "com.docker.compose.service": service,
          },
        },
        HostConfig: {},
        Mounts: service === "postgres" ? [databaseMount] : [],
        State: {
          Running: true,
          Paused: false,
          Restarting: false,
          Dead: false,
          Status: "running",
          Health: service === "edge" ? undefined : { Status: "healthy" },
        },
        NetworkSettings: {
          Networks: Object.fromEntries(
            (service === "api"
              ? ["default", "database"]
              : [service === "edge" ? "default" : "database"]
            ).map((name) => [networks[name].Name, { NetworkID: networks[name].Id }]),
          ),
        },
      },
    ]),
  );
  const containers = Object.fromEntries(
    Object.entries(inspected).map(([name, row]) => [
      name,
      {
        id: row.Id,
        imageId: row.Image,
        recipeSha256: containerRecipe(row),
      },
    ]),
  );
  const recorded = ({ Id, Image }) => ({ id: Id, image: Image });
  const receipt = {
    runtimePath: join(host, runtimePath),
    runtimeSha256,
    api: recorded(inspected.api),
    preserved: { edge: recorded(inspected.edge), postgres: recorded(inspected.postgres) },
  };
  await f.put(join(host, receiptPath), receipt);
  const schema = structuredClone(f.input.baseline.schema);
  schema.schemaSha256 = "2".repeat(64);
  const rows = f.productMigrationProof.entries.map(({ hash, createdAt }) => ({ hash, createdAt }));
  const ledger = { schema: structuredClone(schema), rows };
  const observationPolicy = {
    machineId: target.hostId,
    dockerId: "fixture-docker",
    postgresImageId: inspected.postgres.Image,
    volume: { name: volume.Name, createdAt: volume.CreatedAt, mountpoint: volume.Mountpoint },
    networks: Object.fromEntries(
      Object.entries(networks).map(([name, row]) => [name, { id: row.Id, name: row.Name }]),
    ),
  };
  const candidateIdentity = {
    ...structuredClone(f.input.identity),
    operationId: "14abf011-0b87-421a-a1dd-f5c162eb7389",
  };
  const manifest = candidateIdentity.admission.manifest;
  const candidateEnvironment = {
    ...environment,
    MARKIRO_SOURCE_SHA: manifest.sourceSha,
    MARKIRO_TOOLING_SHA: manifest.toolingSha,
    MARKIRO_API_IMAGE_DIGEST: manifest.api.split("@")[1],
    MARKIRO_PLATFORM_EDGE_IMAGE_DIGEST: manifest.edge.split("@")[1],
    RELEASE_CATALOG_PUBLISHERS_JSON: JSON.stringify({
      ...publisherIdentity,
      workflows: [legacy, ...pinnedPublisherConfig.workflows],
    }),
  };
  await putEnv(candidatePath, candidateEnvironment);
  const input = {
    root: f.root,
    predecessor,
    drift: { receiptPath, receiptSha256: await sha256(join(host, receiptPath)) },
    runtime: { path: runtimePath, sha256: runtimeSha256, containers, observationPolicy, schema },
    candidateRuntime: { path: candidatePath, sha256: await sha256(join(host, candidatePath)) },
    pinnedPublisherConfig,
    candidateIdentity,
    predecessorMigrationProof: f.productMigrationProof,
    candidateMigrationProof: f.productMigrationProof,
  };
  const commands = [];
  const dependencies = {
    verifyAuthority: async () => {},
    readMachineId: async () => target.hostId,
    runProcess: async ({ args, executable }) => {
      assert.equal(executable, "/usr/bin/docker");
      assert.deepEqual(args.slice(0, 2), ["--host", "unix:///var/run/docker.sock"]);
      const command = args.slice(2);
      commands.push(command);
      let result;
      if (command[0] === "info")
        result = { ID: observationPolicy.dockerId, OSType: "linux", Architecture: "x86_64" };
      else if (command[0] === "ps")
        return {
          stdout: Object.values(inspected)
            .map((row) => row.Id)
            .join("\n"),
        };
      else if (command[0] === "container" && command[1] === "inspect")
        result = Object.values(inspected);
      else if (command[0] === "volume" && command[1] === "inspect") result = [volume];
      else if (command[0] === "network" && command[1] === "inspect")
        result = Object.values(networks);
      else if (command[0] === "exec") {
        assert.ok(command.includes(inspected.postgres.Id));
        assert.equal(command.at(-1), forwardMigrationQuery);
        assert.ok(
          command.includes(
            "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=3000",
          ),
        );
        result = ledger;
      } else assert.fail(`Unexpected Docker command: ${command.join(" ")}`);
      return { stdout: JSON.stringify(result) };
    },
  };
  return {
    ...f,
    input,
    dependencies,
    host,
    runtimePath,
    receiptPath,
    inspected,
    ledger,
    receipt,
    commands,
    candidateEnvironment,
    putEnv,
  };
}

test("preflight validates healthy forward rollout evidence", async (t) => {
  const f = await fixture(t);
  const refusal = { code: "ERR_HEALTHY_FORWARD_PREFLIGHT" };
  const verify = (input = f.input, dependencies = f.dependencies) =>
    verifyHealthyForwardPreflight(input, dependencies);

  await t.test("binds healthy history, actual drift, the candidate policy and ledger", async () => {
    const result = await verify();
    assert.equal(result.predecessorOperationId, f.input.predecessor.operationId);
    assert.equal(result.sourceSha, "a".repeat(40));
    assert.deepEqual(result.containers, f.input.runtime.containers);
    assert.deepEqual(result.schema, f.input.runtime.schema);
    assert.equal(result.productMigrationProofSha256, f.input.candidateMigrationProof.proofSha256);
    assert.ok(Object.isFrozen(result.containers.api));
    assert.ok(f.commands.some((command) => command[0] === "exec"));
  });

  await t.test("accepts drift-bound API and edge created from local image IDs", async (t) => {
    const { runtime } = f.input;
    const containers = { ...runtime.containers };
    for (const service of ["api", "edge"]) {
      const observed = f.inspected[service];
      const reference = observed.Config.Image;
      t.after(() => {
        observed.Config.Image = reference;
      });
      observed.Config.Image = observed.Image;
      containers[service] = { ...containers[service], recipeSha256: containerRecipe(observed) };
    }
    const result = await verify({ ...f.input, runtime: { ...runtime, containers } });
    assert.deepEqual(result.containers, containers);
  });

  await t.test("a stopped source requires the same containers and no active API", async (t) => {
    const { api, edge } = f.inspected;
    const runningApi = api.State;
    const runningEdge = edge.State;
    t.after(() => {
      api.State = runningApi;
      edge.State = runningEdge;
    });
    api.State = { ...runningApi, Running: false, Status: "exited" };
    edge.State = { ...runningEdge, Running: false, Status: "exited" };
    const stopped = () =>
      withStoppedHealthyForwardSource(f.input, f.dependencies, async ({ owned, config }) => {
        assert.deepEqual(
          owned.filter(({ active }) => active).map(({ service }) => service),
          ["postgres"],
        );
        assert.equal(config.MARKIRO_SOURCE_SHA, "a".repeat(40));
        return config;
      });
    const result = await stopped();
    assert.equal(result.containers.postgres.id, f.input.runtime.containers.postgres.id);
    assert.equal(Object.hasOwn(result, "config"), false);
    api.State = runningApi;
    await assert.rejects(stopped(), refusal);
  });

  await t.test(
    "a mixed rollout binds candidate API, stopped source edge, and exact Postgres",
    async (t) => {
      const { api, edge, postgres } = f.inspected;
      const edgeState = edge.State;
      const postgresId = postgres.Id;
      t.after(() => {
        f.inspected.api = api;
        edge.State = edgeState;
        postgres.Id = postgresId;
      });
      const admitted = f.input.candidateIdentity.admission;
      const candidateApi = {
        ...api,
        Id: "d".repeat(64),
        Image: admitted.registry.api.imageId,
        Config: {
          ...api.Config,
          Image: admitted.manifest.api,
          Env: Object.entries(f.candidateEnvironment).map(([key, value]) => `${key}=${value}`),
        },
      };
      f.inspected.api = candidateApi;
      edge.State = { ...edgeState, Running: false, Status: "exited" };
      const candidateDescriptor = {
        id: candidateApi.Id,
        imageId: candidateApi.Image,
        recipeSha256: containerRecipe(candidateApi),
      };
      const mixed = () =>
        verifyHealthyForwardPreflight(f.input, f.dependencies, {
          phase: "api-started",
          candidateContainers: { api: candidateDescriptor },
        });
      const result = await mixed();
      assert.equal(result.containers.api.id, candidateApi.Id);
      assert.equal(result.containers.edge.id, f.input.runtime.containers.edge.id);
      assert.equal(result.containers.postgres.id, postgresId);
      candidateApi.Config.Image = candidateApi.Image;
      await assert.rejects(
        verifyHealthyForwardPreflight(f.input, f.dependencies, {
          phase: "api-started",
          candidateContainers: {
            api: { ...candidateDescriptor, recipeSha256: containerRecipe(candidateApi) },
          },
        }),
        refusal,
      );
      candidateApi.Config.Image = admitted.manifest.api;
      postgres.Id = "f".repeat(64);
      await assert.rejects(mixed(), refusal);
    },
  );

  await t.test(
    "rejects a failed predecessor even with the corresponding reviewed digests",
    async (t) => {
      f.commands.length = 0;
      const { predecessor } = f.input;
      const statePath = join(
        f.root,
        "forward-recovery-operations",
        predecessor.operationId,
        "state.json",
      );
      const indexPath = join(f.root, "upgrade-index.json");
      const stateBytes = await readFile(statePath);
      const indexBytes = await readFile(indexPath);
      t.after(async () => {
        await f.put(statePath, stateBytes);
        await f.put(indexPath, indexBytes);
      });
      await f.put(statePath, { ...JSON.parse(stateBytes), status: "recovery-required" });
      const stateSha256 = digest(await readFile(statePath));
      await f.put(indexPath, { ...JSON.parse(indexBytes), stateSha256 });
      const indexSha256 = digest(await readFile(indexPath));
      await assert.rejects(
        verify({ ...f.input, predecessor: { ...predecessor, stateSha256, indexSha256 } }),
        refusal,
      );
      assert.deepEqual(f.commands, []);
    },
  );

  await t.test("rejects a reviewed receipt for a different API container", async (t) => {
    f.commands.length = 0;
    const path = join(f.host, f.receiptPath);
    const original = await readFile(path);
    t.after(() => f.put(path, original));
    await f.put(path, { ...f.receipt, api: { ...f.receipt.api, id: "d".repeat(64) } });
    const drift = { ...f.input.drift, receiptSha256: digest(await readFile(path)) };
    await assert.rejects(verify({ ...f.input, drift }), refusal);
    assert.deepEqual(f.commands, []);
  });

  await t.test("rejects a different live recipe on the same API container", async (t) => {
    f.commands.length = 0;
    f.inspected.api.Config.Labels["fixture.changed"] = "true";
    t.after(() => {
      delete f.inspected.api.Config.Labels["fixture.changed"];
    });
    await assert.rejects(verify(), refusal);
    assert.ok(f.commands.some((command) => command[0] === "container"));
    assert.ok(f.commands.every((command) => command[0] !== "exec"));
  });

  await t.test("rejects an API missing a value from the preserved runtime", async (t) => {
    const { runtime } = f.input;
    const { Config } = f.inspected.api;
    const original = Config.Env;
    t.after(() => {
      Config.Env = original;
    });
    Config.Env = original.filter((entry) => !entry.startsWith("RELEASE_CATALOG_DOWNLOADS="));
    const api = { ...runtime.containers.api, recipeSha256: containerRecipe(f.inspected.api) };
    await assert.rejects(
      verify({ ...f.input, runtime: { ...runtime, containers: { ...runtime.containers, api } } }),
      refusal,
    );
  });

  await t.test("rejects a changed migration hash at the same schema count", async (t) => {
    f.commands.length = 0;
    const original = f.ledger.rows[0].hash;
    t.after(() => {
      f.ledger.rows[0].hash = original;
    });
    f.ledger.rows[0].hash = "e".repeat(64);
    await assert.rejects(verify(), refusal);
    assert.ok(f.commands.some((command) => command[0] === "exec"));
  });

  await t.test("rejects an unrelated change in the exact candidate runtime bytes", async (t) => {
    f.commands.length = 0;
    const candidate = f.input.candidateRuntime;
    const path = join(f.host, candidate.path);
    const original = await readFile(path);
    t.after(() => f.put(path, original));
    await f.putEnv(candidate.path, {
      ...f.candidateEnvironment,
      RELEASE_CATALOG_WRITERS_ENABLED: "false",
    });
    const candidateRuntime = { ...candidate, sha256: digest(await readFile(path)) };
    await assert.rejects(verify({ ...f.input, candidateRuntime }), refusal);
    assert.deepEqual(f.commands, []);
  });

  await t.test(
    "rechecks private inputs after observing the host without exposing their values",
    async () => {
      const runProcess = async (request) => {
        const result = await f.dependencies.runProcess(request);
        if (request.args[2] === "exec")
          await f.put(join(f.host, f.runtimePath), Buffer.from("PRIVATE_SENTINEL=value\n"));
        return result;
      };
      await assert.rejects(
        verify(f.input, { ...f.dependencies, runProcess }),
        (error) => error.code === refusal.code && !String(error).includes("PRIVATE_SENTINEL"),
      );
    },
  );
});
