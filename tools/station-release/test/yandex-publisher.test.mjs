import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { stageStationRelease, stationAssetNames } from "../artifacts.mjs";
import { stationReleaseLocation } from "../origins.mjs";
import { createYandexPublisher, runYandexPublisherCli } from "../yandex-publisher.mjs";

const channel = "beta";
const version = "0.2.0-beta.7";
const names = stationAssetNames(version);

async function stageTree(origin, outputDirectory) {
  const input = await mkdtemp(join(tmpdir(), `markiro-yandex-${origin}-input-`));
  for (const [name, bytes] of [
    [names.installer, "installer-bytes"],
    [names.bundle, "bundle-bytes"],
    [names.signature, "trusted-signature"],
  ]) {
    await writeFile(join(input, name), bytes);
  }
  await stageStationRelease({
    channel,
    origin,
    inputDirectory: input,
    outputDirectory,
    version,
    pubDate: "2026-08-20T10:00:00.000Z",
    baseSha: "a".repeat(40),
    releaseSha: "b".repeat(40),
  });
}

async function yandexTree() {
  const root = await mkdtemp(join(tmpdir(), "markiro-yandex-tree-"));
  const tree = join(root, "yandex");
  await stageTree("yandex", tree);
  return tree;
}

async function dualTree() {
  const root = await mkdtemp(join(tmpdir(), "markiro-dual-tree-"));
  await stageTree("github", join(root, "github"));
  await stageTree("yandex", join(root, "yandex"));
  return root;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fakeStore() {
  const calls = [];
  const immutable = new Map();
  const mutable = new Map();
  const preExisting = new Set();
  let readHook;
  return {
    calls,
    immutable,
    mutable,
    preExisting,
    setReadHook(hook) {
      readHook = hook;
    },
    async assertAbsent(key) {
      calls.push({ method: "assertAbsent", key });
      if (preExisting.has(key)) throw new Error("station release object already exists");
    },
    async putImmutable(key, file, contentType) {
      calls.push({ method: "putImmutable", key, contentType });
      immutable.set(key, Buffer.from(await readFile(file)));
    },
    async getMutable(key) {
      calls.push({ method: "getMutable", key });
      return mutable.get(key) ?? null;
    },
    async putMutable(key, bytes, contentType) {
      calls.push({ method: "putMutable", key, contentType });
      mutable.set(key, { bytes: Buffer.from(bytes), contentType });
    },
    async copyImmutableToAlias(input) {
      calls.push({ method: "copyImmutableToAlias", ...input });
      mutable.set(input.aliasKey, {
        bytes: Buffer.from(immutable.get(input.immutableKey)),
        contentType: "application/vnd.microsoft.portable-executable",
      });
    },
    async readPublic(key) {
      calls.push({ method: "readPublic", key });
      if (readHook) await readHook(key, { immutable, mutable, calls });
      const object = immutable.has(key) ? { bytes: immutable.get(key) } : mutable.get(key);
      if (!object) throw new Error("missing public object");
      return Buffer.from(object.bytes);
    },
  };
}

async function loadImmutableTree(store, tree) {
  const location = stationReleaseLocation({ channel, origin: "yandex", version });
  for (const name of Object.values(names)) {
    store.immutable.set(
      `${location.immutablePrefix}${name}`,
      Buffer.from(await readFile(join(tree, name))),
    );
  }
}

function permissionBits(info) {
  return info.mode & 0o777;
}

test("validates a staged tree before the first S3 request", async () => {
  const tree = await yandexTree();
  await writeFile(join(tree, "unexpected.txt"), "unexpected");
  const store = fakeStore();

  await assert.rejects(
    createYandexPublisher({ store }).publishImmutable({ tree, channel, version }),
    /invalid station release publication/,
  );
  assert.deepEqual(store.calls, []);
});

test("checks every immutable collision before uploading any object", async () => {
  const tree = await yandexTree();
  const store = fakeStore();
  const location = stationReleaseLocation({ channel, origin: "yandex", version });
  store.preExisting.add(`${location.immutablePrefix}${names.bundle}`);

  await assert.rejects(
    createYandexPublisher({ store }).publishImmutable({ tree, channel, version }),
    /station release publication failed/,
  );
  assert.equal(
    store.calls.some((call) => call.method === "putImmutable"),
    false,
  );
});

test("publishes and publicly revalidates every immutable release object", async () => {
  const tree = await yandexTree();
  const store = fakeStore();

  await createYandexPublisher({ store }).publishImmutable({ tree, channel, version });

  assert.equal(store.calls.filter((call) => call.method === "assertAbsent").length, 7);
  assert.equal(store.calls.filter((call) => call.method === "putImmutable").length, 7);
  assert.equal(store.calls.filter((call) => call.method === "readPublic").length, 7);
  assert.equal(
    store.calls.some((call) => call.method === "DeleteObject" || call.method === "delete"),
    false,
  );
});

test("rejects public immutable bytes that do not reproduce the staged tree", async () => {
  const tree = await yandexTree();
  const store = fakeStore();
  await loadImmutableTree(store, tree);
  const location = stationReleaseLocation({ channel, origin: "yandex", version });
  store.immutable.set(`${location.immutablePrefix}${names.notes}`, Buffer.from("changed notes"));

  await assert.rejects(
    createYandexPublisher({ store }).validatePublic({ tree, channel, version }),
    /station release publication failed/,
  );
  assert.equal(store.calls.filter((call) => call.method === "readPublic").length, 7);
});

test("requires both current mutable objects before creating a backup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "markiro-missing-backup-parent-"));
  const backupDirectory = join(directory, "backup");
  const store = fakeStore();
  store.mutable.set("station/beta/latest.json", {
    bytes: Buffer.from("old manifest"),
    contentType: "application/json",
  });

  await assert.rejects(
    createYandexPublisher({ store }).backupMutables({ channel, backupDirectory }),
    /complete mutable backup required/,
  );
  await assert.rejects(stat(backupDirectory), { code: "ENOENT" });
});

