import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { stageStationRelease, stationAssetNames } from "../artifacts.mjs";
import { stationReleaseLocation } from "../origins.mjs";
import { createYandexPublisher, runYandexPublisherCli } from "../yandex-publisher.mjs";

// Re-seeding the empty releases.markiro.app bucket from the accepted GitHub
// mirror release: the GitHub tree is the only input, the releases.markiro.app
// tree is rebuilt from it and every object is read back through the edge.

const confirmation = "--confirm-reseed-from-github";
const INSTALLER = "application/vnd.microsoft.portable-executable";
const MUTABLE_CACHE = "public, max-age=0, must-revalidate";
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

const releases = {
  beta: { version: "2.4.0-beta.5" },
  stable: { version: "2.3.0" },
};

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function stageGithubTree(channel) {
  const { version } = releases[channel];
  const names = stationAssetNames(version);
  const input = await mkdtemp(join(tmpdir(), `markiro-reseed-${channel}-input-`));
  const root = await mkdtemp(join(tmpdir(), `markiro-reseed-${channel}-`));
  for (const [name, bytes] of [
    [names.installer, `${channel}-installer-bytes`],
    [names.bundle, `${channel}-bundle-bytes`],
    [names.signature, `trusted-${channel}-signature`],
  ]) {
    await writeFile(join(input, name), bytes);
  }
  const stable =
    channel === "stable"
      ? {
          notesPath: join(input, "notes.md"),
          stableProvenance: {
            sourceBetaTag: "station-v2.3.0-beta.3",
            betaVersion: "2.3.0-beta.3",
            betaReleaseSha: "c".repeat(40),
            betaEvidenceSha256: "d".repeat(64),
            acceptanceConfirmed: true,
            previousStableTag: "station-v2.2.0",
            previousStableBaseSha: "e".repeat(40),
            changelogFromSha: "e".repeat(40),
            changelogToSha: "a".repeat(40),
          },
        }
      : {};
  if (stable.notesPath) await writeFile(stable.notesPath, "# Markiro Station 2.3.0\n");
  const tree = join(root, "github");
  await stageStationRelease({
    channel,
    origin: "github",
    inputDirectory: input,
    outputDirectory: tree,
    version,
    pubDate: "2026-10-11T20:04:19.000Z",
    baseSha: "a".repeat(40),
    releaseSha: "b".repeat(40),
    ...stable,
  });
  return { root, tree, version, names };
}

async function reseedFixture(channel = "beta", { release = {} } = {}) {
  const fixture = await stageGithubTree(channel);
  const releaseMetadataPath = join(fixture.root, "release.json");
  await writeFile(
    releaseMetadataPath,
    `${JSON.stringify({
      tagName: `station-v${fixture.version}`,
      isDraft: false,
      isPrerelease: channel === "beta",
      targetCommitish: "f".repeat(40),
      ...release,
    })}\n`,
  );
  const githubChannelManifestPath = join(fixture.root, "channel-latest.json");
  await writeFile(
    githubChannelManifestPath,
    await readFile(join(fixture.tree, fixture.names.manifest)),
  );
  return {
    ...fixture,
    channel,
    location: stationReleaseLocation({ channel, origin: "yandex", version: fixture.version }),
    input: {
      githubTree: fixture.tree,
      sourceTag: `station-v${fixture.version}`,
      releaseMetadataPath,
      githubChannelManifestPath,
      channel,
      recordPath: join(fixture.root, "reseed-record.json"),
      confirmation,
    },
  };
}

