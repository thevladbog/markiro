import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { writeFile, readFile, appendFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { privateFixture } from "./host-fixtures.mjs";
import { verifyDatabaseRestore, validateBackupInventory } from "../backup/restore.mjs";
import { completedEvidence, canonical, digest, fence } from "../backup/schemas.mjs";
const inventory = () => ({
  roles: [],
  memberships: [],
  objects: [],
  defaultPrivileges: [],
  extensions: [],
  tables: [],
  sequences: [],
  indexes: [],
  constraints: [],
  migrationJournal: null,
});
async function fixture(t) {
  const { root } = await privateFixture(t),
    operationId = randomUUID(),
    target = { hostId: "local", databaseId: "markiro", volumeId: "owned" };
  const archivePath = join(root, "database.dump"),
    inventoryPath = join(root, "inventory.json"),
    bytes = Buffer.from("PGDMP synthetic unit fixture");
  await writeFile(archivePath, bytes, { mode: 0o600 });
  const now = new Date().toISOString();
  const observation = {
    version: 1,
    kind: "platform-writer-fence",
    operationId,
    target,
    fenceId: randomUUID(),
    enforcementSha256: "c".repeat(64),
    beganAt: now,
    observedAt: now,
    held: true,
  };
  const document = {
    version: 1,
    kind: "platform-database-backup",
    operationId,
    target,
    executorSha: "d".repeat(40),
    provenance: "local-synthetic",
    archiveSha256: digest(bytes),
    archiveBytes: bytes.length,
    snapshotId: "00000001-00000002-1",
    fence: {
      before: { ...observation, boundary: "before-snapshot" },
      after: { ...observation, boundary: "after-snapshot" },
    },
    startedAt: now,
    completedAt: now,
    runtime: { image: `sha256:${"e".repeat(64)}`, architecture: "arm64", postgresVersion: "17.11" },
    inventory: inventory(),
  };
  await writeFile(inventoryPath, canonical(document), { mode: 0o600 });
  const backup = {
    archivePath,
    archiveSha256: digest(bytes),
    inventoryPath,
    inventorySha256: digest(canonical(document)),
  };
  return {
    root,
    operationId,
    target,
    backup,
    document,
    roleMapping: { version: 1, roles: [], allowedDeltas: [] },
  };
}
for (const mutation of [
  "changed",
  "truncated",
  "wrong-operation",
  "wrong-target",
  "linked",
  "metadata",
])
  test(`restore rejects ${mutation} before starting resources`, async (t) => {
    const f = await fixture(t);
    let runs = 0;
    if (mutation === "changed") await appendFile(f.backup.archivePath, "x");
    if (mutation === "truncated") await writeFile(f.backup.archivePath, "PGDMP", { mode: 0o600 });
    if (mutation === "wrong-operation") f.operationId = randomUUID();
    if (mutation === "wrong-target") f.target.volumeId = "other";
    if (mutation === "linked") {
      await symlink(f.backup.archivePath, join(f.root, "linked"));
      f.backup.archivePath = join(f.root, "linked");
    }
    if (mutation === "metadata") await appendFile(f.backup.inventoryPath, " ");
    await assert.rejects(
      verifyDatabaseRestore({
        ...f,
        run: async () => {
          runs++;
          throw new Error("should not run");
        },
      }),
    );
    assert.equal(runs, 0);
  });
test("incomplete/failed restore evidence cannot be accepted", async (t) => {
  const f = await fixture(t);
  for (const status of ["recovery-required", "failed", "pending"])
    assert.throws(() => completedEvidence({ status }, { ...f, ...f.backup }));
});
test("fence observation must be fresh and exact-operation/target bound", async (t) => {
  const f = await fixture(t),
    v = f.document.fence.before;
  assert.deepEqual(fence(v, f.operationId, f.target, "before-snapshot"), v);
  assert.throws(() =>
    fence(
      { ...v, observedAt: "2020-01-01T00:00:00.000Z" },
      f.operationId,
      f.target,
      "before-snapshot",
    ),
  );
  assert.throws(() => fence({ ...v, held: false }, f.operationId, f.target, "before-snapshot"));
  assert.throws(() =>
    validateBackupInventory({ ...f.document, operationId: randomUUID() }, { ...f, ...f.backup }),
  );
});
test("failed resource creation publishes recovery-required evidence, never completion", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.root, "backup-runtime.json"),
    canonical({
      version: 1,
      executorSha: f.document.executorSha,
      dockerExecutable: "/usr/bin/docker",
      endpoint: "unix:///synthetic.sock",
      image: f.document.runtime.image,
      provenance: "local-synthetic",
    }),
    { mode: 0o600 },
  );
  const run = async ({ args }) => {
    const a = args.slice(2);
    if (a[0] === "image")
      return {
        stdout: Buffer.from(
          canonical([
            {
              Id: f.document.runtime.image,
              Os: "linux",
              Architecture: "arm64",
              Config: { Volumes: { "/var/lib/postgresql/data": {} } },
            },
          ]),
        ),
      };
    if (a[0] === "volume" && a[1] === "ls") return { stdout: Buffer.from("") };
    throw new Error("controlled creation failure");
  };
  await assert.rejects(verifyDatabaseRestore({ ...f, run }));
  const report = JSON.parse(
    await readFile(join(f.root, `restore-${f.operationId}`, "failure.json")),
  );
  assert.equal(report.status, "recovery-required");
  assert.equal(report.cleanup.verified, true);
  await assert.rejects(readFile(join(f.root, `restore-${f.operationId}`, "evidence.json")));
});

