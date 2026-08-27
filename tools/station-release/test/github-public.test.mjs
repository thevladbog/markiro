import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { stationAssetNames } from "../artifacts.mjs";

const moduleUrl = new URL("../github-public.mjs", import.meta.url);
const version = "1.2.3";
const names = stationAssetNames(version);

async function githubPublic() {
  return import(moduleUrl);
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { location } });
}

test("reads immutable and channel assets through exact unauthenticated GitHub public URLs", async () => {
  const { createGithubPublicReader } = await githubPublic();
  const calls = [];
  const responses = [
    redirect(
      "https://release-assets.githubusercontent.com/github-production-release-asset/123/evidence?sig=bounded",
    ),
    new Response("evidence", { status: 200, headers: { "content-length": "8" } }),
    redirect(
      "https://release-assets.githubusercontent.com/github-production-release-asset/123/channel?sig=bounded",
    ),
    new Response("manifest", { status: 200, headers: { "content-length": "8" } }),
  ];
  const reader = createGithubPublicReader({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return responses.shift();
    },
  });

  assert.deepEqual(
    await reader.readReleaseAsset({
      channel: "stable",
      version,
      assetName: names.evidence,
    }),
    Buffer.from("evidence"),
  );
  assert.deepEqual(
    await reader.readChannelManifest({ channel: "stable" }),
    Buffer.from("manifest"),
  );
  assert.deepEqual(calls, [
    {
      url: `https://github.com/thevladbog/markiro-station-releases/releases/download/station-v${version}/${names.evidence}`,
      init: { redirect: "manual", cache: "no-store" },
    },
    {
      url: "https://release-assets.githubusercontent.com/github-production-release-asset/123/evidence?sig=bounded",
      init: { redirect: "error", cache: "no-store" },
    },
    {
      url: "https://github.com/thevladbog/markiro-station-releases/releases/download/station-stable-channel/latest.json",
      init: { redirect: "manual", cache: "no-store" },
    },
    {
      url: "https://release-assets.githubusercontent.com/github-production-release-asset/123/channel?sig=bounded",
      init: { redirect: "error", cache: "no-store" },
    },
  ]);
  assert.equal(
    calls.some(({ init }) => JSON.stringify(init).includes("uthorization")),
    false,
  );
});

test("retries transient GitHub public failures with bounded backoff", async () => {
  const { createGithubPublicReader } = await githubPublic();
  const waits = [];
  let call = 0;
  const location =
    "https://release-assets.githubusercontent.com/github-production-release-asset/123/retried?sig=bounded";
  const reader = createGithubPublicReader({
    fetchImpl: async () => {
      call += 1;
      if (call === 1) throw new Error("temporary provider failure with secret detail");
      if (call === 2) return new Response("not ready", { status: 404 });
      if (call === 3) return redirect(location);
      return new Response("manifest", { status: 200, headers: { "content-length": "8" } });
    },
    waitImpl: async (milliseconds) => waits.push(milliseconds),
  });

  assert.deepEqual(
    await reader.readChannelManifest({ channel: "stable" }),
    Buffer.from("manifest"),
  );
  assert.equal(call, 4);
  assert.deepEqual(waits, [1_000, 2_000]);
});

test("waits for the public channel asset to match the manifest uploaded with clobber", async () => {
  const { createGithubPublicReader } = await githubPublic();
  const waits = [];
  const staleManifest = Buffer.from('{"version":"1.2.0-beta.5"}\n');
  const expectedManifest = Buffer.from('{"version":"1.2.0-beta.6"}\n');
  const responses = [
    redirect(
      "https://release-assets.githubusercontent.com/github-production-release-asset/123/stale?sig=bounded",
    ),
    new Response(staleManifest, {
      status: 200,
      headers: { "content-length": String(staleManifest.byteLength) },
    }),
    redirect(
      "https://release-assets.githubusercontent.com/github-production-release-asset/123/fresh?sig=bounded",
    ),
    new Response(expectedManifest, {
      status: 200,
      headers: { "content-length": String(expectedManifest.byteLength) },
    }),
  ];
  const reader = createGithubPublicReader({
    fetchImpl: async () => responses.shift(),
    waitImpl: async (milliseconds) => waits.push(milliseconds),
  });

  assert.deepEqual(
    await reader.readChannelManifestMatching({
      channel: "beta",
      expected: expectedManifest,
    }),
    expectedManifest,
  );
  assert.deepEqual(waits, [2_000]);
});