test("writes a complete private mutable backup with retained content types", async () => {
  const directory = await mkdtemp(join(tmpdir(), "markiro-backup-parent-"));
  const backupDirectory = join(directory, "backup");
  const store = fakeStore();
  store.mutable.set("station/beta/latest.json", {
    bytes: Buffer.from("old manifest"),
    contentType: "application/json",
  });
  store.mutable.set("station/beta/download", {
    bytes: Buffer.from("old installer"),
    contentType: "application/vnd.microsoft.portable-executable",
  });

  await createYandexPublisher({ store }).backupMutables({ channel, backupDirectory });

  const backup = JSON.parse(await readFile(join(backupDirectory, "backup.json"), "utf8"));
  assert.equal(backup.schemaVersion, 1);
  assert.equal(backup.channel, channel);
  assert.deepEqual(
    backup.objects.map(({ key, contentType, sha256 }) => ({ key, contentType, sha256 })),
    [
      {
        key: "station/beta/latest.json",
        contentType: "application/json",
        sha256: digest(Buffer.from("old manifest")),
      },
      {
        key: "station/beta/download",
        contentType: "application/vnd.microsoft.portable-executable",
        sha256: digest(Buffer.from("old installer")),
      },
    ],
  );
  assert.equal(permissionBits(await stat(backupDirectory)), 0o700);
  assert.equal(permissionBits(await stat(join(backupDirectory, "backup.json"))), 0o600);
  for (const object of backup.objects) {
    assert.equal(permissionBits(await stat(join(backupDirectory, object.backupPath))), 0o600);
  }
});

