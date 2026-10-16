// An update of «Markiro Автоном», signed on the owner's machine (plan ОБН-2,
// spec §5.1, §10.2, §10.3, §10.9):
//
//   node tools/standalone-release/sign-update.mjs --release-dir <prepared dir> \
//     [--notes <notes.txt>] --min-upgrade-from <X.Y.Z> --channel <stable|beta> \
//     --key <encrypted PKCS#8 PEM outside the repository> --kid <kid> \
//     --output-dir <dir outside the repository> [--released-at <YYYY-MM-DDTHH:MM:SSZ>]
//
// `--release-dir` is what prepare.mjs wrote (the CI artifact): the installer,
// release-evidence.json, the manifest draft and SHA256SUMS. All of it is
// checked again from the bytes — the installer's SHA-256 and size against the
// evidence and the sums — before anything is signed. The key's passphrase is
// asked on the terminal only: never an argument, never the environment. The
// result is `<output>/markiro-standalone-<version>-update/` with the
// installer and `markiro-standalone-<version>.update.jws`, one line of compact
// JWS ES256 (`typ` markiro-standalone-update+jws): the folder the owner hands
// to the customer.
//
// `--notes` is optional. Without it the tool reads `notes.draft.txt` from the
// release directory (the draft CI generates from the Git history,
// draft-notes.mjs), checks it like any notes file, prints it to stderr and
// signs it only after `y` is typed on the terminal: notes end up in the
// signed manifest and the customer reads them. An explicit `--notes` file is
// read as it always was, with no confirmation (the owner wrote it).
//
// Authenticode changes the installer's bytes, so with a code-signing
// certificate the order is: the build signed (sign-overlay.mjs), prepare.mjs
// on that installer, then this tool. An installer signed after prepare.mjs no
// longer matches its evidence and is refused. The release key never reaches
// CI or the SaaS panel.

import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  EVIDENCE_FILE,
  NOTES_DRAFT_FILE,
  UPDATE_PRODUCT,
  standaloneInstallerName,
  verifyPreparedStandaloneRelease,
} from "./prepare.mjs";

export const UPDATE_TYP = "markiro-standalone-update+jws";
export const CHANNELS = Object.freeze(["stable", "beta"]);
export const MAX_NOTES = 30;
export const MAX_NOTE_CHARS = 200;
export const REPOSITORY_ROOT = resolve(import.meta.dirname, "..", "..");
/** The keysets the standalone build trusts (`markiro_proto::trust`): `update` holds the release keys. */
export const BUILD_KEYSETS = join(
  REPOSITORY_ROOT,
  "apps/standalone/proto/fixtures/trust-keys.json",
);
/** The largest protocol number: `u32` in `markiro_proto`, `max(4_294_967_295)` in the domain. */
const MAX_PROTOCOL = 4_294_967_295;

const MANIFEST_KEYS = Object.freeze([
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
const DRAFT_KEYS = Object.freeze([
  "v",
  "product",
  "version",
  "sourceSha",
  "installer",
  "protocol",
  "minProtocol",
]);
const INSTALLER_KEYS = Object.freeze(["name", "sha256", "sizeBytes"]);
// At most 9 digits a part, as `markiro_proto::trust` and the domain read a manifest's versions.
const VERSION = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/u;
const INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/u;
const KID = /^[A-Za-z0-9._-]{1,64}$/u;
/**
 * Plain text as `markiro_proto::trust` (`is_plain_text`) and the domain
 * (`isPlainText`) read it: no C0 or C1 control, no line or paragraph
 * separator, no bidirectional override or isolate (a note is shown to the
 * customer, and an override could disguise it). No regex: no-control-regex.
 */
export const hasControl = (text) =>
  [...text].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    );
  });

export function manifestFileName(version) {
  standaloneInstallerName(version);
  return `markiro-standalone-${version}.update.jws`;
}

export function updateFolderName(version) {
  standaloneInstallerName(version);
  return `markiro-standalone-${version}-update`;
}

