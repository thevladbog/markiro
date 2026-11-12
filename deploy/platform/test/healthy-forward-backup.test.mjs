import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import test from "node:test";
import { catalogTables } from "../backup/catalog.mjs";
import { mapInventory } from "../backup/inventory.mjs";
import { digest } from "../backup/schemas.mjs";
import { CATALOG_ROOT } from "../catalog-config.mjs";
import { containerRecipe } from "../host/container-recipe.mjs";
import {
  observeHealthyForwardCatalogCustody,
  verifyHealthyForwardBackup,
  verifyHealthyForwardCatalogCustody,
} from "../host/healthy-forward-backup.mjs";
import { privateFixture } from "./host-fixtures.mjs";
import { preparedFixture } from "./prepared-target-fixture.mjs";
import { retainedCatalogWorkerFixture } from "./retained-catalog-worker-fixture.mjs";

async function backupFixture(t) {
  const fixture = await preparedFixture(t);
  const { document, evidence, root, identity, backup, restoreEvidence } = fixture;
  const { roleMapping } = fixture.expected;
  const migrationJournal = { count: "204", sha256: "e".repeat(64) };
  document.inventory.migrationJournal = migrationJournal;
  document.inventory.tables = [
    { schema: "drizzle", name: "__drizzle_migrations", ...migrationJournal },
    ...catalogTables.map((name) => ({ schema: "public", name, count: "0", sha256: digest("") })),
  ];
  document.catalogBackup = {
    schema: 1,
    state: catalogTables.map((name) => ({ name, rows: [] })),
    journal: [],
  };
  document.provenance = evidence.provenance = "live-source";
  evidence.restoredInventorySha256 = digest(mapInventory(document.inventory, roleMapping));
  await fixture.publish();
  const liveFence = {
    ...document.fence.after,
    boundary: "prepared-target",
    observedAt: new Date().toISOString(),
  };
  const input = { root, identity, backup, restoreEvidence, migrationJournal, roleMapping };
  const dependencies = { observeFence: async () => liveFence };
  return { ...fixture, input, dependencies, liveFence };
}

test("rollout backup binds the archive and restored inventory to the current writer fence", async (t) => {
  const fixture = await backupFixture(t);
  const { input, dependencies } = fixture;
  const result = await verifyHealthyForwardBackup(input, dependencies);
  assert.deepEqual(result, {
    archiveSha256: input.backup.archiveSha256,
    restoreEvidenceSha256: input.restoreEvidence.evidenceSha256,
    operationId: input.identity.operationId,
    target: input.identity.target,
  });
  assert.ok(Object.isFrozen(result.target));

  const refusal = { code: "ERR_HEALTHY_FORWARD_BACKUP" };
  await assert.rejects(
    verifyHealthyForwardBackup(
      {
        ...input,
        migrationJournal: { ...input.migrationJournal, sha256: "f".repeat(64) },
      },
      dependencies,
    ),
    refusal,
  );
  await assert.rejects(
    verifyHealthyForwardBackup(input, {
      observeFence: async () => ({ ...fixture.liveFence, fenceId: randomUUID() }),
    }),
    refusal,
  );
  await assert.rejects(
    verifyHealthyForwardBackup(input, {
      observeFence: async () => ({ ...fixture.liveFence, beganAt: "2020-01-01T00:00:00.000Z" }),
    }),
    refusal,
  );
  fixture.evidence.restoredInventorySha256 = "a".repeat(64);
  await fixture.publish();
  await assert.rejects(verifyHealthyForwardBackup(input, dependencies), refusal);
});

test("rollout backup rejects valid synthetic and catalog-free archives", async (t) => {
  const fixture = await backupFixture(t);
  const { input, dependencies, document, evidence } = fixture;
  const refusal = { code: "ERR_HEALTHY_FORWARD_BACKUP" };
  document.provenance = evidence.provenance = "local-synthetic";
  await fixture.publish();
  await assert.rejects(verifyHealthyForwardBackup(input, dependencies), refusal);
  document.provenance = evidence.provenance = "live-source";
  document.inventory.tables = document.inventory.tables.filter(
    ({ schema }) => schema === "drizzle",
  );
  delete document.catalogBackup;
  evidence.restoredInventorySha256 = digest(mapInventory(document.inventory, input.roleMapping));
  await fixture.publish();
  await assert.rejects(verifyHealthyForwardBackup(input, dependencies), refusal);
});