// The bucket behind releases.markiro.app: conditional immutable writes, plain
// mutable writes, server-side alias copies, and public reads that report the
// metadata each object was written with.
function fakeStore() {
  const calls = [];
  const objects = new Map();
  let readHook;
  return {
    calls,
    objects,
    setReadHook(hook) {
      readHook = hook;
    },
    async assertAbsent(key) {
      calls.push({ method: "assertAbsent", key });
      if (objects.has(key)) throw new Error("station release object already exists");
    },
    async putImmutable(key, file, contentType) {
      calls.push({ method: "putImmutable", key, contentType });
      if (objects.has(key)) throw new Error("station object storage operation failed");
      objects.set(key, {
        bytes: Buffer.from(await readFile(file)),
        contentType,
        cacheControl: IMMUTABLE_CACHE,
        contentDisposition: null,
        sourceKey: null,
      });
    },
    async getMutable(key) {
      calls.push({ method: "getMutable", key });
      const object = objects.get(key);
      return object
        ? {
            bytes: Buffer.from(object.bytes),
            contentType: object.contentType,
            sourceKey: object.sourceKey,
          }
        : null;
    },
    async putMutable(key, bytes, contentType) {
      calls.push({ method: "putMutable", key, contentType });
      objects.set(key, {
        bytes: Buffer.from(bytes),
        contentType,
        cacheControl: MUTABLE_CACHE,
        contentDisposition: null,
        sourceKey: null,
      });
    },
    async copyImmutableToAlias(input) {
      calls.push({ method: "copyImmutableToAlias", ...input });
      const source = objects.get(input.immutableKey);
      if (!source) throw new Error("station object storage operation failed");
      objects.set(input.aliasKey, {
        bytes: Buffer.from(source.bytes),
        contentType: INSTALLER,
        cacheControl: MUTABLE_CACHE,
        contentDisposition: `attachment; filename="${input.attachmentFilename}"`,
        sourceKey: input.immutableKey,
      });
    },
    async readPublic(key, expected) {
      calls.push({ method: "readPublic", key, expected });
      if (readHook) await readHook(key, objects);
      const object = objects.get(key);
      if (
        !object ||
        object.contentType !== expected.contentType ||
        object.cacheControl !== expected.cacheControl ||
        object.contentDisposition !== expected.contentDisposition
      ) {
        throw new Error("station public object read failed");
      }
      return Buffer.from(object.bytes);
    },
  };
}

const writeMethods = ["putImmutable", "putMutable", "copyImmutableToAlias"];

function writes(store) {
  return store.calls.filter((call) => writeMethods.includes(call.method));
}

// The bucket a clean reseed of the same release leaves behind.
async function expectedTree(fixture) {
  const store = fakeStore();
  await createYandexPublisher({ store }).reseedFromGithub(fixture.input);
  return store.objects;
}

