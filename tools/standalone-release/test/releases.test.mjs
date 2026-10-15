import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readProtocolRange, readStandaloneVersion } from "../prepare.mjs";
import { checkCompatibilityWindow, readReleases } from "../releases.mjs";

test("this build stays within one release of the one before it (N−1, spec §10.11.6)", async () => {
  const build = { version: await readStandaloneVersion(), ...(await readProtocolRange()) };
  checkCompatibilityWindow(build, await readReleases());
});

test("a minimum protocol above the release before it is refused", () => {
  const releases = [{ version: "0.2.0", protocol: 3, minProtocol: 1 }];
  assert.throws(
    () => checkCompatibilityWindow({ version: "0.3.0", protocol: 5, minProtocol: 4 }, releases),
    /N−1/u,
  );
  assert.deepEqual(
    checkCompatibilityWindow({ version: "0.3.0", protocol: 4, minProtocol: 3 }, releases).previous,
    releases[0],
  );
  // The first release has nothing before it.
  assert.equal(
    checkCompatibilityWindow({ version: "0.1.0", protocol: 9, minProtocol: 9 }, releases).previous,
    null,
  );
  assert.throws(
    () => checkCompatibilityWindow({ version: "0.3.0", protocol: 2, minProtocol: 1 }, releases),
    /goes back/u,
  );
});

test("a recorded release must be the build it names", () => {
  const releases = [{ version: "0.2.0", protocol: 3, minProtocol: 1 }];
  assert.throws(
    () => checkCompatibilityWindow({ version: "0.2.0", protocol: 4, minProtocol: 1 }, releases),
    /recorded/u,
  );
});

test("the list of releases is strict and in order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "markiro-releases-"));
  const file = join(dir, "releases.json");
  const write = (releases) =>
    writeFile(file, JSON.stringify({ schemaVersion: 1, releases }), "utf8");
  await write([{ version: "0.1.0", protocol: 3, minProtocol: 1, date: "x" }]);
  await assert.rejects(readReleases(file), /keys/u);
  await write([
    { version: "0.2.0", protocol: 3, minProtocol: 1 },
    { version: "0.1.0", protocol: 3, minProtocol: 1 },
  ]);
  await assert.rejects(readReleases(file), /order/u);
  await write([{ version: "0.1.0", protocol: 1, minProtocol: 2 }]);
  await assert.rejects(readReleases(file), /protocol/u);
  await write([{ version: "0.1", protocol: 3, minProtocol: 1 }]);
  await assert.rejects(readReleases(file), /not a version/u);
});
