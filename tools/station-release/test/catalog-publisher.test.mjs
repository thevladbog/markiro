import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stageStationRelease, stationAssetNames } from "../artifacts.mjs";
import { createStationCatalogPublisher } from "../catalog-publisher.mjs";
const version = "2.4.0-beta.5",
  channel = "beta",
  hash = (b) => createHash("sha256").update(b).digest("hex");
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "station-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, "input"),
    tree = join(root, "tree"),
    stateDirectory = join(root, "state");
  await mkdir(input);
  const names = stationAssetNames(version);
  for (const [name, bytes] of [
    [names.installer, "exe"],
    [names.bundle, "zip"],
    [names.signature, "trusted-signature"],
  ])
    await writeFile(join(input, name), bytes);
  await stageStationRelease({
    channel,
    version,
    origin: "yandex",
    inputDirectory: input,
    outputDirectory: tree,
    pubDate: "2026-10-24T00:00:00.000Z",
    baseSha: "a".repeat(40),
    releaseSha: "b".repeat(40),
  });
  const calls = [];
  let accepted = null,
    request = null,
    failUpload = false,
    failCommit = false,
    snapshot = {
      identity: { product: "station", channel },
      revision: "3",
      publicationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      readable: true,
    };
  const id = "11111111-1111-4111-8111-111111111111",
    pub = "22222222-2222-4222-8222-222222222222";
  const catalog = {
    async getPublication(r) {
      calls.push("read-publication");
      if (accepted) assert.deepEqual(r, request);
      return accepted;
    },
    async getChannel() {
      calls.push("read-channel");
      return snapshot;
    },
    async createIntent(key, r) {
      calls.push("intent");
      request = r;
      return {
        id,
        identity: r.identity,
        state: "pending",
        expiresAt: "2099-01-01T00:00:00Z",
        files: r.files.map((f) => ({ ...f, key: `station/_uploads/${id}/${f.name}` })),
      };
    },
    async uploadFile(intent, name, body) {
      calls.push(`put:${name}`);
      if (failUpload) throw Error("ambiguous PUT");
      assert.equal(hash(body), intent.files.find((f) => f.name === name).sha256);
      return { name, versionId: `version:${name}` };
    },
    async commitIntent(intent, files) {
      calls.push("commit-and-full-readback");
      if (failCommit) throw Error("readback failed");
      accepted = {
        publicationId: pub,
        identity: intent.identity,
        files: request.files.map((f) => ({
          ...f,
          publicPath: `/station/beta/releases/${version}/${f.name}`,
          versionId: files.find((x) => x.name === f.name).versionId,
        })),
      };
      return accepted;
    },
    async changeChannel(scope, change) {
      calls.push({ change });
      assert.equal(change.expectedRevision, snapshot.revision === "0" ? "0" : "3");
      assert.equal(change.targetPublicationId, pub);
      return { ...snapshot, revision: "4", publicationId: pub };
    },
  };
  const env = { GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: "c".repeat(40) };
  return {
    root,
    tree,
    stateDirectory,
    catalog,
    calls,
    env,
    publisher: createStationCatalogPublisher({ catalog, env }),
    failUpload() {
      failUpload = true;
    },
    failCommit() {
      failCommit = true;
    },
    empty() {
      snapshot = { ...snapshot, revision: "0", publicationId: null, readable: false };
    },
    move() {
      snapshot = { ...snapshot, revision: "9" };
    },
  };
}
test("registers seven canonical bytes then promotes against the saved revision, never a mutable PUT", async (t) => {
  const f = await fixture(t);
  await f.publisher.snapshot({ channel, stateDirectory: f.stateDirectory });
  await f.publisher.register({ tree: f.tree, channel, version, stateDirectory: f.stateDirectory });
  assert.equal(f.calls.filter((x) => typeof x === "string" && x.startsWith("put:")).length, 7);
  f.move();
  await f.publisher.promote({ tree: f.tree, channel, version, stateDirectory: f.stateDirectory });
  assert.ok(
    f.calls.indexOf("commit-and-full-readback") < f.calls.findIndex((x) => typeof x === "object"),
  );
  const change = f.calls.find((x) => typeof x === "object").change;
  await f.publisher.promote({ tree: f.tree, channel, version, stateDirectory: f.stateDirectory });
  assert.deepEqual(
    f.calls.filter((x) => typeof x === "object").map((x) => x.change),
    [change, change],
  );
});
test("retains an ambiguous staged PUT and refuses to repeat it", async (t) => {
  const f = await fixture(t);
  f.failUpload();
  const input = { tree: f.tree, channel, version, stateDirectory: f.stateDirectory };
  await assert.rejects(f.publisher.register(input), /ambiguous/);
  const count = f.calls.filter((x) => String(x).startsWith("put:")).length;
  await assert.rejects(f.publisher.register(input), /reconcile/);
  assert.equal(f.calls.filter((x) => String(x).startsWith("put:")).length, count);
});
test("failed readback never changes channel; exact retry uses retained versions without repeating PUTs", async (t) => {
  const f = await fixture(t);
  f.failCommit();
  const input = { tree: f.tree, channel, version, stateDirectory: f.stateDirectory };
  await f.publisher.snapshot({ channel, stateDirectory: f.stateDirectory });
  await assert.rejects(f.publisher.register(input), /readback/);
  await assert.rejects(f.publisher.register(input), /readback/);
  assert.equal(f.calls.filter((x) => String(x).startsWith("put:")).length, 7);
  assert.equal(
    f.calls.some((x) => typeof x === "object"),
    false,
  );
  await assert.rejects(f.publisher.promote(input), /registered/);
});
test("changed local bytes and changed run cannot reuse the publication journal", async (t) => {
  const f = await fixture(t),
    input = { tree: f.tree, channel, version, stateDirectory: f.stateDirectory };
  await f.publisher.register(input);
  const next = createStationCatalogPublisher({
    catalog: f.catalog,
    env: { ...f.env, GITHUB_RUN_ATTEMPT: "2" },
  });
  await assert.rejects(next.register(input), /journal/);
  await writeFile(join(f.tree, stationAssetNames(version).installer), "changed");
  await assert.rejects(f.publisher.register(input));
});
test("reseed keeps GitHub tag/channel/asset provenance and refuses a nonempty different catalog channel", async (t) => {
  const { reseedStationCatalog } = await import("../catalog-cli.mjs");
  const f = await fixture(t),
    github = join(f.root, "github");
  // Rebuild from the same exact product bytes; only origin-specific metadata differs.
  await stageStationRelease({
    channel,
    version,
    origin: "github",
    inputDirectory: f.tree,
    outputDirectory: github,
    pubDate: "2026-10-24T00:00:00.000Z",
    baseSha: "a".repeat(40),
    releaseSha: "b".repeat(40),
  });
  const releaseMetadataPath = join(f.root, "release.json"),
    githubChannelManifestPath = join(f.root, "latest.json");
  await writeFile(
    releaseMetadataPath,
    JSON.stringify({
      tagName: `station-v${version}`,
      isDraft: false,
      isPrerelease: true,
      targetCommitish: "d".repeat(40),
    }),
  );
  await writeFile(githubChannelManifestPath, await readFile(join(github, "latest.json")));
  await assert.rejects(
    reseedStationCatalog(
      {
        githubTree: github,
        sourceTag: `station-v${version}`,
        releaseMetadataPath,
        githubChannelManifestPath,
        channel,
        recordPath: join(f.root, "record.json"),
        confirmation: "--confirm-reseed-from-github",
      },
      { catalog: f.catalog, publisher: f.publisher, stateDirectory: f.stateDirectory },
    ),
    /nonempty/,
  );
  assert.equal(f.calls.includes("intent"), false);
  await writeFile(githubChannelManifestPath, "{}");
  await assert.rejects(
    reseedStationCatalog(
      {
        githubTree: github,
        sourceTag: `station-v${version}`,
        releaseMetadataPath,
        githubChannelManifestPath,
        channel,
        recordPath: join(f.root, "record.json"),
        confirmation: "--confirm-reseed-from-github",
      },
      { catalog: f.catalog, publisher: f.publisher, stateDirectory: f.stateDirectory },
    ),
    /provenance/,
  );
});