test("cleanup failure forbids completed evidence even after a matching restore", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.root, "backup-runtime.json"),
    canonical({
      version: 1,
      executorSha: f.document.executorSha,
      dockerExecutable: "/usr/bin/docker",
      endpoint: "unix:///synthetic.sock",
      image: f.document.runtime.image,
      provenance: "local-synthetic",
    }),
    { mode: 0o600 },
  );
  const { fakeDocker } = await import("./backup-runtime-fixture.mjs");
  const docker = fakeDocker({
    ...f,
    image: f.document.runtime.image,
    failCleanup: true,
    restored: { inventory: f.document.inventory, postgresVersion: "17.11" },
  });
  await assert.rejects(verifyDatabaseRestore({ ...f, run: docker.run }));
  const report = JSON.parse(
    await readFile(join(f.root, `restore-${f.operationId}`, "failure.json")),
  );
  assert.equal(report.status, "recovery-required");
  assert.equal(report.cleanup.verified, false);
  await assert.rejects(readFile(join(f.root, `restore-${f.operationId}`, "evidence.json")));
  assert.ok(docker.calls.some((c) => c.args.includes("--network") && c.args.includes("none")));
  assert.ok(
    docker.calls.every(
      (c) => !Object.keys(c.env).some((k) => k === "PGPASSWORD" || k === "DATABASE_URL"),
    ),
  );
});
test("partial restored inventory is rejected and labelled resources removed", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.root, "backup-runtime.json"),
    canonical({
      version: 1,
      executorSha: f.document.executorSha,
      dockerExecutable: "/usr/bin/docker",
      endpoint: "unix:///synthetic.sock",
      image: f.document.runtime.image,
      provenance: "local-synthetic",
    }),
    { mode: 0o600 },
  );
  const { fakeDocker } = await import("./backup-runtime-fixture.mjs");
  const actual = inventory();
  actual.tables.push({ schema: "public", name: "unexpected", count: "0", sha256: "f".repeat(64) });
  const docker = fakeDocker({
    ...f,
    image: f.document.runtime.image,
    restored: { inventory: actual, postgresVersion: "17.11" },
  });
  await assert.rejects(verifyDatabaseRestore({ ...f, run: docker.run }));
  const report = JSON.parse(
    await readFile(join(f.root, `restore-${f.operationId}`, "failure.json")),
  );
  assert.equal(report.status, "recovery-required");
  assert.equal(report.cleanup.verified, true);
  assert.equal(docker.containers.size + docker.volumes.size, 0);
});
test("failed dump never publishes archive or inventory and cleans owned resources", async (t) => {
  const f = await fixture(t);
  const image = f.document.runtime.image;
  await writeFile(
    join(f.root, "backup-runtime.json"),
    canonical({
      version: 1,
      executorSha: f.document.executorSha,
      dockerExecutable: "/usr/bin/docker",
      endpoint: "unix:///synthetic.sock",
      image,
      provenance: "local-synthetic",
    }),
    { mode: 0o600 },
  );
  for (const name of ["service.conf", "password", "ca.crt"])
    await writeFile(join(f.root, name), "private fixture", { mode: 0o600 });
  const connectionFile = join(f.root, "connection.json");
  await writeFile(
    connectionFile,
    canonical({
      version: 1,
      kind: "platform-backup-connection",
      operationId: f.operationId,
      target: f.target,
      service: "backup",
      serviceFile: join(f.root, "service.conf"),
      passFile: join(f.root, "password"),
      caFile: join(f.root, "ca.crt"),
      network: "owned-network",
    }),
    { mode: 0o600 },
  );
  const { fakeDocker } = await import("./backup-runtime-fixture.mjs");
  const docker = fakeDocker({ ...f, image, failDump: true });
  const { createDatabaseBackup } = await import("../backup/archive.mjs");
  await assert.rejects(
    createDatabaseBackup({
      ...f,
      connectionFile,
      run: docker.run,
      writerFence: { observe: async () => f.document.fence.before },
    }),
  );
  const directory = join(f.root, `backup-${f.operationId}`);
  await assert.rejects(readFile(join(directory, "database.dump")));
  await assert.rejects(readFile(join(directory, "inventory.json")));
  assert.equal(
    JSON.parse(await readFile(join(directory, "failure.json"))).status,
    "recovery-required",
  );
  assert.equal(docker.containers.size + docker.volumes.size, 0);
});

test("an existing volume is never initialized or claimed by a new restore", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.root, "backup-runtime.json"),
    canonical({
      version: 1,
      executorSha: f.document.executorSha,
      dockerExecutable: "/usr/bin/docker",
      endpoint: "unix:///synthetic.sock",
      image: f.document.runtime.image,
      provenance: "local-synthetic",
    }),
    { mode: 0o600 },
  );
  const { fakeDocker } = await import("./backup-runtime-fixture.mjs"),
    docker = fakeDocker({
      ...f,
      image: f.document.runtime.image,
      restored: { inventory: f.document.inventory, postgresVersion: "17.11" },
    });
  const name = `markiro-backup-${f.operationId}-restore-data`;
  docker.volumes.add(name);
  await assert.rejects(verifyDatabaseRestore({ ...f, run: docker.run }));
  assert.ok(docker.volumes.has(name));
  assert.ok(!docker.calls.some((c) => c.args[2] === "create"));
});