test("refuses an existing backup directory without removing its contents", async () => {
  const backupDirectory = await mkdtemp(join(tmpdir(), "markiro-existing-backup-"));
  const marker = join(backupDirectory, "belongs-to-user.txt");
  await writeFile(marker, "preserve me");
  const store = fakeStore();
  store.mutable.set("station/beta/latest.json", {
    bytes: Buffer.from("old manifest"),
    contentType: "application/json",
  });
  store.mutable.set("station/beta/download", {
    bytes: Buffer.from("old installer"),
    contentType: "application/vnd.microsoft.portable-executable",
  });

  await assert.rejects(
    createYandexPublisher({ store }).backupMutables({ channel, backupDirectory }),
    /invalid station release backup/,
  );
  assert.equal(await readFile(marker, "utf8"), "preserve me");
});

test("seeds only a complete dual-origin tree after public immutable verification", async () => {
  const tree = await dualTree();
  const parent = await mkdtemp(join(tmpdir(), "markiro-seed-parent-"));
  const backupDirectory = join(parent, "backup");
  const store = fakeStore();
  await loadImmutableTree(store, join(tree, "yandex"));

  await createYandexPublisher({ store }).seedBaseline({ tree, channel, backupDirectory });

  assert.deepEqual(
    store.calls
      .filter((call) => ["putMutable", "copyImmutableToAlias"].includes(call.method))
      .map((call) => call.method),
    ["putMutable", "copyImmutableToAlias"],
  );
  assert.equal(store.mutable.has("station/beta/latest.json"), true);
  assert.equal(store.mutable.has("station/beta/download"), true);
  const backup = JSON.parse(await readFile(join(backupDirectory, "backup.json"), "utf8"));
  assert.equal(backup.objects.length, 2);

  const invalidTree = await dualTree();
  await writeFile(join(invalidTree, "github", names.installer), "other installer");
  const untouchedStore = fakeStore();
  await loadImmutableTree(untouchedStore, join(invalidTree, "yandex"));
  await assert.rejects(
    createYandexPublisher({ store: untouchedStore }).seedBaseline({
      tree: invalidTree,
      channel,
      backupDirectory: join(parent, "invalid-backup"),
    }),
    /invalid station release publication/,
  );
  assert.equal(
    untouchedStore.calls.some((call) =>
      ["putMutable", "copyImmutableToAlias"].includes(call.method),
    ),
    false,
  );
});

test("promotes manifest then alias and restores both when public verification fails", async () => {
  const tree = await yandexTree();
  const parent = await mkdtemp(join(tmpdir(), "markiro-promote-parent-"));
  const backupDirectory = join(parent, "backup");
  const store = fakeStore();
  await loadImmutableTree(store, tree);
  store.mutable.set("station/beta/latest.json", {
    bytes: Buffer.from("old manifest"),
    contentType: "application/json",
  });
  store.mutable.set("station/beta/download", {
    bytes: Buffer.from("old installer"),
    contentType: "application/vnd.microsoft.portable-executable",
  });
  const publisher = createYandexPublisher({ store });
  await publisher.backupMutables({ channel, backupDirectory });
  store.calls.length = 0;
  let failed = false;
  store.setReadHook(async (key) => {
    if (key === "station/beta/download" && !failed) {
      failed = true;
      throw new Error("injected verification failure");
    }
  });

  await assert.rejects(
    publisher.promote({ tree, channel, backupDirectory }),
    /station release promotion failed/,
  );

  const mutations = store.calls
    .filter((call) => ["putMutable", "copyImmutableToAlias"].includes(call.method))
    .map((call) => `${call.method}:${call.key ?? call.aliasKey}`);
  assert.deepEqual(mutations, [
    "putMutable:station/beta/latest.json",
    "copyImmutableToAlias:station/beta/download",
    "putMutable:station/beta/latest.json",
    "putMutable:station/beta/download",
  ]);
  assert.deepEqual(
    store.mutable.get("station/beta/latest.json").bytes,
    Buffer.from("old manifest"),
  );
  assert.deepEqual(store.mutable.get("station/beta/download").bytes, Buffer.from("old installer"));
  assert.equal(
    store.calls.some((call) => call.method === "putImmutable"),
    false,
  );
});

