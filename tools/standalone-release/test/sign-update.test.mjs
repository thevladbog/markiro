import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { findJwk } from "../generate-update-fixtures.mjs";
import { prepareStandaloneRelease } from "../prepare.mjs";
import {
  MAX_NOTE_CHARS,
  assertOutsideRepository,
  buildManifest,
  checkManifest,
  compareVersions,
  manifestFileName,
  parseNotes,
  readPassphrase,
  readReleaseKeyset,
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

/** A release keyset that lists `publicKey` under `kid`, as `trust-keys.json` would. */
function keysetOf(publicKey, kid = "upd-2026-1", retiredKids = []) {
  const { kty, crv, x, y } = publicKey.export({ format: "jwk" });
  return { keys: [{ kid, jwk: { kty, crv, x, y } }], retiredKids };
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
    "a\u202eb",
    "a\u2066b",
    "a\u0085b",
    "a\u2028b",
    "a\u007fb",
    // 101 characters, 202 UTF-16 units: the length Rust and Zod count.
    "😀".repeat(101),
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
    ["ten digits", { ...OPTIONS, minUpgradeFrom: "0.0.1234567890" }, /not a version/u],
  ]) {
    assert.throws(() => buildManifest(DRAFT, options), expected, what);
  }
  for (const [what, draft] of [
    ["an extra key", { ...DRAFT, channel: "stable" }],
    ["another installer name", { ...DRAFT, installer: { ...DRAFT.installer, name: "setup.exe" } }],
    ["a range upside down", { ...DRAFT, minProtocol: 5 }],
    ["another product", { ...DRAFT, product: "station" }],
    ["a short hash", { ...DRAFT, installer: { ...DRAFT.installer, sha256: "c".repeat(63) } }],
    ["a protocol past u32", { ...DRAFT, protocol: 2 ** 32 }],
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
    keyset: keysetOf(publicKey),
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
      keyset: keysetOf(publicKey),
    }),
    /EEXIST/u,
  );
  // Nothing but the folder is left behind: no partial copy.
  assert.deepEqual(await readdir(outputDir), [updateFolderName(VERSION)]);
});

test("a key the build does not list under its id, or a retired one, signs nothing", async () => {
  const { root, releaseDir } = await release();
  const { keyPem, publicKey } = releaseKey();
  const base = { releaseDir, ...OPTIONS, keyPem, passphrase: PASSPHRASE, kid: "upd-2026-1" };
  for (const [what, keyset, expected] of [
    ["an empty keyset", { keys: [], retiredKids: [] }, /not a release key of this build/u],
    ["another kid", keysetOf(publicKey, "upd-2026-2"), /not a release key of this build/u],
    ["retired", keysetOf(publicKey, "upd-2026-1", ["upd-2026-1"]), /not a release key/u],
    ["another key under the kid", keysetOf(releaseKey().publicKey), /not the public key/u],
    [
      "the kid twice",
      { keys: [...keysetOf(publicKey).keys, ...keysetOf(publicKey).keys], retiredKids: [] },
      /not a release key/u,
    ],
  ]) {
    const outputDir = join(root, what);
    await assert.rejects(signUpdate({ ...base, keyset, outputDir }), expected, what);
    await assert.rejects(stat(outputDir), { code: "ENOENT" }, what);
  }
  // The build's own keyset is the one the command line reads; today it lists no key.
  const built = await readReleaseKeyset();
  assert.ok(Array.isArray(built.keys) && Array.isArray(built.retiredKids));
});

