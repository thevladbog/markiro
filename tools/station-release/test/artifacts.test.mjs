import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createBetaUpdateManifest,
  parseBetaUpdateManifest,
  stageStationRelease,
  stationAssetNames,
  validateStationReleaseDirectory,
} from "../artifacts.mjs";

const version = "0.1.0-beta.1";
const names = stationAssetNames(version);
const bundleUrl = `https://github.com/thevladbog/markiro/releases/download/station-v${version}/${names.bundle}`;

test("creates the exact one-platform Tauri beta manifest", () => {
  const manifest = createBetaUpdateManifest({
    version,
    pubDate: "2026-08-11T12:00:00.000Z",
    bundleUrl,
    signature: "trusted-test-signature",
  });
  assert.deepEqual(manifest, {
    version,
    pub_date: "2026-08-11T12:00:00.000Z",
    platforms: {
      "windows-x86_64": { url: bundleUrl, signature: "trusted-test-signature" },
    },
  });
  assert.deepEqual(
    parseBetaUpdateManifest(JSON.stringify(manifest), { version, bundleUrl }),
    manifest,
  );
});

test("rejects extra platforms, mutable URLs, traversal, symlinks and secret-shaped text", async () => {
  const valid = createBetaUpdateManifest({
    version,
    pubDate: "2026-08-11T12:00:00.000Z",
    bundleUrl,
    signature: "trusted-test-signature",
  });
  assert.throws(
    () =>
      parseBetaUpdateManifest(JSON.stringify({ ...valid, token: "ghp_sensitive" }), {
        version,
        bundleUrl,
      }),
    /invalid station release artifacts/,
  );
  assert.throws(
    () =>
      parseBetaUpdateManifest(
        JSON.stringify({ ...valid, platforms: { ...valid.platforms, linux: {} } }),
        { version, bundleUrl },
      ),
    /invalid station release artifacts/,
  );
  assert.throws(
    () =>
      parseBetaUpdateManifest(
        JSON.stringify({
          ...valid,
          platforms: {
            "windows-x86_64": { ...valid.platforms["windows-x86_64"], url: "http://evil" },
          },
        }),
        { version, bundleUrl },
      ),
    /invalid station release artifacts/,
  );
  const directory = await mkdtemp(join(tmpdir(), "markiro-station-artifacts-"));
  await writeFile(join(directory, "real"), "bundle");
  await symlink(join(directory, "real"), join(directory, names.bundle));
  assert.equal(await readFile(join(directory, "real"), "utf8"), "bundle");
});

test("rejects noncanonical versions, dates, signatures and secret-shaped text", () => {
  assert.throws(() => stationAssetNames("0.1.0"), /invalid station release artifacts/);
  assert.throws(
    () =>
      createBetaUpdateManifest({
        version,
        pubDate: "2026-08-11T12:00:00Z",
        bundleUrl,
        signature: "signature",
      }),
    /invalid station release artifacts/,
  );
  assert.throws(
    () =>
      createBetaUpdateManifest({
        version,
        pubDate: "2099-08-11T12:00:00.000Z",
        bundleUrl,
        signature: "signature",
      }),
    /invalid station release artifacts/,
  );
  assert.throws(
    () =>
      createBetaUpdateManifest({
        version,
        pubDate: "2026-08-11T12:00:00.000Z",
        bundleUrl,
        signature: "TAURI_SIGNING_PRIVATE_KEY=secret",
      }),
    /invalid station release artifacts/,
  );
});

test("stages and validates the canonical release tree", async () => {
  const input = await mkdtemp(join(tmpdir(), "markiro-station-input-"));
  const output = await mkdtemp(join(tmpdir(), "markiro-station-output-"));
  await rm(output, { recursive: true });
  for (const [name, content] of [
    [names.installer, "installer"],
    [names.bundle, "bundle"],
    [names.signature, "trusted-signature"],
  ])
    await writeFile(join(input, name), content);
  const evidence = await stageStationRelease({
    inputDirectory: input,
    outputDirectory: output,
    version,
    pubDate: "2026-08-11T10:00:00.000Z",
    baseSha: "a".repeat(40),
    releaseSha: "b".repeat(40),
  });
  assert.equal(evidence.version, version);
  const validated = await validateStationReleaseDirectory(output, { version });
  assert.equal(validated.manifest.version, version);
  assert.match(await readFile(join(output, names.checksums), "utf8"), /[0-9a-f]{64}  latest\.json/);
});