for (const channel of ["beta", "stable"]) {
  test(`reseeds an empty ${channel} channel from the accepted GitHub release`, async () => {
    const fixture = await reseedFixture(channel);
    const store = fakeStore();

    await createYandexPublisher({ store }).reseedFromGithub(fixture.input);

    const { location, names, version } = fixture;
    const immutableKeys = Object.values(names).map((name) => `${location.immutablePrefix}${name}`);
    assert.deepEqual(
      [...store.objects.keys()].sort(),
      [...immutableKeys, location.mutableManifestKey, location.mutableInstallerKey].sort(),
    );
    // Every immutable is a conditional write with its exact content type.
    assert.deepEqual(
      store.calls.filter((call) => call.method === "putImmutable").map((call) => call.key),
      immutableKeys,
    );
    for (const key of immutableKeys) {
      assert.equal(store.objects.get(key).cacheControl, IMMUTABLE_CACHE, key);
    }
    assert.equal(
      store.objects.get(`${location.immutablePrefix}${names.installer}`).contentType,
      INSTALLER,
    );
    assert.equal(
      store.objects.get(`${location.immutablePrefix}${names.bundle}`).contentType,
      "application/zip",
    );
    assert.equal(
      store.objects.get(`${location.immutablePrefix}${names.notes}`).contentType,
      "text/markdown",
    );

    // Manifest first, alias last, each verified through the public edge.
    const mutableWrites = writes(store).filter((call) => call.method !== "putImmutable");
    assert.deepEqual(
      mutableWrites.map((call) => [call.method, call.key ?? call.aliasKey]),
      [
        ["putMutable", location.mutableManifestKey],
        ["copyImmutableToAlias", location.mutableInstallerKey],
      ],
    );
    const lastImmutableWrite = store.calls.findLastIndex((call) => call.method === "putImmutable");
    const manifestWrite = store.calls.findIndex((call) => call.method === "putMutable");
    assert.ok(lastImmutableWrite < manifestWrite);
    const publicTreeReads = store.calls
      .slice(lastImmutableWrite, manifestWrite)
      .filter((call) => call.method === "readPublic")
      .map((call) => call.key);
    assert.deepEqual(publicTreeReads.sort(), [...immutableKeys].sort());
    const afterManifest = store.calls.slice(manifestWrite + 1);
    assert.equal(afterManifest[0].method, "readPublic");
    assert.equal(afterManifest[0].key, location.mutableManifestKey);
    assert.equal(store.calls.at(-1).method, "readPublic");
    assert.equal(store.calls.at(-1).key, location.mutableInstallerKey);
    assert.equal(
      store.calls.at(-1).expected.contentDisposition,
      `attachment; filename="${names.installer}"`,
    );

    // The rebuilt tree is the releases.markiro.app origin of the same release.
    const manifest = JSON.parse(store.objects.get(location.mutableManifestKey).bytes.toString());
    assert.equal(manifest.version, version);
    assert.equal(
      manifest.platforms["windows-x86_64"].url,
      `https://releases.markiro.app/station/${channel}/releases/${version}/${names.bundle}`,
    );
    const githubManifest = JSON.parse(await readFile(join(fixture.tree, names.manifest), "utf8"));
    assert.equal(manifest.pub_date, githubManifest.pub_date);
    assert.equal(
      manifest.platforms["windows-x86_64"].signature,
      githubManifest.platforms["windows-x86_64"].signature,
    );
    const evidence = JSON.parse(
      store.objects.get(`${location.immutablePrefix}${names.evidence}`).bytes.toString(),
    );
    assert.deepEqual(evidence.distribution, {
      origin: "yandex",
      channelUrl: `https://releases.markiro.app/station/${channel}/latest.json`,
      releaseBaseUrl: `https://releases.markiro.app/station/${channel}/releases/${version}`,
    });
    for (const name of [names.installer, names.bundle, names.signature, names.notes]) {
      assert.deepEqual(
        store.objects.get(`${location.immutablePrefix}${name}`).bytes,
        await readFile(join(fixture.tree, name)),
        name,
      );
    }
    assert.deepEqual(
      store.objects.get(location.mutableInstallerKey).bytes,
      await readFile(join(fixture.tree, names.installer)),
    );
    assert.equal(
      store.calls.some((call) => /delete/i.test(call.method)),
      false,
    );

    const record = JSON.parse(await readFile(fixture.input.recordPath, "utf8"));
    const githubEvidence = await readFile(join(fixture.tree, names.evidence));
    assert.deepEqual(record, {
      schemaVersion: 1,
      operation: "station-release-reseed-from-github",
      channel,
      version,
      publicBaseUrl: "https://releases.markiro.app",
      source: {
        tagName: `station-v${version}`,
        baseSha: "a".repeat(40),
        releaseSha: "b".repeat(40),
        distributionSha: "f".repeat(40),
        releaseMetadataSha256: digest(await readFile(fixture.input.releaseMetadataPath)),
        githubChannelManifestSha256: digest(
          await readFile(fixture.input.githubChannelManifestPath),
        ),
        evidenceSha256: digest(githubEvidence),
      },
      origins: {
        github: {
          origin: "github",
          evidenceSha256: digest(githubEvidence),
          manifestSha256: digest(await readFile(join(fixture.tree, names.manifest))),
          checksumsSha256: digest(await readFile(join(fixture.tree, names.checksums))),
        },
        yandex: {
          origin: "yandex",
          evidenceSha256: digest(
            store.objects.get(`${location.immutablePrefix}${names.evidence}`).bytes,
          ),
          manifestSha256: digest(store.objects.get(location.mutableManifestKey).bytes),
          checksumsSha256: digest(
            store.objects.get(`${location.immutablePrefix}${names.checksums}`).bytes,
          ),
        },
      },
      commonAssets: {
        installerSha256: digest(await readFile(join(fixture.tree, names.installer))),
        bundleSha256: digest(await readFile(join(fixture.tree, names.bundle))),
        signatureSha256: digest(await readFile(join(fixture.tree, names.signature))),
        notesSha256: digest(await readFile(join(fixture.tree, names.notes))),
      },
      result: {
        immutables: "published-and-public-verified",
        channel: "created-and-public-verified",
      },
    });
  });
}