test("a key file with a plain key beside the encrypted one is refused", async () => {
  const { root, releaseDir } = await release();
  const { keyPem, privateKey, publicKey } = releaseKey();
  const plain = privateKey.export({ type: "pkcs8", format: "pem" });
  for (const [what, pem] of [
    ["plain first", `${plain}${keyPem}`],
    ["plain after", `${keyPem}${plain}`],
    ["text around", `note\n${keyPem}`],
  ]) {
    await assert.rejects(
      signUpdate({
        releaseDir,
        ...OPTIONS,
        keyPem: pem,
        passphrase: "wrong",
        kid: "upd-2026-1",
        outputDir: join(root, what),
        keyset: keysetOf(publicKey),
      }),
      /encrypted PKCS#8/u,
      what,
    );
  }
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

test("the manifest's own check refuses each field that is not the spec's", () => {
  const good = buildManifest(DRAFT, OPTIONS);
  assert.deepEqual(checkManifest(good), good);
  for (const [what, change] of Object.entries({
    "v 2": (m) => (m.v = 2),
    "another product": (m) => (m.product = "station"),
    "a ten-digit version": (m) => (m.version = "1234567890.0.0"),
    "a channel": (m) => (m.channel = "nightly"),
    "a date": (m) => (m.releasedAt = "2026-11-02"),
    "a short commit": (m) => (m.sourceSha = "b".repeat(39)),
    "an upper-case commit": (m) => (m.sourceSha = "B".repeat(40)),
    "another installer name": (m) => (m.installer.name = "setup.exe"),
    "an upper-case hash": (m) => (m.installer.sha256 = "C".repeat(64)),
    "an empty installer": (m) => (m.installer.sizeBytes = 0),
    "a fractional size": (m) => (m.installer.sizeBytes = 1.5),
    "a protocol as text": (m) => (m.protocol = "4"),
    "a protocol past u32": (m) => {
      m.protocol = 2 ** 32;
      m.minProtocol = 1;
    },
    "a zero minimum": (m) => (m.minProtocol = 0),
    "a range upside down": (m) => (m.minProtocol = 5),
    "a newer minimum version": (m) => (m.minUpgradeFrom = "0.4.0"),
    "no notes": (m) => (m.notes = []),
    "31 notes": (m) => (m.notes = Array.from({ length: 31 }, (_, index) => `n${index}`)),
    "an empty note": (m) => (m.notes = [""]),
    "an untrimmed note": (m) => (m.notes = [" a"]),
    "a long note": (m) => (m.notes = ["я".repeat(MAX_NOTE_CHARS + 1)]),
    "a note with an override": (m) => (m.notes = ["a\u202eb"]),
    "a note that is no text": (m) => (m.notes = [7]),
    "an extra key": (m) => (m.extra = 1),
    "an extra installer key": (m) => (m.installer.extra = 1),
    "a missing key": (m) => delete m.notes,
  })) {
    const manifest = structuredClone(good);
    change(manifest);
    assert.throws(() => checkManifest(manifest), /shape/u, what);
  }
});

test("a compact JWS with an empty part or a kid of another form is not verified", () => {
  const { privateKey, publicKey } = releaseKey();
  const compact = signCompact(privateKey, "upd-2026-1", buildManifest(DRAFT, OPTIONS));
  const [header, payload, signature] = compact.split(".");
  for (const broken of [
    `${header}..${signature}`,
    `${header}.${payload}.`,
    `.${payload}.${signature}`,
  ]) {
    assert.throws(() => verifyCompact(publicKey, broken), /compact JWS/u);
  }
  const spaced = Buffer.from(
    JSON.stringify({ typ: "markiro-standalone-update+jws", alg: "ES256", kid: "a kid" }),
  ).toString("base64url");
  assert.throws(() => verifyCompact(publicKey, `${spaced}.${payload}.${signature}`), /header/u);
  assert.throws(
    () => verifyCompact(publicKey, `${header}.${payload}.${signature}=`),
    /canonical|compact/u,
  );
});

test("a path is outside the repository only when no link and no Git work tree brings it in", async () => {
  const root = await mkdtemp(join(tmpdir(), "standalone-outside-"));
  const repository = join(root, "repo");
  await mkdir(join(repository, "inner"), { recursive: true });
  const outside = join(root, "outside");
  await mkdir(outside);
  assert.equal(
    await assertOutsideRepository(join(outside, "new", "deeper"), "x", repository),
    join(await realpath(outside), "new", "deeper"),
  );
  await assert.rejects(
    assertOutsideRepository(join(repository, "inner"), "x", repository),
    /outside/u,
  );
  await assert.rejects(
    assertOutsideRepository(join(repository, "missing"), "x", repository),
    /outside/u,
  );
  // A link to the repository among the ancestors of a folder not made yet.
  await symlink(repository, join(root, "link"));
  await assert.rejects(
    assertOutsideRepository(join(root, "link", "new", "out"), "the signed update", repository),
    /the signed update must live outside the repository/u,
  );
  // Another Git work tree above the path (the main checkout above a worktree).
  const checkout = join(root, "checkout");
  await mkdir(join(checkout, ".git"), { recursive: true });
  await mkdir(join(checkout, "keys"));
  await assert.rejects(
    assertOutsideRepository(join(checkout, "keys", "release.pem"), "the release key", repository),
    /the release key must live outside the repository/u,
  );
});

/** A terminal for `readPassphrase`: records raw mode and takes typed chunks. */
function fakeTerminal() {
  const input = new EventEmitter();
  input.isTTY = true;
  input.raw = [];
  input.setRawMode = (on) => input.raw.push(on);
  input.resume = () => {};
  input.pause = () => {};
  input.setEncoding = () => {};
  const written = [];
  const output = { write: (text) => written.push(text) };
  return { input, output, written };
}

test("the passphrase is typed on a terminal, not echoed, and raw mode is always restored", async () => {
  const typed = fakeTerminal();
  const reading = readPassphrase("Фраза: ", typed.input, typed.output);
  typed.input.emit("data", "ab");
  typed.input.emit("data", "x\u007fc\r");
  assert.equal(await reading, "abc");
  assert.deepEqual(typed.input.raw, [true, false]);
  assert.deepEqual(typed.written, ["Фраза: ", "\n"]);
  assert.equal(typed.input.listenerCount("data"), 0);
  const cancelled = fakeTerminal();
  const refused = readPassphrase("Фраза: ", cancelled.input, cancelled.output);
  cancelled.input.emit("data", "ab\u0003");
  await assert.rejects(refused, /cancelled/u);
  assert.deepEqual(cancelled.input.raw, [true, false]);
  const piped = fakeTerminal();
  piped.input.isTTY = false;
  await assert.rejects(readPassphrase("Фраза: ", piped.input, piped.output), /terminal only/u);
  const noRaw = fakeTerminal();
  noRaw.input.setRawMode = undefined;
  await assert.rejects(readPassphrase("Фраза: ", noRaw.input, noRaw.output), /terminal only/u);
  assert.deepEqual(piped.written, []);
});
