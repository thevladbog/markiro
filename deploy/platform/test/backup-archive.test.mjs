import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { privateFixture } from "./host-fixtures.mjs";
import { fakeDocker } from "./backup-runtime-fixture.mjs";
import { createDatabaseBackup } from "../backup/archive.mjs";
import { readPrivateFile, inventoryDocumentOptions } from "../host/files.mjs";
import { mapInventory } from "../backup/inventory.mjs";
import { verifyDatabaseRestore } from "../backup/restore.mjs";
import { catalogTables } from "../backup/catalog.mjs";
import { canonical, digest } from "../backup/schemas.mjs";

for (const scenario of [
  "complete",
  "production-sized",
  "oversized",
  "final-fence-failure",
  "catalog-complete",
  "catalog-missing-journal",
  "catalog-missing-snapshot",
  "catalog-journal-changed",
])
  test(`backup ${scenario}`, async (t) => {
    const nearLimit = scenario === "oversized";
    const large = nearLimit || scenario === "production-sized";
    const capacity = nearLimit ? inventoryDocumentOptions.maxBytes : 1051095 + 1024;
    const { root } = await privateFixture(t);
    const operationId = randomUUID();
    const target = { hostId: "local", databaseId: "markiro", volumeId: "owned" };
    const image = `sha256:${"e".repeat(64)}`;
    await writeFile(
      join(root, "backup-runtime.json"),
      canonical({
        version: 1,
        executorSha: "d".repeat(40),
        dockerExecutable: "/usr/bin/docker",
        endpoint: "unix:///synthetic.sock",
        image,
        provenance: "local-synthetic",
      }),
      { mode: 0o600 },
    );
    for (const name of ["service.conf", "password", "ca.crt"])
      await writeFile(join(root, name), "private fixture", { mode: 0o600 });
    const connectionFile = join(root, "connection.json");
    await writeFile(
      connectionFile,
      canonical({
        version: 1,
        kind: "platform-backup-connection",
        operationId,
        target,
        service: "backup",
        serviceFile: join(root, "service.conf"),
        passFile: join(root, "password"),
        caFile: join(root, "ca.crt"),
        network: "owned-network",
      }),
      { mode: 0o600 },
    );
    const captured = {
      snapshotId: "00000001-00000002-1",
      postgresVersion: "17.11",
      inventory: {
        roles: [],
        memberships: [],
        objects: [],
        defaultPrivileges: [],
        extensions: [],
        tables: [],
        sequences: [],
        indexes: [],
        constraints: [],
        triggers: [],
        migrationJournal: null,
      },
    };
    const catalog = scenario.startsWith("catalog-");
    const catalogJournal = join(root, "journal");
    if (catalog) {
      if (scenario !== "catalog-missing-journal") await mkdir(catalogJournal, { mode: 0o700 });
      captured.catalogState = catalogTables.map((name) => ({
        name,
        rows:
          name === "release_catalog_epochs"
            ? [
                JSON.stringify({
                  id: randomUUID(),
                  product: "handheld",
                  channel: "stable",
                  enabled: false,
                }),
              ]
            : [],
      }));
      captured.inventory.tables = captured.catalogState.map((t) => ({
        schema: "public",
        name: t.name,
        count: String(t.rows.length),
        sha256: digest(
          t.rows
            .map(digest)
            .sort()
            .map((h) => h + "\n")
            .join(""),
        ),
      }));
      if (scenario === "catalog-missing-snapshot") delete captured.catalogState;
    }
    if (large) {
      // Valid identifiers and multibyte UTF-8 make this a byte, not character, boundary.
      for (let n = 0; n < 5500; n++)
        captured.inventory.tables.push({
          schema: "public",
          name: `table_${n}_${"я".repeat(15)}`,
          count: "0",
          sha256: "f".repeat(64),
        });
    }
    let bytes = canonical(captured) + "\n";
    if (large) {
      let size = Buffer.byteLength(bytes);
      while (size < capacity - 256) {
        const n = captured.inventory.tables.length;
        const row = { schema: "public", name: `table_${n}`, count: "0", sha256: "f".repeat(64) };
        captured.inventory.tables.push(row);
        size += Buffer.byteLength(canonical(row)) + 1;
      }
    }
    bytes = canonical(captured) + "\n";
    assert.ok(Buffer.byteLength(bytes) <= capacity);
    if (large) assert.ok(Buffer.byteLength(bytes) > capacity - 400);
    const docker = fakeDocker({ root, operationId, image });
    const beganAt = new Date().toISOString(),
      fenceId = randomUUID();
    const run = async (spec) => {
      const response = await docker.run(spec);
      const a = spec.args.slice(2);
      if (a[0] === "cp" && a[1].includes("/work/out/.")) {
        await writeFile(join(a[2], "inventory.json"), bytes, { mode: 0o600 });
        await writeFile(join(a[2], "database.dump"), "PGDMP synthetic fixture", { mode: 0o600 });
      }
      return response;
    };
    const request = {
      root,
      operationId,
      target,
      connectionFile,
      ...(catalog
        ? { catalogJournal: { path: catalogJournal, uid: process.getuid(), optional: true } }
        : {}),
      run,
      writerFence: {
        observe: async ({ boundary }) => {
          if (boundary === "after-snapshot") {
            if (scenario === "catalog-journal-changed")
              await writeFile(join(catalogJournal, `${randomUUID()}.json`), "{}", { mode: 0o600 });
            assert.equal(docker.containers.size + docker.volumes.size, 0);
            for (const name of ["database.dump", "inventory.json"])
              await assert.rejects(readFile(join(root, `backup-${operationId}`, name)), {
                code: "ENOENT",
              });
            if (scenario === "final-fence-failure") throw new Error("private observation failure");
          }
          return {
            version: 1,
            kind: "platform-writer-fence",
            operationId,
            target,
            fenceId,
            enforcementSha256: "c".repeat(64),
            beganAt,
            observedAt: new Date().toISOString(),
            boundary,
            held: true,
          };
        },
      },
    };
    const directory = join(root, `backup-${operationId}`);
    if (
      nearLimit ||
      scenario === "final-fence-failure" ||
      (catalog && scenario !== "catalog-complete")
    ) {
      let failureError;
      try {
        await createDatabaseBackup(request);
      } catch (error) {
        failureError = error;
      }
      assert.ok(failureError);
      for (const name of ["database.dump", "inventory.json", "input", "output"])
        await assert.rejects(readFile(join(directory, name)), { code: "ENOENT" });
      if (nearLimit) assert.ok(failureError.stage?.startsWith("inventory-limit-"));
      else if (!catalog) assert.equal(failureError.stage, "fence-validation");
      const failure = JSON.parse(await readPrivateFile(directory, "failure.json"));
      assert.equal(failure.status, "recovery-required");
      assert.equal(failure.cleanup.verified, true);
    } else {
      const backup = await createDatabaseBackup(request);
      const published = await readPrivateFile(
        directory,
        "inventory.json",
        inventoryDocumentOptions,
      );
      const document = JSON.parse(published);
      if (catalog)
        assert.deepEqual(document.catalogBackup, {
          schema: 1,
          state: captured.catalogState,
          journal: [],
        });
      assert.equal(digest(published), backup.inventorySha256);
      assert.equal(document.archiveSha256, digest(await readFile(backup.archivePath)));
      assert.deepEqual(document.inventory, captured.inventory);
      if (scenario === "production-sized") {
        assert.ok(published.length > 1051095);
        const roleMapping = { version: 1, roles: [], allowedDeltas: [] };
        const restoreDocker = fakeDocker({
          root,
          operationId,
          image,
          restored: {
            inventory: mapInventory(captured.inventory, roleMapping),
            postgresVersion: "17.11",
          },
        });
        const restoreEvidence = await verifyDatabaseRestore({
          root,
          operationId,
          target,
          backup,
          roleMapping,
          run: restoreDocker.run,
        });
        assert.equal(restoreDocker.containers.size + restoreDocker.volumes.size, 0);
        assert.ok(restoreEvidence.evidenceSha256);
        await assert.rejects(readPrivateFile(directory, "inventory.json"));
      }
    }
    assert.equal(docker.containers.size + docker.volumes.size, 0);
  });
