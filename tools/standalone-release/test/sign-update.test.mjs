import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { findJwk } from "../generate-update-fixtures.mjs";
import { prepareStandaloneRelease } from "../prepare.mjs";
import {
  MAX_NOTE_CHARS,
  buildManifest,
  checkManifest,
  compareVersions,
  manifestFileName,
  parseNotes,
  signCompact,
  signUpdate,
  updateFolderName,
  verifyCompact,
} from "../sign-update.mjs";

const SIGN = join(import.meta.dirname, "..", "sign-update.mjs");
const VERSION = "0.1.0";
const INSTALLER = "markiro-standalone-0.1.0-windows-x86_64-setup.exe";
const PASSPHRASE = "a passphrase only this test knows";
const OPTIONS = {
  channel: "stable",
  releasedAt: "2026-11-02T10:00:00Z",
  minUpgradeFrom: "0.1.0",
  notes: ["Лицензия площадки и страница «Информация»"],
};
const DRAFT = {
  v: 1,
  product: "markiro-standalone",
  version: "0.3.0",
  sourceSha: "b".repeat(40),
  installer: {
    name: "markiro-standalone-0.3.0-windows-x86_64-setup.exe",
    sha256: "c".repeat(64),
    sizeBytes: 61234567,
  },
  protocol: 4,
  minProtocol: 2,
};

/** A release as prepare.mjs writes it, in a temporary directory outside the repository. */
async function release() {
  const root = await mkdtemp(join(tmpdir(), "standalone-sign-"));
  const bundleDir = join(root, "nsis");
  await mkdir(bundleDir);
  await writeFile(
    join(bundleDir, "Markiro Standalone_0.1.0_x64-setup.exe"),
    "bytes of the installer",
  );
  const releaseDir = join(root, "prepared");
  await prepareStandaloneRelease({
    version: VERSION,
    sourceRepository: "thevladbog/markiro",
    sourceSha: "a".repeat(40),
    bundleDir,
    outputDir: releaseDir,
    authenticode: "NotSigned",
    protocol: 3,
    minProtocol: 1,
  });
  return { root, releaseDir };
}

/** A fresh release key and its PKCS#8 PEM under the test's passphrase. */
function releaseKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const keyPem = privateKey.export({
    type: "pkcs8",
    format: "pem",
    cipher: "aes-256-cbc",
    passphrase: PASSPHRASE,
  });
  return { keyPem, privateKey, publicKey };
}

test("notes are 1-30 trimmed lines of at most 200 characters, without control characters", () => {
  assert.deepEqual(parseNotes("\uFEFF  Первая строка \r\n\r\nВторая\n"), [
    "Первая строка",
    "Вторая",
  ]);
  assert.deepEqual(parseNotes("ё".repeat(MAX_NOTE_CHARS)), ["ё".repeat(MAX_NOTE_CHARS)]);
  for (const bad of [
    "",
    "\n \n",
    Array.from({ length: 31 }, (_, index) => `строка ${index}`).join("\n"),
    "я".repeat(MAX_NOTE_CHARS + 1),
    "табуляция\tвнутри",
  ]) {
    assert.throws(() => parseNotes(bad), /notes/u, JSON.stringify(bad.slice(0, 20)));
  }
});

test("versions compare as numbers", () => {
  assert.equal(compareVersions("0.10.0", "0.9.0"), 1);
  assert.equal(compareVersions("0.2.0", "0.2.0"), 0);
  assert.equal(compareVersions("0.1.9", "0.2.0"), -1);
  assert.throws(() => compareVersions("0.2", "0.2.0"), /not a version/u);
});

test("the manifest is the draft with the owner's channel, date, minimum and notes, in the spec's order", () => {
  const manifest = buildManifest(DRAFT, { ...OPTIONS, minUpgradeFrom: "0.2.0" });
  assert.deepEqual(manifest, {
    v: 1,
    product: "markiro-standalone",
    version: "0.3.0",
    channel: "stable",
    releasedAt: "2026-11-02T10:00:00Z",
    sourceSha: "b".repeat(40),
    installer: DRAFT.installer,
    protocol: 4,
    minProtocol: 2,
    minUpgradeFrom: "0.2.0",
    notes: OPTIONS.notes,
  });
  assert.deepEqual(Object.keys(manifest), [
    "v",
    "product",
    "version",
    "channel",
    "releasedAt",
    "sourceSha",
    "installer",
    "protocol",
    "minProtocol",
    "minUpgradeFrom",
    "notes",
  ]);
  assert.equal(buildManifest(DRAFT, { ...OPTIONS, channel: "beta" }).channel, "beta");
  for (const [what, options, expected] of [
    ["a channel", { ...OPTIONS, channel: "nightly" }, /stable or beta/u],
    ["a date", { ...OPTIONS, releasedAt: "2026-11-02 10:00" }, /release time/u],
    [
      "a date with fractions",
      { ...OPTIONS, releasedAt: "2026-11-02T10:00:00.000Z" },
      /release time/u,
    ],
    ["a newer minimum", { ...OPTIONS, minUpgradeFrom: "0.4.0" }, /not be newer/u],
    ["no version", { ...OPTIONS, minUpgradeFrom: "0.2" }, /not a version/u],
  ]) {
    assert.throws(() => buildManifest(DRAFT, options), expected, what);
  }
  for (const [what, draft] of [
    ["an extra key", { ...DRAFT, channel: "stable" }],
    ["another installer name", { ...DRAFT, installer: { ...DRAFT.installer, name: "setup.exe" } }],
    ["a range upside down", { ...DRAFT, minProtocol: 5 }],
    ["another product", { ...DRAFT, product: "station" }],
    ["a short hash", { ...DRAFT, installer: { ...DRAFT.installer, sha256: "c".repeat(63) } }],
  ]) {
    assert.throws(() => buildManifest(draft, OPTIONS), /draft|shape/u, what);
  }
});

