import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { privateFixture } from "./host-fixtures.mjs";
import { fakeDocker } from "./backup-runtime-fixture.mjs";
import { createDatabaseBackup } from "../backup/archive.mjs";
import { readPrivateFile } from "../host/files.mjs";
import { canonical, digest } from "../backup/schemas.mjs";

for (const nearLimit of [false, true])
  test(`backup ${nearLimit ? "rejects an oversized envelope before publishing" : "publishes readable complete metadata"}`, async (t) => {
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
    if (nearLimit) {
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
    if (nearLimit) {
      let size = Buffer.byteLength(bytes);
      while (size < 1048576 - 256) {
        const n = captured.inventory.tables.length;
        const row = { schema: "public", name: `table_${n}`, count: "0", sha256: "f".repeat(64) };
        captured.inventory.tables.push(row);
        size += Buffer.byteLength(canonical(row)) + 1;
      }
    }
    bytes = canonical(captured) + "\n";
    assert.ok(Buffer.byteLength(bytes) <= 1048576);
    if (nearLimit) assert.ok(Buffer.byteLength(bytes) > 1048576 - 400);
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
      run,
      writerFence: {
        observe: async ({ boundary }) => ({
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
        }),
      },
    };
    const directory = join(root, `backup-${operationId}`);
    if (nearLimit) {
      let failureError;
      try {
        await createDatabaseBackup(request);
      } catch (error) {
        failureError = error;
      }
      assert.ok(failureError);
      for (const name of ["database.dump", "inventory.json", "input", "output"])
        await assert.rejects(readFile(join(directory, name)), { code: "ENOENT" });
      assert.ok(failureError.stage?.startsWith("inventory-limit-"));
      const failure = JSON.parse(await readPrivateFile(directory, "failure.json"));
      assert.equal(failure.status, "recovery-required");
      assert.equal(failure.cleanup.verified, true);
    } else {
      const backup = await createDatabaseBackup(request);
      const published = await readPrivateFile(directory, "inventory.json");
      const document = JSON.parse(published);
      assert.equal(digest(published), backup.inventorySha256);
      assert.equal(document.archiveSha256, digest(await readFile(backup.archivePath)));
      assert.deepEqual(document.inventory, captured.inventory);
    }
    assert.equal(docker.containers.size + docker.volumes.size, 0);
  });