test("catalog custody exempts only exact journaled stopped workers from the complete mount inventory", async (t) => {
  const f = await privateFixture(t, { nested: true });
  const hostRoot = dirname(f.root);
  const acceptedOperationId = randomUUID();
  const worker = await retainedCatalogWorkerFixture(hostRoot, acceptedOperationId);
  const catalogMounts = ["cache", "journal"].map((name) => {
    const path = `${CATALOG_ROOT}/${name}`;
    return { Source: path, Destination: path, Type: "bind", RW: true };
  });
  worker.worker.Mounts = catalogMounts;
  worker.expected.recipeSha256 = containerRecipe(worker.worker);
  const apiRow = {
    Id: "a".repeat(64),
    Image: `sha256:${"b".repeat(64)}`,
    Config: {
      Labels: {
        "com.docker.compose.project": "markiro-platform",
        "com.docker.compose.service": "api",
      },
    },
    HostConfig: {},
    Mounts: catalogMounts,
  };
  const input = {
    hostRoot,
    acceptedOperationId,
    api: { id: apiRow.Id, imageId: apiRow.Image, recipeSha256: containerRecipe(apiRow) },
    workers: [worker.expected],
    inventory: [apiRow, worker.worker],
    catalogEnvironment: {
      RELEASE_CATALOG_CACHE_DIR: `${CATALOG_ROOT}/cache`,
      RELEASE_CATALOG_JOURNAL_DIR: `${CATALOG_ROOT}/journal`,
    },
    guards: new Map(worker.guards.map(({ path, sha256 }) => [path, sha256])),
  };
  assert.deepEqual(await verifyHealthyForwardCatalogCustody(input), worker.guards);
  const refusal = { code: "ERR_HEALTHY_FORWARD_CATALOG_CUSTODY" };
  await assert.rejects(
    verifyHealthyForwardCatalogCustody({
      ...input,
      inventory: [
        ...input.inventory,
        { Id: "c".repeat(64), Mounts: [{ Source: "/opt/markiro-platform" }] },
      ],
    }),
    refusal,
  );
  await assert.rejects(
    verifyHealthyForwardCatalogCustody({ ...input, guards: new Map() }),
    refusal,
  );
  const running = structuredClone(worker.worker);
  running.State.Running = true;
  await assert.rejects(
    verifyHealthyForwardCatalogCustody({ ...input, inventory: [apiRow, running] }),
    refusal,
  );
  const missingMount = { ...apiRow, Mounts: [catalogMounts[0]] };
  await assert.rejects(
    verifyHealthyForwardCatalogCustody({
      ...input,
      api: { ...input.api, recipeSha256: containerRecipe(missingMount) },
      inventory: [missingMount, worker.worker],
    }),
    refusal,
  );

  const { inventory, ...catalog } = input;
  const volumeName = "markiro-platform_postgres-data";
  const mountpoint = `/var/lib/docker/volumes/${volumeName}/_data`;
  const database = {
    Id: "5".repeat(64),
    Image: `sha256:${"4".repeat(64)}`,
    Config: { Labels: { "com.docker.compose.service": "postgres" } },
    HostConfig: {},
    State: { Running: true, Health: { Status: "healthy" } },
    Mounts: [
      {
        Name: volumeName,
        Source: mountpoint,
        Type: "volume",
        Destination: "/var/lib/postgresql/data",
      },
    ],
  };
  const observationPolicy = {
    machineId: "3".repeat(32),
    dockerId: "fixture-docker",
    postgresImageId: database.Image,
    volume: { name: volumeName, createdAt: "2026-10-25T00:00:00Z", mountpoint },
    networks: {
      default: { id: "2".repeat(64), name: "markiro-platform_default" },
      database: { id: "1".repeat(64), name: "markiro-platform_database" },
    },
  };
  const observe = (rows) =>
    observeHealthyForwardCatalogCustody(
      {
        ...catalog,
        postgres: {
          id: database.Id,
          imageId: database.Image,
          recipeSha256: containerRecipe(database),
        },
        observationPolicy,
      },
      async (args) => ({
        stdout: args[1] === "ls" ? rows.map(({ Id }) => Id).join("\n") : JSON.stringify(rows),
      }),
    );
  const rows = [...inventory, database];
  assert.deepEqual(await observe(rows), worker.guards);
  await assert.rejects(
    observe([...rows, { Id: "c".repeat(64), Mounts: [{ Source: "/var/lib/docker" }] }]),
  );
  await assert.rejects(
    observe([
      ...rows,
      {
        Id: "c".repeat(64),
        Mounts: [],
        NetworkSettings: {
          Networks: { rogue: { NetworkID: observationPolicy.networks.database.id } },
        },
      },
    ]),
  );
});
