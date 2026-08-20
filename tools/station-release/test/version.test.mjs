import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  nextStationBetaVersion,
  parseStationBetaTag,
  readStationSourceVersion,
  writeStationSourceVersion,
} from "../version.mjs";

test("accepts only canonical station beta tags", () => {
  assert.equal(parseStationBetaTag("station-v0.1.0-beta.7")?.text, "0.1.0-beta.7");
  for (const tag of [
    "v0.1.0-beta.7",
    "station-v0.1.0",
    "station-v01.1.0-beta.1",
    "station-v0.1.0-beta.0",
    "station-v0.1.0-beta.1-extra",
    "station-v999999999999999999999.1.0-beta.1",
  ])
    assert.equal(parseStationBetaTag(tag), null, tag);
});

test("applies every approved beta bump and ignores unrelated tags", () => {
  const tags = ["v9.9.9", "station-v0.1.0", "station-v0.1.0-beta.2"];
  assert.equal(nextStationBetaVersion([], "next-beta"), "0.1.0-beta.1");
  assert.equal(nextStationBetaVersion(tags, "next-beta"), "0.1.0-beta.3");
  assert.equal(nextStationBetaVersion(tags, "next-patch-beta"), "0.1.1-beta.1");
  assert.equal(nextStationBetaVersion(tags, "next-minor-beta"), "0.2.0-beta.1");
  assert.equal(nextStationBetaVersion(tags, "next-major-beta"), "1.0.0-beta.1");
  assert.throws(() => nextStationBetaVersion(tags, "major"), /invalid station beta bump/);
});

test("updates exactly the Tauri and Cargo package versions", async () => {
  const root = await mkdtemp(join(tmpdir(), "markiro-station-version-"));
  await mkdir(join(root, "apps/station/src-tauri"), { recursive: true });
  await writeFile(
    join(root, "apps/station/src-tauri/tauri.conf.json"),
    JSON.stringify({ productName: "Markiro Station", version: "0.1.0" }, null, 2) + "\n",
  );
  await writeFile(
    join(root, "apps/station/src-tauri/Cargo.toml"),
    '[package]\nname = "markiro-station"\nversion = "0.1.0"\n\n[dependencies]\n',
  );

  await writeStationSourceVersion(pathToFileURL(`${root}/`), "0.1.0-beta.1");

  assert.equal(await readStationSourceVersion(pathToFileURL(`${root}/`)), "0.1.0-beta.1");
  assert.match(
    await readFile(join(root, "apps/station/src-tauri/Cargo.toml"), "utf8"),
    /version = "0\.1\.0-beta\.1"/,
  );
});

test("rejects symlinked source version files", async () => {
  const root = await mkdtemp(join(tmpdir(), "markiro-station-version-link-"));
  const tauriRoot = join(root, "apps/station/src-tauri");
  await mkdir(tauriRoot, { recursive: true });
  const external = join(root, "external.json");
  await writeFile(external, JSON.stringify({ version: "0.1.0" }));
  await symlink(external, join(tauriRoot, "tauri.conf.json"));
  await writeFile(join(tauriRoot, "Cargo.toml"), '[package]\nversion = "0.1.0"\n');
  await assert.rejects(
    readStationSourceVersion(pathToFileURL(`${root}/`)),
    /invalid station beta source tree/,
  );
});
