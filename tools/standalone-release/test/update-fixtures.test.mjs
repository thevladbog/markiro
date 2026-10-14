import assert from "node:assert/strict";
import { createPublicKey } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  FIXTURE_RELEASES,
  SHELL_FIXTURES,
  TEST_KEYS,
  TEST_UPDATE_KID,
  findJwk,
  fixtureManifest,
} from "../generate-update-fixtures.mjs";
import { manifestFileName, verifyCompact } from "../sign-update.mjs";

// The signed manifests the shell's tests read (plan ОБН-2) stay what the
// generator signs: a stale or hand-edited fixture would test nothing.

const keyset = JSON.parse(await readFile(join(TEST_KEYS, "test-keyset.json"), "utf8"));
const jwk = findJwk(keyset.update, TEST_UPDATE_KID);
const publicKey = createPublicKey({
  key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
  format: "jwk",
});
const compact = async (...path) => (await readFile(join(SHELL_FIXTURES, ...path), "utf8")).trim();

test("the shell's update fixtures are the releases the generator signs and one tampered manifest", async () => {
  assert.deepEqual(
    (await readdir(SHELL_FIXTURES)).sort(),
    [...FIXTURE_RELEASES.map((release) => manifestFileName(release.version)), "tampered"].sort(),
  );
  assert.deepEqual(await readdir(join(SHELL_FIXTURES, "tampered")), [manifestFileName("0.2.0")]);
});

test("each signed fixture verifies with the test release key and names its test installer", async () => {
  for (const release of FIXTURE_RELEASES) {
    const { header, payload } = verifyCompact(
      publicKey,
      await compact(manifestFileName(release.version)),
    );
    assert.deepEqual(header, {
      typ: "markiro-standalone-update+jws",
      alg: "ES256",
      kid: TEST_UPDATE_KID,
    });
    assert.deepEqual(payload, fixtureManifest(release));
  }
});

test("the tampered fixture does not verify", async () => {
  const text = await compact("tampered", manifestFileName("0.2.0"));
  assert.throws(() => verifyCompact(publicKey, text), /does not verify/u);
});
