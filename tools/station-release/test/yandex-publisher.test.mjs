import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { stageStationRelease, stationAssetNames } from "../artifacts.mjs";
import { stationReleaseLocation } from "../origins.mjs";
import {
  createYandexPublisher,
  createYandexPublisherClientConfig,
  createYandexProviderReader,
  runYandexPublisherCli,
  runYandexPublisherMain,
} from "../yandex-publisher.mjs";

const channel = "beta";
const version = "0.2.0-beta.7";
const names = stationAssetNames(version);
const previousVersion = "0.2.0-beta.6";
const previousNames = stationAssetNames(previousVersion);
const previousImmutableKey = `station/beta/releases/${previousVersion}/${previousNames.installer}`;
const bootstrapConfirmation = "--confirm-empty-channel-bootstrap";

function releaseMetadata(releaseChannel = channel, releaseVersion = version) {
  return {
    tagName: `station-v${releaseVersion}`,
    isDraft: false,
    isPrerelease: releaseChannel === "beta",
    targetCommitish: "b".repeat(40),
  };
}

function infrastructureEvidence({ dnsEnabled = false } = {}) {
  return {
    schemaVersion: 1,
    targetSha: "d".repeat(40),
    planSha256: "e".repeat(64),
    planVersionId: "version-123",
    enableStationReleasePublicDns: dnsEnabled,
  };
}

async function writeBootstrapInputs(
  parent,
  { release = releaseMetadata(), infrastructure = infrastructureEvidence() } = {},
) {
  const releaseMetadataPath = join(parent, "release.json");
  const infrastructureEvidencePath = join(parent, "infrastructure.json");
  await writeFile(releaseMetadataPath, `${JSON.stringify(release)}\n`);
  await writeFile(infrastructureEvidencePath, `${JSON.stringify(infrastructure)}\n`);
  return { releaseMetadataPath, infrastructureEvidencePath };
}

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

async function githubBetaTree() {
  const root = await mkdtemp(join(tmpdir(), "markiro-github-beta-"));
  const tree = join(root, "github");
  await stageTree("github", tree);
  return tree;
}

async function legacyGithubBetaTree() {
  const root = await mkdtemp(join(tmpdir(), "markiro-legacy-github-beta-"));
  const tree = join(root, "github");
  await stageTree("github", tree);
  const evidencePath = join(tree, names.evidence);
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  await writeFile(
    evidencePath,
    `${JSON.stringify({
      version: evidence.version,
      baseSha: evidence.baseSha,
      releaseSha: evidence.releaseSha,
      publishedAt: evidence.publishedAt,
      assets: evidence.assets,
    })}\n`,
  );
  return tree;
}

async function legacyGithubStableTree() {
  const stableVersion = "0.2.0";
  const stableNames = stationAssetNames(stableVersion);
  const input = await mkdtemp(join(tmpdir(), "markiro-legacy-github-stable-input-"));
  const output = join(
    await mkdtemp(join(tmpdir(), "markiro-legacy-github-stable-root-")),
    "github",
  );
  const notesPath = join(input, "notes.md");
  for (const [name, bytes] of [
    [stableNames.installer, "stable-installer-bytes"],
    [stableNames.bundle, "stable-bundle-bytes"],
    [stableNames.signature, "trusted-stable-signature"],
  ]) {
    await writeFile(join(input, name), bytes);
  }
  await writeFile(notesPath, "# Accepted stable release\n");
  await stageStationRelease({
    channel: "stable",
    origin: "github",
    inputDirectory: input,
    outputDirectory: output,
    version: stableVersion,
    pubDate: "2026-08-20T10:00:00.000Z",
    baseSha: "a".repeat(40),
    releaseSha: "b".repeat(40),
    notesPath,
    stableProvenance: {
      sourceBetaTag: "station-v0.2.0-beta.7",
      betaVersion: "0.2.0-beta.7",
      betaReleaseSha: "c".repeat(40),
      betaEvidenceSha256: "d".repeat(64),
      acceptanceConfirmed: true,
      previousStableTag: null,
      previousStableBaseSha: null,
      changelogFromSha: "e".repeat(40),
      changelogToSha: "a".repeat(40),
    },
  });
  const evidencePath = join(output, stableNames.evidence);
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  const legacyEvidence = { ...evidence };
  delete legacyEvidence.distribution;
  await writeFile(
    evidencePath,
    `${JSON.stringify({
      ...legacyEvidence,
      schemaVersion: 2,
      channelUrl:
        "https://github.com/thevladbog/markiro/releases/download/station-stable-channel/latest.json",
    })}\n`,
  );
  return { tree: output, version: stableVersion };
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
      if (preExisting.has(key) || immutable.has(key)) {
        throw new Error("station release object already exists");
      }
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
      mutable.set(key, { bytes: Buffer.from(bytes), contentType, sourceKey: null });
    },
    async copyImmutableToAlias(input) {
      calls.push({ method: "copyImmutableToAlias", ...input });
      mutable.set(input.aliasKey, {
        bytes: Buffer.from(immutable.get(input.immutableKey)),
        contentType: "application/vnd.microsoft.portable-executable",
        sourceKey: input.immutableKey,
      });
    },
    async readPublic(key, expected) {
      calls.push({ method: "readPublic", key, expected });
      if (readHook) await readHook(key, { immutable, mutable, calls });
      const object = immutable.has(key) ? { bytes: immutable.get(key) } : mutable.get(key);
      if (!object) throw new Error("missing public object");
      return Buffer.from(object.bytes);
    },
  };
}