/** -1, 0 or 1 for two versions `X.Y.Z`, compared as numbers. */
export function compareVersions(left, right) {
  const parts = (text) => {
    const match = VERSION.exec(text ?? "");
    if (match === null) throw new Error(`${String(text)} is not a version`);
    return match.slice(1).map(Number);
  };
  const [a, b] = [parts(left), parts(right)];
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

/**
 * The notes file: 1-30 non-empty lines, each trimmed, at most 200 UTF-16
 * units (the length Rust's `utf16_len` and Zod's `.max` count), plain text.
 */
export function parseNotes(text) {
  const lines = String(text)
    .replace(/^\uFEFF/u, "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length === 0 || lines.length > MAX_NOTES) {
    throw new Error(`the notes hold 1-${MAX_NOTES} lines`);
  }
  for (const line of lines) {
    if (line.length > MAX_NOTE_CHARS) {
      throw new Error(`a line of the notes is longer than ${MAX_NOTE_CHARS} characters`);
    }
    if (hasControl(line)) throw new Error("the notes hold a control character");
  }
  return lines;
}

/**
 * The notes to sign: the `notesPath` file as given, or, without one, the
 * draft beside the installer, shown and signed only after `y` on a terminal.
 */
export async function resolveNotes({
  releaseDir,
  notesPath,
  input = process.stdin,
  output = process.stderr,
}) {
  if (notesPath !== undefined) return parseNotes(await readFile(notesPath, "utf8"));
  let draft;
  try {
    draft = await readFile(join(releaseDir, NOTES_DRAFT_FILE), "utf8");
  } catch (error) {
    throw new Error(
      `--notes is required: ${releaseDir} holds no ${NOTES_DRAFT_FILE} to sign instead`,
      { cause: error },
    );
  }
  const notes = parseNotes(draft);
  if (!input.isTTY) throw new Error("the draft notes are confirmed on a terminal only");
  output.write(
    `Заметки к выпуску из ${NOTES_DRAFT_FILE} (они попадут в подписанный манифест):\n${notes.join("\n")}\n`,
  );
  const reader = createInterface({ input, output, terminal: false });
  let answer;
  try {
    answer = await reader.question("Подписать эти заметки? Введите y для подтверждения: ");
  } finally {
    reader.close();
  }
  if (answer.trim().toLowerCase() !== "y") {
    throw new Error("the draft notes were not confirmed (type y to sign them)");
  }
  return notes;
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

/** `manifest` when it has exactly the shape of spec §10.2; throws otherwise. */
export function checkManifest(manifest) {
  const m = manifest;
  const ok =
    exactKeys(m, MANIFEST_KEYS) &&
    m.v === 1 &&
    m.product === UPDATE_PRODUCT &&
    VERSION.test(m.version ?? "") &&
    CHANNELS.includes(m.channel) &&
    INSTANT.test(m.releasedAt ?? "") &&
    /^[0-9a-f]{40}$/u.test(m.sourceSha ?? "") &&
    exactKeys(m.installer, INSTALLER_KEYS) &&
    m.installer.name === standaloneInstallerName(m.version) &&
    /^[0-9a-f]{64}$/u.test(m.installer.sha256 ?? "") &&
    Number.isSafeInteger(m.installer.sizeBytes) &&
    m.installer.sizeBytes > 0 &&
    Number.isSafeInteger(m.protocol) &&
    Number.isSafeInteger(m.minProtocol) &&
    m.minProtocol >= 1 &&
    m.minProtocol <= m.protocol &&
    m.protocol <= MAX_PROTOCOL &&
    VERSION.test(m.minUpgradeFrom ?? "") &&
    compareVersions(m.minUpgradeFrom, m.version) <= 0 &&
    Array.isArray(m.notes) &&
    m.notes.length >= 1 &&
    m.notes.length <= MAX_NOTES &&
    m.notes.every(
      (note) =>
        typeof note === "string" &&
        note !== "" &&
        note.trim() === note &&
        note.length <= MAX_NOTE_CHARS &&
        !hasControl(note),
    );
  if (!ok)
    throw new Error("the manifest does not have the shape of a markiro-standalone update v1");
  return manifest;
}

/** The manifest of spec §10.2: prepare.mjs's draft and what the owner adds. */
export function buildManifest(draft, { channel, releasedAt, minUpgradeFrom, notes }) {
  if (!exactKeys(draft, DRAFT_KEYS) || !exactKeys(draft.installer, INSTALLER_KEYS)) {
    throw new Error("the manifest draft is not what prepare.mjs writes");
  }
  if (!CHANNELS.includes(channel)) throw new Error("the channel is stable or beta");
  if (!INSTANT.test(releasedAt ?? "")) {
    throw new Error("the release time is YYYY-MM-DDTHH:MM:SSZ (UTC, no fractions)");
  }
  if (compareVersions(minUpgradeFrom, draft.version) > 0) {
    throw new Error("minUpgradeFrom must not be newer than the version itself");
  }
  return checkManifest({
    v: draft.v,
    product: draft.product,
    version: draft.version,
    channel,
    releasedAt,
    sourceSha: draft.sourceSha,
    installer: {
      name: draft.installer.name,
      sha256: draft.installer.sha256,
      sizeBytes: draft.installer.sizeBytes,
    },
    protocol: draft.protocol,
    minProtocol: draft.minProtocol,
    minUpgradeFrom,
    notes: [...notes],
  });
}

const base64url = (bytes) => Buffer.from(bytes).toString("base64url");

/** A compact JWS ES256 of `payload`: the exact bytes `header.payload` are signed, no JSON canonicalization. */
export function signCompact(privateKey, kid, payload) {
  if (
    privateKey?.type !== "private" ||
    privateKey.asymmetricKeyType !== "ec" ||
    privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  ) {
    throw new Error("the release key must be an ECDSA P-256 private key");
  }
  if (!KID.test(kid ?? "")) {
    throw new Error("the key id is 1-64 letters, digits, dots, dashes or underscores");
  }
  const input = `${base64url(JSON.stringify({ typ: UPDATE_TYP, alg: "ES256", kid }))}.${base64url(JSON.stringify(payload))}`;
  const signature = sign("sha256", Buffer.from(input, "ascii"), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${input}.${base64url(signature)}`;
}

/** The header and the payload of `compact` when `publicKey` verifies it as an update manifest; throws otherwise. */
export function verifyCompact(publicKey, compact) {
  const parts = String(compact).split(".");
  if (parts.length !== 3 || parts.some((part) => part === "")) {
    throw new Error("not a compact JWS");
  }
  const decode = (segment) => {
    const bytes = Buffer.from(segment, "base64url");
    if (base64url(bytes) !== segment) throw new Error("not canonical base64url");
    return bytes;
  };
  const [header, payload, signature] = parts.map(decode);
  const parsed = JSON.parse(header.toString("utf8"));
  if (
    !exactKeys(parsed, ["typ", "alg", "kid"]) ||
    parsed.typ !== UPDATE_TYP ||
    parsed.alg !== "ES256" ||
    !KID.test(parsed.kid ?? "")
  ) {
    throw new Error("not an update manifest's header");
  }
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`, "ascii");
  if (
    signature.length !== 64 ||
    !verify("sha256", signed, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature)
  ) {
    throw new Error("the signature does not verify");
  }
  return { header: parsed, payload: JSON.parse(payload.toString("utf8")) };
}

/**
 * `path` resolved when it lies outside the repository; throws when it is
 * inside. A path that does not exist yet (an output folder) is resolved
 * through its nearest existing ancestor, so a link among its ancestors
 * counts; and a path under any Git work tree (a `.git` entry in one of its
 * resolved ancestors: the main checkout above a worktree) is inside too.
 */
export async function assertOutsideRepository(path, what, root = REPOSITORY_ROOT) {
  let existing = resolve(path);
  const missing = [];
  let real;
  for (;;) {
    try {
      real = await realpath(existing);
      break;
    } catch (error) {
      if (error?.code !== "ENOENT" || dirname(existing) === existing) throw error;
      missing.unshift(basename(existing));
      existing = dirname(existing);
    }
  }
  const target = join(real, ...missing);
  const inside = (base) => {
    const rel = relative(base, target);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  };
  let underGit = false;
  for (let dir = real; ; dir = dirname(dir)) {
    try {
      await lstat(join(dir, ".git"));
      underGit = true;
      break;
    } catch {
      // No `.git` here: look further up.
    }
    if (dirname(dir) === dir) break;
  }
  if (underGit || inside(root) || inside(await realpath(root))) {
    throw new Error(`${what} must live outside the repository`);
  }
  return target;
}

/**
 * The release keyset of the build (`update` of `apps/standalone/proto/fixtures/trust-keys.json`):
 * a package signed with a key that is not there would be refused on every site.
 */
export async function readReleaseKeyset(path = BUILD_KEYSETS) {
  const keysets = JSON.parse(await readFile(path, "utf8"));
  const update = keysets?.update;
  if (!Array.isArray(update?.keys) || !Array.isArray(update?.retiredKids)) {
    throw new Error(`${path} has no update keyset`);
  }
  return update;
}

/** Refuses `kid` and `publicKey` unless the keyset lists exactly that key under that kid, not retired. */
function checkKeyInKeyset(keyset, kid, publicKey) {
  const listed = keyset.keys.filter((key) => key?.kid === kid);
  if (listed.length !== 1 || keyset.retiredKids.includes(kid)) {
    throw new Error(
      `the key id ${kid} is not a release key of this build: add its public key to apps/standalone/proto/fixtures/trust-keys.json first (spec §5.3)`,
    );
  }
  const own = publicKey.export({ format: "jwk" });
  const jwk = listed[0].jwk ?? {};
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || jwk.x !== own.x || jwk.y !== own.y) {
    throw new Error(`the release key is not the public key the build lists under ${kid}`);
  }
}

/** The passphrase typed on the terminal, not echoed. Anything but a terminal is refused. */
export async function readPassphrase(prompt, input = process.stdin, output = process.stderr) {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("the passphrase is read from a terminal only");
  }
  output.write(prompt);
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  return await new Promise((resolvePassphrase, reject) => {
    let typed = "";
    const finish = (error) => {
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
      output.write("\n");
      if (error === null) resolvePassphrase(typed);
      else reject(error);
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return finish(null);
        if (char === "\u0003" || char === "\u0004") return finish(new Error("cancelled"));
        if (char === "\u007f" || char === "\b") typed = typed.slice(0, -1);
        else typed += char;
      }
      return undefined;
    };
    input.on("data", onData);
  });
}

