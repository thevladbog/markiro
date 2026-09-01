import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { prepareSignerRelease, verifyPreparedSignerRelease } from "../prepare.mjs";

const VERSION = "0.1.5";
const INSTALLER = "markiro-signer-0.1.5-windows-x86_64-setup.exe";
const SIGNATURE = `${INSTALLER}.sig`;
const SIGNATURE_TEXT = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQo=";
const SOURCE_SHA = "a".repeat(40);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "signer-prepare-"));
  const bundleDir = join(root, "bundle");
  const outputDir = join(root, "prepared");
  await mkdir(bundleDir);
  await writeFile(join(bundleDir, "Markiro Signer_0.1.5_x64-setup.exe"), "signed installer");
  await writeFile(join(bundleDir, "Markiro Signer_0.1.5_x64-setup.exe.sig"), `${SIGNATURE_TEXT}\n`);
  return { bundleDir, outputDir };
}

test("prepares one self-verifying release directory", async () => {
  const { bundleDir, outputDir } = await fixture();
  const prepared = await prepareSignerRelease({
    version: VERSION,
    sourceRepository: "thevladbog/markiro",
    sourceSha: SOURCE_SHA,
    bundleDir,
    outputDir,
    pubDate: "2026-09-01T12:00:00.000Z",
  });

  assert.deepEqual((await readdir(outputDir)).sort(), [
    "SHA256SUMS",
    "latest.json",
    INSTALLER,
    SIGNATURE,
    "release-evidence.json",
  ]);
  assert.equal(prepared.evidence.source.repository, "thevladbog/markiro");
  assert.equal(prepared.evidence.source.sha, SOURCE_SHA);
  assert.equal(prepared.manifest.version, VERSION);
  assert.equal(
    prepared.manifest.platforms["windows-x86_64"].url,
    `https://releases.markiro.app/signer/stable/releases/${VERSION}/${INSTALLER}`,
  );
  assert.equal(prepared.manifest.platforms["windows-x86_64"].signature, SIGNATURE_TEXT);

  const verified = await verifyPreparedSignerRelease({ directory: outputDir, version: VERSION });
  assert.equal(verified.hashes[INSTALLER].length, 64);
  assert.equal(verified.hashes[SIGNATURE].length, 64);
});

test("rejects tampered prepared bytes", async () => {
  const { bundleDir, outputDir } = await fixture();
  await prepareSignerRelease({
    version: VERSION,
    sourceRepository: "thevladbog/markiro",
    sourceSha: SOURCE_SHA,
    bundleDir,
    outputDir,
    pubDate: "2026-09-01T12:00:00.000Z",
  });
  await writeFile(join(outputDir, INSTALLER), "different bytes");

  await assert.rejects(
    verifyPreparedSignerRelease({ directory: outputDir, version: VERSION }),
    /checksum/,
  );
});

test("rejects an extra file in a prepared release", async () => {
  const { bundleDir, outputDir } = await fixture();
  await prepareSignerRelease({
    version: VERSION,
    sourceRepository: "thevladbog/markiro",
    sourceSha: SOURCE_SHA,
    bundleDir,
    outputDir,
    pubDate: "2026-09-01T12:00:00.000Z",
  });
  await writeFile(join(outputDir, "unexpected.txt"), "not part of the release");

  await assert.rejects(
    verifyPreparedSignerRelease({ directory: outputDir, version: VERSION }),
    /asset set/,
  );
});

test("writes checksums for every non-checksum asset", async () => {
  const { bundleDir, outputDir } = await fixture();
  await prepareSignerRelease({
    version: VERSION,
    sourceRepository: "thevladbog/markiro",
    sourceSha: SOURCE_SHA,
    bundleDir,
    outputDir,
    pubDate: "2026-09-01T12:00:00.000Z",
  });
  const sums = await readFile(join(outputDir, "SHA256SUMS"), "utf8");
  assert.deepEqual(
    sums
      .trim()
      .split("\n")
      .map((line) => line.slice(66))
      .sort(),
    ["latest.json", INSTALLER, SIGNATURE, "release-evidence.json"].sort(),
  );
});