test("channel readback accepts canonical JSON formatting but rejects changed bytes and concurrent moves", async (t) => {
  const { verifyStationCatalogChannel } = await import("../catalog-cli.mjs");
  const f = await fixture(t),
    names = stationAssetNames(version);
  const manifest = JSON.parse(await readFile(join(f.tree, names.manifest), "utf8"));
  const bytes = await readFile(join(f.tree, names.installer));
  const fetchImpl = async (url) =>
    String(url).endsWith("/download") ? new Response(bytes) : Response.json(manifest);
  await verifyStationCatalogChannel({ tree: f.tree, channel, version, fetchImpl });
  await assert.rejects(
    verifyStationCatalogChannel({
      tree: f.tree,
      channel,
      version,
      fetchImpl: async (url) =>
        String(url).endsWith("/download") ? new Response("bad") : Response.json(manifest),
    }),
    /download changed/,
  );
  let reads = 0;
  await assert.rejects(
    verifyStationCatalogChannel({
      tree: f.tree,
      channel,
      version,
      fetchImpl: async (url) =>
        String(url).endsWith("/download")
          ? new Response(bytes)
          : Response.json(++reads === 1 ? manifest : { ...manifest, version: "9.9.9" }),
    }),
    /changed during readback/,
  );
});
test("reseed registers the verified GitHub tree before revision-zero promotion and preserves product source", async (t) => {
  const { reseedStationCatalog } = await import("../catalog-cli.mjs");
  const f = await fixture(t);
  f.empty();
  const github = join(f.root, "github");
  await stageStationRelease({
    channel,
    version,
    origin: "github",
    inputDirectory: f.tree,
    outputDirectory: github,
    pubDate: "2026-10-24T00:00:00.000Z",
    baseSha: "a".repeat(40),
    releaseSha: "b".repeat(40),
  });
  const releaseMetadataPath = join(f.root, "release.json"),
    githubChannelManifestPath = join(f.root, "channel.json"),
    recordPath = join(f.root, "record.json");
  await writeFile(
    releaseMetadataPath,
    JSON.stringify({
      tagName: `station-v${version}`,
      isDraft: false,
      isPrerelease: true,
      targetCommitish: "d".repeat(40),
    }),
  );
  await writeFile(githubChannelManifestPath, await readFile(join(github, "latest.json")));
  let verified = false;
  await reseedStationCatalog(
    {
      githubTree: github,
      channel,
      sourceTag: `station-v${version}`,
      releaseMetadataPath,
      githubChannelManifestPath,
      recordPath,
      confirmation: "--confirm-reseed-from-github",
    },
    {
      publisher: f.publisher,
      stateDirectory: f.stateDirectory,
      verifyChannel: async ({ tree }) => {
        assert.equal(
          JSON.parse(await readFile(join(tree, "release-evidence.json"))).releaseSha,
          "b".repeat(40),
        );
        verified = true;
      },
    },
  );
  assert.equal(verified, true);
  assert.equal(f.calls.filter((x) => String(x).startsWith("put:")).length, 7);
  assert.equal(f.calls.find((x) => typeof x === "object").change.expectedRevision, "0");
  assert.equal(JSON.parse(await readFile(recordPath)).releaseSha, "b".repeat(40));
});
