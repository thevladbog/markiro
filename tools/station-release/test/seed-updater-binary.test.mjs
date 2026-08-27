import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifySeedUpdaterBinary } from "../verify-seed-updater-binary.mjs";

const githubChannel =
  "https://github.com/thevladbog/markiro-station-releases/releases/download/station-beta-channel/latest.json";
const githubRelease =
  "https://github.com/thevladbog/markiro-station-releases/releases/download/station-v";

async function fixture(contents) {
  const directory = await mkdtemp(join(tmpdir(), "markiro-seed-binary-"));
  const path = join(directory, "markiro-station.exe");
  await writeFile(path, contents);
  return path;
}

test("accepts a bounded seed binary with only the legacy GitHub updater routes", async () => {
  const path = await fixture(Buffer.from(`prefix\0${githubChannel}\0${githubRelease}\0suffix`));
  await assert.doesNotReject(verifySeedUpdaterBinary(path));
});

test("rejects a seed binary containing Yandex routes or missing either GitHub route", async () => {
  for (const contents of [
    `${githubChannel}\0${githubRelease}\0https://releases.markiro.app`,
    githubChannel,
    githubRelease,
  ]) {
    await assert.rejects(verifySeedUpdaterBinary(await fixture(Buffer.from(contents))));
  }
});