test("a repeated reseed of a complete channel only reads it back", async () => {
  const fixture = await reseedFixture("stable");
  const store = fakeStore();
  await createYandexPublisher({ store }).reseedFromGithub(fixture.input);
  const before = new Map(store.objects);
  store.calls.length = 0;

  const repeat = { ...fixture.input, recordPath: join(fixture.root, "repeat-record.json") };
  await createYandexPublisher({ store }).reseedFromGithub(repeat);

  assert.deepEqual(writes(store), []);
  assert.deepEqual(store.objects, before);
  assert.deepEqual(
    [
      ...new Set(
        store.calls.filter((call) => call.method === "readPublic").map((call) => call.key),
      ),
    ].sort(),
    [...before.keys()].sort(),
  );
  const record = JSON.parse(await readFile(repeat.recordPath, "utf8"));
  assert.deepEqual(record.result, {
    immutables: "existing-and-public-verified",
    channel: "existing-and-public-verified",
  });
});

test("completes a reseed interrupted after part of the immutables", async () => {
  const fixture = await reseedFixture("beta");
  const complete = await expectedTree({
    ...fixture,
    input: { ...fixture.input, recordPath: join(fixture.root, "reference-record.json") },
  });
  const store = fakeStore();
  const { location, names } = fixture;
  for (const name of [names.installer, names.bundle]) {
    const key = `${location.immutablePrefix}${name}`;
    store.objects.set(key, complete.get(key));
  }

  await createYandexPublisher({ store }).reseedFromGithub(fixture.input);

  const puts = store.calls.filter((call) => call.method === "putImmutable").map((call) => call.key);
  assert.equal(puts.length, 5);
  assert.equal(puts.includes(`${location.immutablePrefix}${names.installer}`), false);
  assert.equal(puts.includes(`${location.immutablePrefix}${names.bundle}`), false);
  assert.deepEqual(store.objects, complete);
  const record = JSON.parse(await readFile(fixture.input.recordPath, "utf8"));
  assert.deepEqual(record.result, {
    immutables: "completed-and-public-verified",
    channel: "created-and-public-verified",
  });
});

test("completes a reseed interrupted between the manifest and the alias", async () => {
  const fixture = await reseedFixture("beta");
  const complete = await expectedTree({
    ...fixture,
    input: { ...fixture.input, recordPath: join(fixture.root, "reference-record.json") },
  });
  const store = fakeStore();
  for (const [key, object] of complete) {
    if (key !== fixture.location.mutableInstallerKey) store.objects.set(key, object);
  }

  await createYandexPublisher({ store }).reseedFromGithub(fixture.input);

  assert.deepEqual(
    writes(store).map((call) => [call.method, call.key ?? call.aliasKey]),
    [
      ["putMutable", fixture.location.mutableManifestKey],
      ["copyImmutableToAlias", fixture.location.mutableInstallerKey],
    ],
  );
  assert.deepEqual(store.objects, complete);
  const record = JSON.parse(await readFile(fixture.input.recordPath, "utf8"));
  assert.deepEqual(record.result, {
    immutables: "existing-and-public-verified",
    channel: "completed-and-public-verified",
  });
});