test("bounds persistent GitHub public retries and sanitizes the final failure", async () => {
  const { createGithubPublicReader } = await githubPublic();
  const waits = [];
  let call = 0;
  const reader = createGithubPublicReader({
    fetchImpl: async () => {
      call += 1;
      throw new Error("github_pat_secret provider detail");
    },
    waitImpl: async (milliseconds) => waits.push(milliseconds),
  });

  await assert.rejects(reader.readChannelManifest({ channel: "stable" }), (error) => {
    assert.equal(error.message, "station GitHub public read failed");
    assert.equal(error.message.includes("secret"), false);
    return true;
  });
  assert.equal(call, 4);
  assert.deepEqual(waits, [1_000, 2_000, 4_000]);
});

test("rejects unsafe GitHub redirect schemes, hosts, paths, credentials and redirect chains", async () => {
  const { createGithubPublicReader } = await githubPublic();
  const invalidLocations = [
    "http://release-assets.githubusercontent.com/github-production-release-asset/123/file",
    "https://attacker.example/github-production-release-asset/123/file",
    "https://release-assets.githubusercontent.com/not-a-release-asset/123/file",
    "https://user:password@release-assets.githubusercontent.com/github-production-release-asset/123/file",
    "https://release-assets.githubusercontent.com:444/github-production-release-asset/123/file",
  ];
  for (const location of invalidLocations) {
    const reader = createGithubPublicReader({
      fetchImpl: async () => redirect(location),
    });
    await assert.rejects(
      reader.readChannelManifest({ channel: "stable" }),
      /station GitHub public read failed/,
    );
  }

  let call = 0;
  const chained = createGithubPublicReader({
    fetchImpl: async () => {
      call += 1;
      return call === 1
        ? redirect(
            "https://release-assets.githubusercontent.com/github-production-release-asset/123/file",
          )
        : redirect(
            "https://release-assets.githubusercontent.com/github-production-release-asset/123/other",
          );
    },
  });
  await assert.rejects(
    chained.readChannelManifest({ channel: "stable" }),
    /station GitHub public read failed/,
  );
  assert.equal(call, 2);
});

test("bounds GitHub public bodies and sanitizes provider failures", async () => {
  const { createGithubPublicReader } = await githubPublic();
  const location =
    "https://objects.githubusercontent.com/github-production-release-asset-2e65be/123/file?sig=bounded";
  const oversizedLength = createGithubPublicReader({
    fetchImpl: async (_url, init) =>
      init.redirect === "manual"
        ? redirect(location)
        : new Response("small", {
            status: 200,
            headers: { "content-length": String(256 * 1024 + 1) },
          }),
  });
  await assert.rejects(
    oversizedLength.readChannelManifest({ channel: "stable" }),
    /station GitHub public read failed/,
  );

  let cancelled = false;
  const oversizedStream = createGithubPublicReader({
    fetchImpl: async (_url, init) => {
      if (init.redirect === "manual") return redirect(location);
      return {
        ok: true,
        status: 200,
        redirected: false,
        url: location,
        headers: new Headers(),
        body: {
          cancel() {
            cancelled = true;
          },
          async *[Symbol.asyncIterator]() {
            yield Buffer.alloc(256 * 1024);
            yield Buffer.from("overflow");
          },
        },
      };
    },
  });
  await assert.rejects(
    oversizedStream.readChannelManifest({ channel: "stable" }),
    /station GitHub public read failed/,
  );
  assert.equal(cancelled, true);

  const secretFailure = createGithubPublicReader({
    fetchImpl: async () => {
      throw new Error("github_pat_secret release asset provider details");
    },
    waitImpl: async () => undefined,
  });
  await assert.rejects(secretFailure.readChannelManifest({ channel: "stable" }), (error) => {
    assert.equal(error.message, "station GitHub public read failed");
    assert.equal(error.message.includes("secret"), false);
    return true;
  });
});

test("downloads one exact closed stable release tree exclusively", async () => {
  const { createGithubPublicReader, downloadGithubReleaseTree } = await githubPublic();
  const parent = await mkdtemp(join(tmpdir(), "markiro-github-public-tree-"));
  const directory = join(parent, "stable");
  let sequence = 0;
  const reader = createGithubPublicReader({
    fetchImpl: async (_url, init) => {
      sequence += 1;
      if (init.redirect === "manual") {
        return redirect(
          `https://release-assets.githubusercontent.com/github-production-release-asset/123/${sequence}`,
        );
      }
      return new Response(`asset-${sequence}`, { status: 200 });
    },
  });

  await downloadGithubReleaseTree({ channel: "stable", version, directory, reader });
  assert.deepEqual((await readdir(directory)).sort(), Object.values(names).sort());
  for (const name of Object.values(names))
    assert.match(await readFile(join(directory, name), "utf8"), /^asset-/);
  await assert.rejects(
    downloadGithubReleaseTree({ channel: "stable", version, directory, reader }),
    /invalid station GitHub public read/,
  );
});