/**
 * The release at `releaseDir` checked again from its bytes and the manifest
 * the owner's options make of its draft; nothing is signed yet.
 */
export async function checkRelease({ releaseDir, notes, minUpgradeFrom, channel, releasedAt }) {
  let evidence;
  try {
    evidence = JSON.parse(await readFile(join(releaseDir, EVIDENCE_FILE), "utf8"));
  } catch (error) {
    throw new Error(
      `${releaseDir} holds no readable ${EVIDENCE_FILE}: is it what prepare.mjs wrote?`,
      {
        cause: error,
      },
    );
  }
  let prepared;
  try {
    prepared = await verifyPreparedStandaloneRelease({
      directory: releaseDir,
      version: evidence?.version,
    });
  } catch (error) {
    throw new Error(
      `${error.message}. The installer must be exactly what prepare.mjs hashed: sign it with Authenticode first, run prepare.mjs on it, then this tool`,
      { cause: error },
    );
  }
  const manifest = buildManifest(prepared.draft, { channel, releasedAt, minUpgradeFrom, notes });
  return { prepared, manifest };
}

/** The PEM must be one encrypted PKCS#8 block and nothing else: a plain block beside it would open without the passphrase. */
function checkEncryptedPem(keyPem) {
  const text = String(keyPem).trim();
  const blocks = text.match(/-----BEGIN [A-Z0-9 ]+-----/gu) ?? [];
  if (
    blocks.length !== 1 ||
    !text.startsWith("-----BEGIN ENCRYPTED PRIVATE KEY-----") ||
    !text.endsWith("-----END ENCRYPTED PRIVATE KEY-----")
  ) {
    throw new Error("the release key must be an encrypted PKCS#8 PEM: a passphrase protects it");
  }
}