test("never overwrites a channel that already points at another release", async () => {
  const fixture = await reseedFixture("beta");
  const store = fakeStore();
  const { location } = fixture;
  store.objects.set(location.mutableManifestKey, {
    bytes: Buffer.from('{"version":"2.4.0-beta.6"}'),
    contentType: "application/json",
    cacheControl: MUTABLE_CACHE,
    contentDisposition: null,
    sourceKey: null,
  });

  await assert.rejects(
    createYandexPublisher({ store }).reseedFromGithub(fixture.input),
    /station release reseed conflicts with the published channel/,
  );
  assert.deepEqual(writes(store), []);
  await assert.rejects(readFile(fixture.input.recordPath), /ENOENT/);
});

test("rejects an installer alias without its manifest before any write", async () => {
  const fixture = await reseedFixture("stable");
  const complete = await expectedTree({
    ...fixture,
    input: { ...fixture.input, recordPath: join(fixture.root, "reference-record.json") },
  });
  const store = fakeStore();
  store.objects.set(
    fixture.location.mutableInstallerKey,
    complete.get(fixture.location.mutableInstallerKey),
  );

  await assert.rejects(
    createYandexPublisher({ store }).reseedFromGithub(fixture.input),
    /station release reseed conflicts with the published channel/,
  );
  assert.deepEqual(writes(store), []);
});

test("rejects an existing immutable object with different bytes before any write", async () => {
  const fixture = await reseedFixture("beta");
  const store = fakeStore();
  const key = `${fixture.location.immutablePrefix}${fixture.names.notes}`;
  store.objects.set(key, {
    bytes: Buffer.from("other notes"),
    contentType: "text/markdown",
    cacheControl: IMMUTABLE_CACHE,
    contentDisposition: null,
    sourceKey: null,
  });

  await assert.rejects(
    createYandexPublisher({ store }).reseedFromGithub(fixture.input),
    /station release reseed conflicts with the published channel/,
  );
  assert.deepEqual(writes(store), []);
});

test("fails before the mutable pair when the edge does not return the uploaded tree", async () => {
  const fixture = await reseedFixture("beta");
  const store = fakeStore();
  const key = `${fixture.location.immutablePrefix}${fixture.names.signature}`;
  store.setReadHook(async (readKey, objects) => {
    if (readKey === key) objects.get(key).cacheControl = "no-store";
  });

  await assert.rejects(
    createYandexPublisher({ store }).reseedFromGithub(fixture.input),
    /station release publication failed/,
  );
  assert.equal(
    store.calls.some((call) => ["putMutable", "copyImmutableToAlias"].includes(call.method)),
    false,
  );
  await assert.rejects(readFile(fixture.input.recordPath), /ENOENT/);
});

test("fails when the public manifest differs and leaves a resumable state", async () => {
  const fixture = await reseedFixture("beta");
  const store = fakeStore();
  let failOnce = true;
  store.setReadHook(async (readKey, objects) => {
    if (readKey === fixture.location.mutableManifestKey && failOnce) {
      failOnce = false;
      objects.get(readKey).cacheControl = "public, max-age=60";
    }
  });

  await assert.rejects(
    createYandexPublisher({ store }).reseedFromGithub(fixture.input),
    /station release publication failed/,
  );
  assert.equal(
    store.calls.some((call) => call.method === "copyImmutableToAlias"),
    false,
  );

  // The edge recovered; the same dispatch finishes the channel.
  store.objects.get(fixture.location.mutableManifestKey).cacheControl = MUTABLE_CACHE;
  store.calls.length = 0;
  await createYandexPublisher({ store }).reseedFromGithub(fixture.input);
  assert.deepEqual(
    writes(store).map((call) => call.method),
    ["putMutable", "copyImmutableToAlias"],
  );
});

test("accepts only the release the GitHub channel currently points at", async () => {
  const fixture = await reseedFixture("beta");
  await writeFile(
    fixture.input.githubChannelManifestPath,
    `${(await readFile(fixture.input.githubChannelManifestPath, "utf8")).trim()} \n`,
  );
  const store = fakeStore();

  await assert.rejects(
    createYandexPublisher({ store }).reseedFromGithub(fixture.input),
    /invalid station release reseed/,
  );
  assert.deepEqual(store.calls, []);
});