test("a compact JWS ES256 of the update type: canonical base64url and a 64-byte signature", () => {
  const { privateKey, publicKey } = releaseKey();
  const manifest = buildManifest(DRAFT, OPTIONS);
  const compact = signCompact(privateKey, "upd-2026-1", manifest);
  const [header, payload, signature] = compact.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString("utf8")), {
    typ: "markiro-standalone-update+jws",
    alg: "ES256",
    kid: "upd-2026-1",
  });
  assert.equal(Buffer.from(payload, "base64url").toString("utf8"), JSON.stringify(manifest));
  assert.equal(Buffer.from(signature, "base64url").length, 64);
  assert.doesNotMatch(compact, /[=+/\s]/u);
  assert.deepEqual(verifyCompact(publicKey, compact).payload, manifest);
  // A changed payload, another key, a license's type: refused.
  const changed = Buffer.from(JSON.stringify({ ...manifest, version: "0.3.1" })).toString(
    "base64url",
  );
  assert.throws(
    () => verifyCompact(publicKey, `${header}.${changed}.${signature}`),
    /does not verify/u,
  );
  assert.throws(() => verifyCompact(releaseKey().publicKey, compact), /does not verify/u);
  const license = Buffer.from(
    JSON.stringify({ typ: "markiro-standalone-license+jws", alg: "ES256", kid: "upd-2026-1" }),
  ).toString("base64url");
  assert.throws(() => verifyCompact(publicKey, `${license}.${payload}.${signature}`), /header/u);
  for (const [what, key] of [
    ["P-384", generateKeyPairSync("ec", { namedCurve: "secp384r1" }).privateKey],
    ["Ed25519", generateKeyPairSync("ed25519").privateKey],
  ]) {
    assert.throws(() => signCompact(key, "upd-2026-1", manifest), /P-256/u, what);
  }
  assert.throws(() => signCompact(privateKey, "a kid with spaces", manifest), /key id/u);
});

test("signs a prepared release into the folder the customer gets, after checking every byte again", async () => {
  const { root, releaseDir } = await release();
  const { keyPem, publicKey } = releaseKey();
  const outputDir = join(root, "signed");
  const result = await signUpdate({
    releaseDir,
    ...OPTIONS,
    keyPem,
    passphrase: PASSPHRASE,
    kid: "upd-2026-1",
    outputDir,
  });
  assert.equal(result.folder, join(outputDir, updateFolderName(VERSION)));
  assert.deepEqual(
    (await readdir(result.folder)).sort(),
    [INSTALLER, manifestFileName(VERSION)].sort(),
  );
  const compact = (await readFile(join(result.folder, manifestFileName(VERSION)), "utf8")).trim();
  assert.equal(compact, result.compact);
  const { payload } = verifyCompact(publicKey, compact);
  const installer = await readFile(join(result.folder, INSTALLER));
  assert.deepEqual(payload.installer, {
    name: INSTALLER,
    sha256: createHash("sha256").update(installer).digest("hex"),
    sizeBytes: installer.length,
  });
  assert.deepEqual(checkManifest(payload), payload);
  assert.deepEqual([payload.protocol, payload.minProtocol], [3, 1]);
  for (const name of await readdir(result.folder)) {
    assert.doesNotMatch(
      await readFile(join(result.folder, name), "utf8"),
      /PRIVATE KEY|a passphrase only/u,
    );
  }
  // The folder is never written twice.
  await assert.rejects(
    signUpdate({
      releaseDir,
      ...OPTIONS,
      keyPem,
      passphrase: PASSPHRASE,
      kid: "upd-2026-1",
      outputDir,
    }),
    /EEXIST/u,
  );
});

