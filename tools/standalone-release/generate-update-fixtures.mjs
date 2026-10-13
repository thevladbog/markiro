// The signed update manifests the shell's tests read (plan ОБН-2):
// apps/standalone/src-tauri/tests/fixtures/update. Signed with the TEST
// release key of packages/domain/fixtures/standalone-license (kid
// test-upd-1, plan ЛЦ-1) by the signCompact the owner's tool uses. The
// installers are not committed: a test writes `markiro test installer
// <version>\n` beside a manifest, and the manifest names that text's SHA-256
// and size. Never run in CI; ECDSA signatures are randomized, so the tests
// verify the files and never compare their bytes.
//
//   node tools/standalone-release/generate-update-fixtures.mjs

import { createHash, createPrivateKey } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { UPDATE_PRODUCT, standaloneInstallerName } from "./prepare.mjs";
import { checkManifest, manifestFileName, signCompact } from "./sign-update.mjs";

export const SHELL_FIXTURES = "apps/standalone/src-tauri/tests/fixtures/update";
export const TEST_KEYS = "packages/domain/fixtures/standalone-license";
export const TEST_UPDATE_KID = "test-upd-1";

/** 0.2.0 follows the installed 0.1.0 on the same protocol; 0.3.0 needs 0.2.0 first and a newer host. */
export const FIXTURE_RELEASES = Object.freeze([
  {
    version: "0.2.0",
    channel: "stable",
    protocol: 3,
    minProtocol: 1,
    minUpgradeFrom: "0.1.0",
    notes: ["Тестовый выпуск 0.2.0"],
  },
  {
    version: "0.3.0",
    channel: "beta",
    protocol: 4,
    minProtocol: 2,
    minUpgradeFrom: "0.2.0",
    notes: ["Тестовый выпуск 0.3.0", "Протокол 4: хост площадки обновляется первым"],
  },
]);

/** The bytes of the test installer of `version` (the shell's tests write the same). */
export function testInstallerBytes(version) {
  return Buffer.from(`markiro test installer ${version}\n`, "utf8");
}

export function fixtureManifest({
  version,
  channel,
  protocol,
  minProtocol,
  minUpgradeFrom,
  notes,
}) {
  const installer = testInstallerBytes(version);
  return checkManifest({
    v: 1,
    product: UPDATE_PRODUCT,
    version,
    channel,
    releasedAt: "2026-11-02T10:00:00Z",
    sourceSha: "a".repeat(40),
    installer: {
      name: standaloneInstallerName(version),
      sha256: createHash("sha256").update(installer).digest("hex"),
      sizeBytes: installer.length,
    },
    protocol,
    minProtocol,
    minUpgradeFrom,
    notes: [...notes],
  });
}

/**
 * The JWK of `kid` anywhere in a key file of plan ЛЦ-1: an object `{ kid, jwk }`
 * (`test-keyset.json`), `{ kid, privateJwk }` (`test-private-keys.json`) or a
 * JWK with its own `kid`.
 */
export function findJwk(value, kid) {
  if (value === null || typeof value !== "object") return null;
  if (value.kid === kid) {
    for (const inner of [value.jwk, value.privateJwk]) {
      if (inner !== null && typeof inner === "object") return inner;
    }
    if (value.kty === "EC") return value;
  }
  for (const inner of Object.values(value)) {
    const found = findJwk(inner, kid);
    if (found !== null) return found;
  }
  return null;
}

async function main() {
  const jwk = findJwk(
    JSON.parse(await readFile(join(TEST_KEYS, "test-private-keys.json"), "utf8")).update,
    TEST_UPDATE_KID,
  );
  if (jwk === null || typeof jwk.d !== "string") {
    throw new Error(`no private ${TEST_UPDATE_KID} in ${TEST_KEYS}/test-private-keys.json`);
  }
  const key = createPrivateKey({
    key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d },
    format: "jwk",
  });
  await mkdir(join(SHELL_FIXTURES, "tampered"), { recursive: true });
  for (const release of FIXTURE_RELEASES) {
    const compact = signCompact(key, TEST_UPDATE_KID, fixtureManifest(release));
    await writeFile(join(SHELL_FIXTURES, manifestFileName(release.version)), `${compact}\n`);
  }
  // A manifest changed after signing: 0.2.0's header and signature over other notes.
  const [first] = FIXTURE_RELEASES;
  const [header, , signature] = signCompact(key, TEST_UPDATE_KID, fixtureManifest(first)).split(
    ".",
  );
  const changed = Buffer.from(
    JSON.stringify(fixtureManifest({ ...first, notes: ["Подменённые заметки"] })),
  ).toString("base64url");
  await writeFile(
    join(SHELL_FIXTURES, "tampered", manifestFileName(first.version)),
    `${header}.${changed}.${signature}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