/**
 * Signs a prepared release (see the header) with a key `keyset` lists;
 * returns the folder, the compact JWS and the manifest. The folder appears
 * whole or not at all: it is written beside its place and renamed into it.
 */
export async function signUpdate({
  releaseDir,
  notes,
  minUpgradeFrom,
  channel,
  releasedAt,
  keyPem,
  passphrase,
  kid,
  outputDir,
  keyset,
}) {
  const { prepared, manifest } = await checkRelease({
    releaseDir,
    notes,
    minUpgradeFrom,
    channel,
    releasedAt,
  });
  checkEncryptedPem(keyPem);
  let privateKey;
  try {
    privateKey = createPrivateKey({ key: keyPem, format: "pem", passphrase });
  } catch {
    throw new Error("the release key does not open: a wrong passphrase, or not a PKCS#8 key");
  }
  const publicKey = createPublicKey(privateKey);
  if (!KID.test(kid ?? "")) {
    throw new Error("the key id is 1-64 letters, digits, dots, dashes or underscores");
  }
  checkKeyInKeyset(keyset, kid, publicKey);
  const compact = signCompact(privateKey, kid, manifest);
  verifyCompact(publicKey, compact);
  const folder = join(outputDir, updateFolderName(manifest.version));
  await mkdir(outputDir, { recursive: true });
  try {
    await lstat(folder);
    throw Object.assign(new Error(`EEXIST: ${folder} is already there`), { code: "EEXIST" });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const partial = await mkdtemp(join(outputDir, `.${updateFolderName(manifest.version)}.partial-`));
  try {
    await writeFile(join(partial, prepared.name), await readFile(join(releaseDir, prepared.name)), {
      flag: "wx",
    });
    // What the customer gets is read back: it must be what was signed.
    const copied = await readFile(join(partial, prepared.name));
    if (
      copied.length !== manifest.installer.sizeBytes ||
      createHash("sha256").update(copied).digest("hex") !== manifest.installer.sha256
    ) {
      throw new Error("the copied installer does not match the manifest");
    }
    await writeFile(join(partial, manifestFileName(manifest.version)), `${compact}\n`, {
      flag: "wx",
    });
    await rename(partial, folder);
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw error;
  }
  return { folder, compact, manifest };
}

async function main() {
  const { values } = parseArgs({
    options: {
      "release-dir": { type: "string" },
      notes: { type: "string" },
      "min-upgrade-from": { type: "string" },
      channel: { type: "string" },
      "released-at": { type: "string" },
      key: { type: "string" },
      kid: { type: "string" },
      "output-dir": { type: "string" },
    },
    strict: true,
  });
  for (const option of ["release-dir", "min-upgrade-from", "channel", "key", "kid", "output-dir"]) {
    if (values[option] === undefined) throw new Error(`--${option} is required`);
  }
  const keyPath = await assertOutsideRepository(values.key, "the release key");
  await assertOutsideRepository(values["output-dir"], "the signed update");
  const options = {
    releaseDir: values["release-dir"],
    notes: await resolveNotes({
      releaseDir: values["release-dir"],
      notesPath: values.notes,
    }),
    minUpgradeFrom: values["min-upgrade-from"],
    channel: values.channel,
    releasedAt: values["released-at"] ?? new Date().toISOString().replace(/\.[0-9]{3}Z$/u, "Z"),
  };
  const keyPem = await readFile(keyPath, "utf8");
  // Everything that needs no passphrase is checked before it is asked.
  checkEncryptedPem(keyPem);
  await checkRelease(options);
  const keyset = await readReleaseKeyset();
  const passphrase = await readPassphrase("Парольная фраза ключа выпусков: ");
  const result = await signUpdate({
    ...options,
    keyPem,
    passphrase,
    kid: values.kid,
    outputDir: values["output-dir"],
    keyset,
  });
  process.stdout.write(
    `${result.folder}\n${result.manifest.installer.name} ${result.manifest.installer.sha256}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