function fakeProvider(store) {
  const calls = [];
  let readHook;
  return {
    calls,
    setReadHook(hook) {
      readHook = hook;
    },
    async readPublic(key) {
      calls.push({ method: "providerReadPublic", key });
      if (readHook) await readHook(key, { immutable: store.immutable, mutable: store.mutable });
      const object = store.immutable.has(key)
        ? { bytes: store.immutable.get(key) }
        : store.mutable.get(key);
      if (!object) throw new Error("missing provider object");
      return Buffer.from(object.bytes);
    },
  };
}

function seedInput({
  githubTree,
  parent,
  releaseChannel = channel,
  releaseVersion = version,
  releaseMetadataPath,
  infrastructureEvidencePath,
}) {
  return {
    githubTree,
    sourceTag: `station-v${releaseVersion}`,
    releaseMetadataPath,
    infrastructureEvidencePath,
    channel: releaseChannel,
    backupDirectory: join(parent, "backup"),
    recordPath: join(parent, "bootstrap-record.json"),
    confirmation: bootstrapConfirmation,
  };
}

function setPriorMutables(store) {
  store.immutable.set(previousImmutableKey, Buffer.from("old installer"));
  store.mutable.set("station/beta/latest.json", {
    bytes: Buffer.from("old manifest"),
    contentType: "application/json",
    sourceKey: null,
  });
  store.mutable.set("station/beta/download", {
    bytes: Buffer.from("old installer"),
    contentType: "application/vnd.microsoft.portable-executable",
    sourceKey: previousImmutableKey,
  });
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

test("preflights exact object-store limits before the first immutable request", async () => {
  const tree = await yandexTree();
  const evidencePath = join(tree, names.evidence);
  await writeFile(
    evidencePath,
    `${(await readFile(evidencePath, "utf8")).trim()}${" ".repeat(256 * 1024)}\n`,
  );
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

test("prepares an entirely absent seed prefix without any mutable access", async () => {
  const tree = await yandexTree();
  const store = fakeStore();
  const provider = fakeProvider(store);

  await createYandexPublisher({ store, providerReader: provider }).prepareSeedImmutable({
    tree,
    channel,
    version,
  });

  assert.equal(store.calls.filter((call) => call.method === "assertAbsent").length, 7);
  assert.equal(store.calls.filter((call) => call.method === "putImmutable").length, 7);
  assert.equal(provider.calls.filter((call) => call.method === "providerReadPublic").length, 7);
  assert.equal(
    store.calls.some((call) =>
      ["getMutable", "putMutable", "copyImmutableToAlias"].includes(call.method),
    ),
    false,
  );
});

test("accepts an exact complete seed prefix retry without immutable or mutable writes", async () => {
  const tree = await yandexTree();
  const store = fakeStore();
  await loadImmutableTree(store, tree);
  const provider = fakeProvider(store);

  await createYandexPublisher({ store, providerReader: provider }).prepareSeedImmutable({
    tree,
    channel,
    version,
  });

  assert.equal(
    store.calls.some((call) =>
      ["putImmutable", "getMutable", "putMutable", "copyImmutableToAlias"].includes(call.method),
    ),
    false,
  );
  assert.equal(provider.calls.filter((call) => call.method === "providerReadPublic").length, 7);
});

test("rejects a mixed seed prefix before any immutable or mutable write", async () => {
  const tree = await yandexTree();
  const store = fakeStore();
  await loadImmutableTree(store, tree);
  const location = stationReleaseLocation({ channel, origin: "yandex", version });
  store.immutable.delete(location.immutablePrefix + names.notes);
  const provider = fakeProvider(store);

  await assert.rejects(
    createYandexPublisher({ store, providerReader: provider }).prepareSeedImmutable({
      tree,
      channel,
      version,
    }),
    /station release publication failed/,
  );

  assert.equal(
    store.calls.some((call) =>
      ["putImmutable", "getMutable", "putMutable", "copyImmutableToAlias"].includes(call.method),
    ),
    false,
  );
  assert.deepEqual(provider.calls, []);
});

test("preflights absent seed mutables without writing either target", async () => {
  const tree = await yandexTree();
  const store = fakeStore();
  const provider = fakeProvider(store);

  await createYandexPublisher({ store, providerReader: provider }).preflightSeedMutables({
    tree,
    channel,
    version,
  });

  assert.equal(store.calls.filter((call) => call.method === "getMutable").length, 2);
  assert.equal(
    store.calls.some((call) =>
      ["putMutable", "copyImmutableToAlias", "putImmutable"].includes(call.method),
    ),
    false,
  );
  assert.deepEqual(provider.calls, []);
});

test("rejects a partial seed mutable pair without writing either target", async () => {
  const tree = await yandexTree();
  const store = fakeStore();
  store.mutable.set("station/beta/latest.json", {
    bytes: Buffer.from(await readFile(join(tree, names.manifest))),
    contentType: "application/json",
    sourceKey: null,
  });
  const provider = fakeProvider(store);

  await assert.rejects(
    createYandexPublisher({ store, providerReader: provider }).preflightSeedMutables({
      tree,
      channel,
      version,
    }),
    /incomplete station release baseline/,
  );

  assert.equal(
    store.calls.some((call) =>
      ["putMutable", "copyImmutableToAlias", "putImmutable"].includes(call.method),
    ),
    false,
  );
  assert.deepEqual(provider.calls, []);
});

test("preflights only an exact complete provider-verified seed retry pair", async () => {
  const tree = await yandexTree();
  const store = fakeStore();
  const location = stationReleaseLocation({ channel, origin: "yandex", version });
  store.mutable.set(location.mutableManifestKey, {
    bytes: Buffer.from(await readFile(join(tree, names.manifest))),
    contentType: "application/json",
    sourceKey: null,
  });
  store.mutable.set(location.mutableInstallerKey, {
    bytes: Buffer.from(await readFile(join(tree, names.installer))),
    contentType: "application/vnd.microsoft.portable-executable",
    sourceKey: location.immutablePrefix + names.installer,
  });
  const provider = fakeProvider(store);
  const publisher = createYandexPublisher({ store, providerReader: provider });

  await publisher.preflightSeedMutables({ tree, channel, version });
  assert.equal(provider.calls.filter((call) => call.method === "providerReadPublic").length, 2);
  assert.equal(
    store.calls.some((call) =>
      ["putMutable", "copyImmutableToAlias", "putImmutable"].includes(call.method),
    ),
    false,
  );

  store.mutable.get(location.mutableManifestKey).bytes = Buffer.from("wrong manifest");
  store.calls.length = 0;
  provider.calls.length = 0;
  await assert.rejects(
    publisher.preflightSeedMutables({ tree, channel, version }),
    /incomplete station release baseline/,
  );
  assert.equal(
    store.calls.some((call) =>
      ["putMutable", "copyImmutableToAlias", "putImmutable"].includes(call.method),
    ),
    false,
  );
  assert.deepEqual(provider.calls, []);
});

test("rejects a locally exact seed pair when provider bytes differ", async () => {
  const tree = await yandexTree();
  const store = fakeStore();
  const location = stationReleaseLocation({ channel, origin: "yandex", version });
  store.mutable.set(location.mutableManifestKey, {
    bytes: Buffer.from(await readFile(join(tree, names.manifest))),
    contentType: "application/json",
    sourceKey: null,
  });
  store.mutable.set(location.mutableInstallerKey, {
    bytes: Buffer.from(await readFile(join(tree, names.installer))),
    contentType: "application/vnd.microsoft.portable-executable",
    sourceKey: location.immutablePrefix + names.installer,
  });
  const provider = fakeProvider(store);
  provider.setReadHook(async (key, { mutable }) => {
    if (key === location.mutableManifestKey) {
      mutable.get(key).bytes = Buffer.from("different provider manifest");
    }
  });

  await assert.rejects(
    createYandexPublisher({ store, providerReader: provider }).preflightSeedMutables({
      tree,
      channel,
      version,
    }),
    /station release publication failed/,
  );

  assert.equal(
    store.calls.some((call) =>
      ["putMutable", "copyImmutableToAlias", "putImmutable"].includes(call.method),
    ),
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

test("provider reader uses only the fixed Yandex storage hostname and exact response metadata", async () => {
  const calls = [];
  const bytes = Buffer.from('{"version":"0.2.0-beta.7"}');
  const reader = createYandexProviderReader({
    bucket: "markiro-station-releases",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(bytes, {
        status: 200,
        headers: {
          "content-length": String(bytes.byteLength),
          "content-type": "application/json",
          "cache-control": "public, max-age=0, must-revalidate",
        },
      });
    },
  });

  assert.deepEqual(
    await reader.readPublic("station/beta/latest.json", {
      maxBytes: 256 * 1024,
      contentType: "application/json",
      cacheControl: "public, max-age=0, must-revalidate",
      contentDisposition: null,
    }),
    bytes,
  );
  assert.deepEqual(calls, [
    {
      url: "https://storage.yandexcloud.net/markiro-station-releases/station/beta/latest.json",
      init: { redirect: "error", cache: "no-store" },
    },
  ]);
});

test("requires both current mutable objects before creating a backup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "markiro-missing-backup-parent-"));
  const backupDirectory = join(directory, "backup");
  const store = fakeStore();
  store.mutable.set("station/beta/latest.json", {
    bytes: Buffer.from("old manifest"),
    contentType: "application/json",
    sourceKey: null,
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
  setPriorMutables(store);

  await createYandexPublisher({ store }).backupMutables({ channel, backupDirectory });

  const backup = JSON.parse(await readFile(join(backupDirectory, "backup.json"), "utf8"));
  assert.equal(backup.schemaVersion, 1);
  assert.equal(backup.channel, channel);
  assert.deepEqual(
    backup.objects.map(({ key, contentType, sha256, sourceKey }) => ({
      key,
      contentType,
      sha256,
      sourceKey,
    })),
    [
      {
        key: "station/beta/latest.json",
        contentType: "application/json",
        sha256: digest(Buffer.from("old manifest")),
        sourceKey: null,
      },
      {
        key: "station/beta/download",
        contentType: "application/vnd.microsoft.portable-executable",
        sha256: digest(Buffer.from("old installer")),
        sourceKey: previousImmutableKey,
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
  setPriorMutables(store);

  await assert.rejects(
    createYandexPublisher({ store }).backupMutables({ channel, backupDirectory }),
    /invalid station release backup/,
  );
  assert.equal(await readFile(marker, "utf8"), "preserve me");
});

test("seeds a strict origin-aware beta through the provider host and records its evidence", async () => {
  const githubTree = await githubBetaTree();
  const parent = await mkdtemp(join(tmpdir(), "markiro-seed-parent-"));
  const inputs = await writeBootstrapInputs(parent);
  const store = fakeStore();
  const provider = fakeProvider(store);
  const input = seedInput({ githubTree, parent, ...inputs });

  await createYandexPublisher({ store, providerReader: provider }).seedBaseline(input);

  assert.equal(store.calls.filter((call) => call.method === "putImmutable").length, 7);
  assert.deepEqual(
    store.calls
      .filter((call) => ["putMutable", "copyImmutableToAlias"].includes(call.method))
      .map((call) => call.method),
    ["putMutable", "copyImmutableToAlias"],
  );
  assert.equal(provider.calls.length, 9);
  assert.equal(store.mutable.has("station/beta/latest.json"), true);
  assert.equal(store.mutable.has("station/beta/download"), true);
  const backup = JSON.parse(await readFile(join(input.backupDirectory, "backup.json"), "utf8"));
  assert.equal(backup.objects.length, 2);

  const record = JSON.parse(await readFile(input.recordPath, "utf8"));
  assert.deepEqual(Object.keys(record).sort(), [
    "channel",
    "commonAssets",
    "infrastructure",
    "mutableBackup",
    "operation",
    "origins",
    "result",
    "schemaVersion",
    "source",
    "version",
  ]);
  assert.equal(record.operation, "station-release-empty-channel-bootstrap");
  assert.equal(record.channel, "beta");
  assert.equal(record.version, version);
  assert.equal(record.source.tagName, `station-v${version}`);
  assert.equal(record.source.baseSha, "a".repeat(40));
  assert.equal(record.source.releaseSha, "b".repeat(40));
  assert.match(record.source.releaseMetadataSha256, /^[0-9a-f]{64}$/);
  assert.equal(
    record.source.evidenceSha256,
    digest(await readFile(join(githubTree, names.evidence))),
  );
  assert.equal(record.infrastructure.enableStationReleasePublicDns, false);
  assert.match(record.infrastructure.evidenceSha256, /^[0-9a-f]{64}$/);
  assert.equal(record.origins.github.origin, "github");
  assert.equal(record.origins.yandex.origin, "yandex");
  assert.equal(
    record.origins.github.evidenceSha256,
    digest(await readFile(join(githubTree, names.evidence))),
  );
  assert.match(record.origins.yandex.evidenceSha256, /^[0-9a-f]{64}$/);
  assert.match(record.commonAssets.signatureSha256, /^[0-9a-f]{64}$/);
  assert.match(record.mutableBackup.indexSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(record.result, {
    immutables: "published-and-provider-verified",
    channelBaseline: "created-and-provider-verified",
    recovery: "not-required",
  });
  assert.doesNotMatch(
    JSON.stringify(record),
    /authorization|credential|secret|cookie|responseHeaders/i,
  );
});

test("rejects a legacy beta before any store or provider interaction", async () => {
  const githubTree = await legacyGithubBetaTree();
  const parent = await mkdtemp(join(tmpdir(), "markiro-legacy-beta-refused-"));
  const inputs = await writeBootstrapInputs(parent);
  const store = fakeStore();
  const provider = fakeProvider(store);
  const input = seedInput({ githubTree, parent, ...inputs });

  await assert.rejects(
    createYandexPublisher({ store, providerReader: provider }).seedBaseline(input),
    /invalid station release bootstrap/,
  );

  assert.deepEqual(store.calls, []);
  assert.deepEqual(provider.calls, []);
  await assert.rejects(stat(input.backupDirectory), { code: "ENOENT" });
  await assert.rejects(stat(input.recordPath), { code: "ENOENT" });
});

test("refuses DNS-enabled evidence and an incomplete mutable pair before immutable publication", async () => {
  const githubTree = await githubBetaTree();
  for (const setup of [
    async (parent, _store) =>
      writeBootstrapInputs(parent, {
        infrastructure: infrastructureEvidence({ dnsEnabled: true }),
      }),
    async (parent, store) => {
      store.mutable.set("station/beta/latest.json", {
        bytes: Buffer.from("partial manifest"),
        contentType: "application/json",
        sourceKey: null,
      });
      return writeBootstrapInputs(parent);
    },
  ]) {
    const parent = await mkdtemp(join(tmpdir(), "markiro-refused-seed-"));
    const store = fakeStore();
    const inputs = await setup(parent, store);
    await assert.rejects(
      createYandexPublisher({ store, providerReader: fakeProvider(store) }).seedBaseline(
        seedInput({ githubTree, parent, ...inputs }),
      ),
      /invalid station release bootstrap|incomplete station release baseline/,
    );
    assert.equal(
      store.calls.some((call) => call.method === "putImmutable"),
      false,
    );
  }
});

test("rejects symlinked or oversized bootstrap evidence before object storage", async () => {
  const githubTree = await githubBetaTree();
  for (const prepareInvalidEvidence of [
    async (parent) => {
      const real = join(parent, "infrastructure-real.json");
      const link = join(parent, "infrastructure.json");
      await writeFile(real, `${JSON.stringify(infrastructureEvidence())}\n`);
      await symlink(real, link);
      return link;
    },
    async (parent) => {
      const path = join(parent, "infrastructure.json");
      await writeFile(path, "x".repeat(256 * 1024 + 1));
      return path;
    },
  ]) {
    const parent = await mkdtemp(join(tmpdir(), "markiro-invalid-seed-input-"));
    const releaseMetadataPath = join(parent, "release.json");
    await writeFile(releaseMetadataPath, `${JSON.stringify(releaseMetadata())}\n`);
    const infrastructureEvidencePath = await prepareInvalidEvidence(parent);
    const store = fakeStore();
    await assert.rejects(
      createYandexPublisher({ store, providerReader: fakeProvider(store) }).seedBaseline(
        seedInput({
          githubTree,
          parent,
          releaseMetadataPath,
          infrastructureEvidencePath,
        }),
      ),
      /invalid station release bootstrap/,
    );
    assert.deepEqual(store.calls, []);
  }
});

test("accepts the complete matching pair on a retry without overwriting immutable keys", async () => {
  const githubTree = await githubBetaTree();
  const store = fakeStore();
  const provider = fakeProvider(store);
  const publisher = createYandexPublisher({ store, providerReader: provider });
  const firstParent = await mkdtemp(join(tmpdir(), "markiro-seed-first-"));
  const firstInputs = await writeBootstrapInputs(firstParent);
  await publisher.seedBaseline(seedInput({ githubTree, parent: firstParent, ...firstInputs }));
  store.calls.length = 0;
  provider.calls.length = 0;

  const retryParent = await mkdtemp(join(tmpdir(), "markiro-seed-retry-"));
  const retryInputs = await writeBootstrapInputs(retryParent);
  const retry = seedInput({ githubTree, parent: retryParent, ...retryInputs });
  await publisher.seedBaseline(retry);

  assert.equal(
    store.calls.some((call) => call.method === "putImmutable"),
    false,
  );
  assert.equal(
    store.calls.some((call) => ["putMutable", "copyImmutableToAlias"].includes(call.method)),
    false,
  );
  const record = JSON.parse(await readFile(retry.recordPath, "utf8"));
  assert.deepEqual(record.result, {
    immutables: "existing-and-provider-verified",
    channelBaseline: "already-complete-and-provider-verified",
    recovery: "not-required",
  });
});

test("seed reuses a separately prepared exact immutable prefix without rewriting it", async () => {
  const githubTree = await githubBetaTree();
  const preparedTree = await yandexTree();
  const store = fakeStore();
  const provider = fakeProvider(store);
  const publisher = createYandexPublisher({ store, providerReader: provider });
  await publisher.prepareSeedImmutable({
    tree: preparedTree,
    channel,
    version,
  });
  store.calls.length = 0;
  provider.calls.length = 0;
  const parent = await mkdtemp(join(tmpdir(), "markiro-seed-prepared-"));
  const inputs = await writeBootstrapInputs(parent);
  const input = seedInput({ githubTree, parent, ...inputs });

  await publisher.seedBaseline(input);

  assert.equal(
    store.calls.some((call) => call.method === "putImmutable"),
    false,
  );
  assert.equal(store.calls.filter((call) => call.method === "assertAbsent").length, 7);
  assert.equal(
    store.calls.some((call) => ["putMutable", "copyImmutableToAlias"].includes(call.method)),
    true,
  );
  const record = JSON.parse(await readFile(input.recordPath, "utf8"));
  assert.equal(record.result.immutables, "existing-and-provider-verified");
});

test("accepts the explicitly confirmed legacy stable solely for baseline seeding", async () => {
  const stable = await legacyGithubStableTree();
  const parent = await mkdtemp(join(tmpdir(), "markiro-stable-seed-"));
  const inputs = await writeBootstrapInputs(parent, {
    release: releaseMetadata("stable", stable.version),
  });
  const store = fakeStore();
  const input = seedInput({
    githubTree: stable.tree,
    parent,
    releaseChannel: "stable",
    releaseVersion: stable.version,
    ...inputs,
  });

  await createYandexPublisher({ store, providerReader: fakeProvider(store) }).seedBaseline(input);

  assert.equal(store.mutable.has("station/stable/latest.json"), true);
  assert.equal(store.mutable.has("station/download"), true);
  const record = JSON.parse(await readFile(input.recordPath, "utf8"));
  assert.equal(record.channel, "stable");
  assert.equal(record.version, stable.version);
});

test("compensates a seed failure after manifest mutation with the complete baseline", async () => {
  const githubTree = await githubBetaTree();
  const parent = await mkdtemp(join(tmpdir(), "markiro-seed-manifest-failure-"));
  const inputs = await writeBootstrapInputs(parent);
  const input = seedInput({ githubTree, parent, ...inputs });
  const store = fakeStore();
  const provider = fakeProvider(store);
  let manifestReads = 0;
  provider.setReadHook(async (key) => {
    if (key === "station/beta/latest.json" && manifestReads++ === 0) {
      throw new Error("injected first manifest verification failure");
    }
  });

  await assert.rejects(
    createYandexPublisher({ store, providerReader: provider }).seedBaseline(input),
    /station release publication failed/,
  );

  assert.deepEqual(
    store.calls
      .filter((call) => ["putMutable", "copyImmutableToAlias"].includes(call.method))
      .map((call) => `${call.method}:${call.key ?? call.aliasKey}`),
    [
      "putMutable:station/beta/latest.json",
      "putMutable:station/beta/latest.json",
      "copyImmutableToAlias:station/beta/download",
    ],
  );
  assert.equal(JSON.parse(store.mutable.get("station/beta/latest.json").bytes).version, version);
  assert.deepEqual(
    store.mutable.get("station/beta/download").bytes,
    Buffer.from("installer-bytes"),
  );
  const record = JSON.parse(await readFile(input.recordPath, "utf8"));
  assert.deepEqual(record.result, {
    immutables: "published-and-provider-verified",
    channelBaseline: "created-after-compensation-and-provider-verified",
    recovery: "complete-baseline-reapplied-and-provider-verified",
  });
});

test("compensates a seed failure after alias mutation with the complete baseline", async () => {
  const githubTree = await githubBetaTree();
  const parent = await mkdtemp(join(tmpdir(), "markiro-seed-alias-failure-"));
  const inputs = await writeBootstrapInputs(parent);
  const input = seedInput({ githubTree, parent, ...inputs });
  const store = fakeStore();
  const provider = fakeProvider(store);
  let aliasReads = 0;
  provider.setReadHook(async (key) => {
    if (key === "station/beta/download" && aliasReads++ === 0) {
      throw new Error("injected first alias verification failure");
    }
  });

  await assert.rejects(
    createYandexPublisher({ store, providerReader: provider }).seedBaseline(input),
    /station release publication failed/,
  );

  assert.deepEqual(
    store.calls
      .filter((call) => ["putMutable", "copyImmutableToAlias"].includes(call.method))
      .map((call) => `${call.method}:${call.key ?? call.aliasKey}`),
    [
      "putMutable:station/beta/latest.json",
      "copyImmutableToAlias:station/beta/download",
      "putMutable:station/beta/latest.json",
      "copyImmutableToAlias:station/beta/download",
    ],
  );
  assert.equal(JSON.parse(store.mutable.get("station/beta/latest.json").bytes).version, version);
  assert.deepEqual(
    store.mutable.get("station/beta/download").bytes,
    Buffer.from("installer-bytes"),
  );
  const record = JSON.parse(await readFile(input.recordPath, "utf8"));
  assert.equal(record.result.recovery, "complete-baseline-reapplied-and-provider-verified");
});

test("reports a distinct hard failure when seed compensation cannot restore the baseline", async () => {
  const githubTree = await githubBetaTree();
  const parent = await mkdtemp(join(tmpdir(), "markiro-seed-recovery-failure-"));
  const inputs = await writeBootstrapInputs(parent);
  const input = seedInput({ githubTree, parent, ...inputs });
  const store = fakeStore();
  const provider = fakeProvider(store);
  let manifestReads = 0;
  provider.setReadHook(async (key) => {
    if (key === "station/beta/latest.json" && manifestReads++ === 0) {
      throw new Error("injected first manifest verification failure");
    }
  });
  const putMutable = store.putMutable.bind(store);
  let manifestPuts = 0;
  store.putMutable = async (...args) => {
    if (manifestPuts++ === 1) throw new Error("injected compensation write failure");
    return putMutable(...args);
  };

  await assert.rejects(
    createYandexPublisher({ store, providerReader: provider }).seedBaseline(input),
    /station release baseline recovery failed/,
  );
  const record = JSON.parse(await readFile(input.recordPath, "utf8"));
  assert.deepEqual(record.result, {
    immutables: "published-and-provider-verified",
    channelBaseline: "unknown-after-failed-compensation",
    recovery: "failed",
  });
});

test("promotes manifest then alias and restores alias then manifest on verification failure", async () => {
  const tree = await yandexTree();
  const parent = await mkdtemp(join(tmpdir(), "markiro-promote-parent-"));
  const backupDirectory = join(parent, "backup");
  const store = fakeStore();
  await loadImmutableTree(store, tree);
  setPriorMutables(store);
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
    "copyImmutableToAlias:station/beta/download",
    "putMutable:station/beta/latest.json",
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
  setPriorMutables(store);
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
  assert.deepEqual(
    store.calls
      .filter((call) => ["putMutable", "copyImmutableToAlias", "readPublic"].includes(call.method))
      .map((call) => `${call.method}:${call.key ?? call.aliasKey}`),
    [
      "copyImmutableToAlias:station/beta/download",
      "readPublic:station/beta/download",
      "putMutable:station/beta/latest.json",
      "readPublic:station/beta/latest.json",
    ],
  );
  assert.deepEqual(
    store.calls
      .filter((call) => call.method === "readPublic")
      .map(({ key, expected }) => ({ key, expected })),
    [
      {
        key: "station/beta/download",
        expected: {
          contentType: "application/vnd.microsoft.portable-executable",
          cacheControl: "public, max-age=0, must-revalidate",
          contentDisposition: `attachment; filename="${previousNames.installer}"`,
          maxBytes: 512 * 1024 * 1024,
        },
      },
      {
        key: "station/beta/latest.json",
        expected: {
          contentType: "application/json",
          cacheControl: "public, max-age=0, must-revalidate",
          contentDisposition: null,
          maxBytes: 256 * 1024,
        },
      },
    ],
  );
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
  assert.deepEqual(
    store.calls
      .filter((call) => call.method === "copyImmutableToAlias")
      .map(({ immutableKey, aliasKey, attachmentFilename }) => ({
        immutableKey,
        aliasKey,
        attachmentFilename,
      })),
    [
      {
        immutableKey: previousImmutableKey,
        aliasKey: "station/beta/download",
        attachmentFilename: previousNames.installer,
      },
    ],
  );
  assert.equal(
    store.calls.some(
      (call) => call.method === "putMutable" && call.key === "station/beta/download",
    ),
    false,
  );
});

test("rejects a hash-valid oversized mutable backup before object storage", async () => {
  const parent = await mkdtemp(join(tmpdir(), "markiro-oversized-backup-parent-"));
  const backupDirectory = join(parent, "backup");
  const store = fakeStore();
  setPriorMutables(store);
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

test("rejects an alias backup whose source is not the same-channel immutable installer", async () => {
  const invalidSources = [
    `station/beta/releases/${previousVersion}/${previousNames.signature}`,
    "station/stable/releases/0.2.0/markiro-station-0.2.0-windows-x86_64-setup.exe",
  ];
  for (const sourceKey of invalidSources) {
    const backupDirectory = join(
      await mkdtemp(join(tmpdir(), "markiro-invalid-source-backup-")),
      "backup",
    );
    const store = fakeStore();
    setPriorMutables(store);
    const publisher = createYandexPublisher({ store });
    await publisher.backupMutables({ channel, backupDirectory });
    const indexPath = join(backupDirectory, "backup.json");
    const backup = JSON.parse(await readFile(indexPath, "utf8"));
    backup.objects[1].sourceKey = sourceKey;
    await writeFile(indexPath, `${JSON.stringify(backup)}\n`);
    store.calls.length = 0;

    await assert.rejects(
      publisher.rollback({ channel, backupDirectory }),
      /invalid station release backup/,
    );
    assert.deepEqual(store.calls, []);
  }
});

test("CLI permits only the eight bounded commands and no promote-existing or credential flags", async () => {
  const calls = [];
  const publisher = Object.fromEntries(
    [
      "publishImmutable",
      "validatePublic",
      "prepareSeedImmutable",
      "preflightSeedMutables",
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
  const githubTree = await githubBetaTree();
  const parent = await mkdtemp(join(tmpdir(), "markiro-cli-parent-"));
  const backupDirectory = join(parent, "backup");
  const recordPath = join(parent, "bootstrap-record.json");
  const inputs = await writeBootstrapInputs(parent);

  await runYandexPublisherCli(["publish-immutable", tree, channel, version], { publisher });
  assert.equal(calls[0].method, "publishImmutable");
  await runYandexPublisherCli(["prepare-seed-immutable", tree, channel, version], { publisher });
  assert.equal(calls.at(-1).method, "prepareSeedImmutable");
  await runYandexPublisherCli(["preflight-seed-mutables", tree, channel, version], { publisher });
  assert.equal(calls.at(-1).method, "preflightSeedMutables");
  await assert.rejects(
    runYandexPublisherCli(
      ["prepare-seed-immutable", "https://evil.invalid/tree", channel, version],
      { publisher },
    ),
    /invalid station release publisher command/,
  );
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
  const seedArgs = [
    "seed-baseline",
    githubTree,
    `station-v${version}`,
    inputs.releaseMetadataPath,
    inputs.infrastructureEvidencePath,
    channel,
    backupDirectory,
    recordPath,
  ];
  await assert.rejects(
    runYandexPublisherCli(seedArgs, { publisher }),
    /invalid station release publisher command/,
  );
  await assert.rejects(
    runYandexPublisherCli([...seedArgs, "true"], { publisher }),
    /invalid station release publisher command/,
  );
  await runYandexPublisherCli([...seedArgs, bootstrapConfirmation], { publisher });
  assert.deepEqual(calls.at(-1), {
    method: "seedBaseline",
    input: {
      githubTree,
      sourceTag: `station-v${version}`,
      releaseMetadataPath: inputs.releaseMetadataPath,
      infrastructureEvidencePath: inputs.infrastructureEvidencePath,
      channel,
      backupDirectory,
      recordPath,
      confirmation: bootstrapConfirmation,
    },
  });
  assert.equal(calls.length, 4);
});

test("constructs an explicit bounded environment-only AWS credential object", () => {
  assert.deepEqual(
    createYandexPublisherClientConfig({
      YANDEX_STATION_RELEASE_ENDPOINT: "https://storage.yandexcloud.net",
      YANDEX_STATION_RELEASE_BUCKET: "markiro-station-releases",
      AWS_ACCESS_KEY_ID: "A".repeat(20),
      AWS_SECRET_ACCESS_KEY: "s".repeat(40),
      AWS_SESSION_TOKEN: "temporary-session-token",
    }),
    {
      bucket: "markiro-station-releases",
      client: {
        endpoint: "https://storage.yandexcloud.net",
        region: "ru-central1",
        maxAttempts: 3,
        credentials: {
          accessKeyId: "A".repeat(20),
          secretAccessKey: "s".repeat(40),
          sessionToken: "temporary-session-token",
        },
      },
    },
  );
});

test("rejects missing or malformed environment credentials before client construction", async () => {
  const base = {
    YANDEX_STATION_RELEASE_ENDPOINT: "https://storage.yandexcloud.net",
    YANDEX_STATION_RELEASE_BUCKET: "markiro-station-releases",
    AWS_ACCESS_KEY_ID: "A".repeat(20),
    AWS_SECRET_ACCESS_KEY: "s".repeat(40),
  };
  const environments = [
    { ...base, AWS_ACCESS_KEY_ID: undefined },
    { ...base, AWS_SECRET_ACCESS_KEY: undefined },
    { ...base, AWS_ACCESS_KEY_ID: "short" },
    { ...base, AWS_SECRET_ACCESS_KEY: "secret-value\nleak-sentinel" },
    { ...base, AWS_SESSION_TOKEN: "x".repeat(4097) },
  ];

  for (const env of environments) {
    let constructed = 0;
    class InjectedClient {
      constructor() {
        constructed += 1;
      }
    }
    await assert.rejects(
      runYandexPublisherMain(["rollback", channel, "/tmp/backup"], {
        env,
        Client: InjectedClient,
      }),
      (error) =>
        error.message === "invalid station release publisher environment" &&
        !error.message.includes("leak-sentinel"),
    );
    assert.equal(constructed, 0);
  }
});