test("verifies backup hashes before rollback and only restores mutable keys", async () => {
  const parent = await mkdtemp(join(tmpdir(), "markiro-rollback-parent-"));
  const backupDirectory = join(parent, "backup");
  const store = fakeStore();
  store.mutable.set("station/beta/latest.json", {
    bytes: Buffer.from("old manifest"),
    contentType: "application/json",
  });
  store.mutable.set("station/beta/download", {
    bytes: Buffer.from("old installer"),
    contentType: "application/vnd.microsoft.portable-executable",
  });
  const publisher = createYandexPublisher({ store });
  await publisher.backupMutables({ channel, backupDirectory });
  const backup = JSON.parse(await readFile(join(backupDirectory, "backup.json"), "utf8"));
  await chmod(join(backupDirectory, backup.objects[0].backupPath), 0o600);
  await writeFile(join(backupDirectory, backup.objects[0].backupPath), "tampered");
  store.calls.length = 0;

  await assert.rejects(
    publisher.rollback({ channel, backupDirectory }),
    /invalid station release backup/,
  );
  assert.deepEqual(store.calls, []);

  await rm(backupDirectory, { recursive: true });
  store.calls.length = 0;
  await publisher.backupMutables({ channel, backupDirectory });
  store.calls.length = 0;
  await publisher.rollback({ channel, backupDirectory });
  assert.equal(
    store.calls.some((call) => call.method === "putImmutable"),
    false,
  );
  assert.equal(
    store.calls
      .filter((call) => call.method === "putMutable")
      .every((call) => !call.key.includes("/releases/")),
    true,
  );
});

test("rejects a hash-valid oversized mutable backup before object storage", async () => {
  const parent = await mkdtemp(join(tmpdir(), "markiro-oversized-backup-parent-"));
  const backupDirectory = join(parent, "backup");
  const store = fakeStore();
  store.mutable.set("station/beta/latest.json", {
    bytes: Buffer.from("old manifest"),
    contentType: "application/json",
  });
  store.mutable.set("station/beta/download", {
    bytes: Buffer.from("old installer"),
    contentType: "application/vnd.microsoft.portable-executable",
  });
  const publisher = createYandexPublisher({ store });
  await publisher.backupMutables({ channel, backupDirectory });
  const indexPath = join(backupDirectory, "backup.json");
  const backup = JSON.parse(await readFile(indexPath, "utf8"));
  const oversized = Buffer.alloc(256 * 1024 + 1, 1);
  await writeFile(join(backupDirectory, backup.objects[0].backupPath), oversized);
  backup.objects[0].sha256 = digest(oversized);
  await writeFile(indexPath, `${JSON.stringify(backup)}\n`);
  store.calls.length = 0;

  await assert.rejects(
    publisher.rollback({ channel, backupDirectory }),
    /invalid station release backup/,
  );
  assert.deepEqual(store.calls, []);
});

test("CLI permits only the six bounded commands and no promote-existing or credential flags", async () => {
  const calls = [];
  const publisher = Object.fromEntries(
    [
      "publishImmutable",
      "validatePublic",
      "seedBaseline",
      "backupMutables",
      "promote",
      "rollback",
    ].map((method) => [
      method,
      async (input) => {
        calls.push({ method, input });
      },
    ]),
  );
  const tree = await yandexTree();
  const backupDirectory = join(await mkdtemp(join(tmpdir(), "markiro-cli-parent-")), "backup");

  await runYandexPublisherCli(["publish-immutable", tree, channel, version], { publisher });
  assert.equal(calls[0].method, "publishImmutable");
  await assert.rejects(
    runYandexPublisherCli(["promote-existing", tree, channel, backupDirectory], { publisher }),
    /invalid station release publisher command/,
  );
  await assert.rejects(
    runYandexPublisherCli(["publish-immutable", tree, channel, version, "--access-key=secret"], {
      publisher,
    }),
    /invalid station release publisher command/,
  );
  assert.equal(calls.length, 1);
});