test("a wrong passphrase, a key without one and an installer changed after prepare.mjs are refused, and nothing is written", async () => {
  const { root, releaseDir } = await release();
  const { keyPem, privateKey } = releaseKey();
  const base = { releaseDir, ...OPTIONS, keyPem, passphrase: PASSPHRASE, kid: "upd-2026-1" };
  await assert.rejects(
    signUpdate({ ...base, passphrase: "wrong", outputDir: join(root, "a") }),
    /does not open/u,
  );
  const plain = privateKey.export({ type: "pkcs8", format: "pem" });
  await assert.rejects(
    signUpdate({ ...base, keyPem: plain, outputDir: join(root, "b") }),
    /encrypted PKCS#8/u,
  );
  // Authenticode after prepare.mjs changes the bytes: sign first, then prepare, then this tool.
  await writeFile(join(releaseDir, INSTALLER), "bytes of the installer, signed afterwards");
  await assert.rejects(signUpdate({ ...base, outputDir: join(root, "c") }), /Authenticode first/u);
  for (const dir of ["a", "b", "c"]) {
    await assert.rejects(stat(join(root, dir)), { code: "ENOENT" });
  }
});

test("the owner's tool signs as plan ЛЦ-1's fixtures do: its test key verifies, and its manifest has this shape", async () => {
  const keys = "packages/domain/fixtures/standalone-license";
  const privateJwk = findJwk(
    JSON.parse(await readFile(join(keys, "test-private-keys.json"), "utf8")),
    "test-upd-1",
  );
  const publicJwk = findJwk(
    JSON.parse(await readFile(join(keys, "test-keyset.json"), "utf8")).update,
    "test-upd-1",
  );
  const privateKey = createPrivateKey({
    key: {
      kty: privateJwk.kty,
      crv: privateJwk.crv,
      x: privateJwk.x,
      y: privateJwk.y,
      d: privateJwk.d,
    },
    format: "jwk",
  });
  const publicKey = createPublicKey({
    key: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y },
    format: "jwk",
  });
  const manifest = buildManifest(DRAFT, OPTIONS);
  assert.deepEqual(
    verifyCompact(publicKey, signCompact(privateKey, "test-upd-1", manifest)).payload,
    manifest,
  );
  const fixture = verifyCompact(
    publicKey,
    (await readFile(join(keys, "update-manifest.jws"), "utf8")).trim(),
  );
  assert.deepEqual(fixture.header, {
    typ: "markiro-standalone-update+jws",
    alg: "ES256",
    kid: "test-upd-1",
  });
  assert.deepEqual(checkManifest(fixture.payload), fixture.payload);
});

/** Inputs of the command line: a release, an encrypted key and notes, all outside the repository. */
async function cliInputs() {
  const { root, releaseDir } = await release();
  const key = join(root, "release-key.pem");
  await writeFile(key, releaseKey().keyPem);
  const notes = join(root, "notes.txt");
  await writeFile(notes, "Строка заметок\n");
  return { root, releaseDir, key, notes };
}

function cliArgs({ releaseDir, key, notes, out }) {
  return [
    SIGN,
    "--release-dir",
    releaseDir,
    "--notes",
    notes,
    "--min-upgrade-from",
    "0.1.0",
    "--channel",
    "stable",
    "--key",
    key,
    "--kid",
    "upd-2026-1",
    "--output-dir",
    out,
  ];
}

test("the command line reads the passphrase from a terminal only, and keeps the key and the result out of the repository", async () => {
  const inputs = await cliInputs();
  const out = join(inputs.root, "signed");
  const piped = spawnSync(process.execPath, cliArgs({ ...inputs, out }), {
    encoding: "utf8",
    input: `${PASSPHRASE}\n`,
  });
  assert.notEqual(piped.status, 0);
  assert.match(piped.stderr, /terminal only/u);
  assert.equal(piped.stdout, "");
  await assert.rejects(stat(out), { code: "ENOENT" });
  const inside = spawnSync(process.execPath, cliArgs({ ...inputs, key: SIGN, out }), {
    encoding: "utf8",
  });
  assert.notEqual(inside.status, 0);
  assert.match(inside.stderr, /release key must live outside the repository/u);
  const here = join(import.meta.dirname, "signed-here");
  const intoRepository = spawnSync(process.execPath, cliArgs({ ...inputs, out: here }), {
    encoding: "utf8",
  });
  assert.notEqual(intoRepository.status, 0);
  assert.match(intoRepository.stderr, /signed update must live outside the repository/u);
  await assert.rejects(stat(here), { code: "ENOENT" });
  const unknown = spawnSync(process.execPath, [SIGN, "--passphrase", "x"], { encoding: "utf8" });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /passphrase/u);
});

test("importing the module runs nothing, and CI never signs", async () => {
  const run = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(`file://${SIGN}`)})`],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "");
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  assert.doesNotMatch(
    workflow,
    /sign-update|generate-update-fixtures|update-key|STANDALONE_UPDATE/u,
  );
});