for (const [label, release] of [
  ["a draft", { isDraft: true }],
  ["another tag", { tagName: "station-v2.4.0-beta.4" }],
  ["the wrong prerelease flag", { isPrerelease: false }],
  ["a non-commit target", { targetCommitish: "main" }],
  ["extra metadata", { name: "Markiro Station" }],
]) {
  test(`rejects release metadata with ${label} before any S3 request`, async () => {
    const fixture = await reseedFixture("beta", { release });
    const store = fakeStore();

    await assert.rejects(
      createYandexPublisher({ store }).reseedFromGithub(fixture.input),
      /invalid station release reseed/,
    );
    assert.deepEqual(store.calls, []);
  });
}

test("rejects a GitHub tree that its own evidence does not reproduce", async () => {
  // Beta notes are outside SHA256SUMS, so the tree still validates; only the
  // deterministic rebuild notices the edit.
  const fixture = await reseedFixture("beta");
  await writeFile(join(fixture.tree, fixture.names.notes), "Edited beta notes\n");
  const store = fakeStore();

  await assert.rejects(
    createYandexPublisher({ store }).reseedFromGithub(fixture.input),
    /invalid station release reseed/,
  );
  assert.deepEqual(store.calls, []);
});

test("rejects a GitHub tree that fails the GitHub-origin validator", async () => {
  const fixture = await reseedFixture("stable");
  await writeFile(join(fixture.tree, fixture.names.bundle), "tampered bundle");
  const store = fakeStore();

  await assert.rejects(
    createYandexPublisher({ store }).reseedFromGithub(fixture.input),
    /invalid station release reseed/,
  );
  assert.deepEqual(store.calls, []);
});

test("rejects a source tag from the other channel", async () => {
  const fixture = await reseedFixture("stable");
  const store = fakeStore();

  await assert.rejects(
    createYandexPublisher({ store }).reseedFromGithub({ ...fixture.input, channel: "beta" }),
    /invalid station release reseed/,
  );
  assert.deepEqual(store.calls, []);
});

test("requires the reseed confirmation and a new record path", async () => {
  const fixture = await reseedFixture("beta");
  const store = fakeStore();
  const publisher = createYandexPublisher({ store });

  await assert.rejects(
    publisher.reseedFromGithub({
      ...fixture.input,
      confirmation: "--confirm-empty-channel-bootstrap",
    }),
    /invalid station release reseed/,
  );
  await writeFile(fixture.input.recordPath, "{}\n");
  await assert.rejects(publisher.reseedFromGithub(fixture.input), /invalid station release reseed/);
  const { recordPath, ...missingKey } = fixture.input;
  void recordPath;
  await assert.rejects(publisher.reseedFromGithub(missingKey), /invalid station release reseed/);
  assert.deepEqual(store.calls, []);
});

test("CLI passes exactly the reseed arguments and rejects anything else", async () => {
  const fixture = await reseedFixture("beta");
  const calls = [];
  const publisher = {
    async reseedFromGithub(input) {
      calls.push(input);
    },
  };
  const args = [
    "reseed-from-github",
    fixture.input.githubTree,
    fixture.input.sourceTag,
    fixture.input.releaseMetadataPath,
    fixture.input.githubChannelManifestPath,
    "beta",
    fixture.input.recordPath,
    confirmation,
  ];

  await runYandexPublisherCli(args, { publisher });
  assert.deepEqual(calls, [fixture.input]);

  for (const bad of [
    args.slice(0, -1),
    [...args, "extra"],
    args.with(7, "--yes"),
    args.with(5, "nightly"),
    args.with(2, "station-v2.3.0"),
    args.with(1, "relative/github"),
    args.with(6, `${fixture.root}/../record.json`),
  ]) {
    await assert.rejects(
      runYandexPublisherCli(bad, { publisher }),
      /invalid station release publisher command/,
    );
  }
  assert.equal(calls.length, 1);
});
