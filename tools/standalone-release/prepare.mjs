// The installer of «Markiro Автоном» as a self-verifying artifact (plan УСТ):
// the NSIS installer under a stable name, `release-evidence.json` (version,
// source commit, roles, hash and size, Authenticode status), the unsigned
// draft of its update manifest (plan ОБН-2, spec §10.3) and `SHA256SUMS`.
// The `standalone-windows-build` job runs it after the installer's smoke test
// and uploads the directory; nothing is published anywhere else. The draft
// holds what the build knows — the version, the commit, the installer and the
// protocol range of `apps/standalone/proto/src/lib.rs` — and the owner adds
// the channel, the date, `minUpgradeFrom` and the notes and signs it on their
// own machine (`sign-update.mjs`). No key reaches CI.
//
//   node tools/standalone-release/prepare.mjs --bundle-dir <nsis dir> --output-dir <dir> \
//     --source-repository <owner/repo> --source-sha <40 hex> --authenticode <status>

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const STANDALONE_TAURI_CONFIG = "apps/standalone/src-tauri/tauri.conf.json";
/** The wire crate the host and the app share: its protocol range goes into the draft. */
export const STANDALONE_PROTO_LIB = "apps/standalone/proto/src/lib.rs";
export const EVIDENCE_FILE = "release-evidence.json";
export const CHECKSUM_FILE = "SHA256SUMS";
/** The product an update manifest names (`markiro_proto::update::PRODUCT`). */
export const UPDATE_PRODUCT = "markiro-standalone";
/** The installer's roles (`src-tauri/windows/installer-hooks.nsh`). */
export const ROLES = Object.freeze(["host", "station", "office"]);
/** `Get-AuthenticodeSignature`'s status for a signed and for an unsigned file. */
export const AUTHENTICODE_STATUSES = Object.freeze(["Valid", "NotSigned"]);

// At most 9 digits a part: the update manifest's versions are read so (`markiro_proto::trust`).
const VERSION = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;

export function standaloneInstallerName(version) {
  if (!VERSION.test(version ?? "")) throw new Error(`${String(version)} is not a version`);
  return `markiro-standalone-${version}-windows-x86_64-setup.exe`;
}

/** The draft beside the installer: `markiro-standalone-<version>.update-draft.json`. */
export function updateDraftName(version) {
  standaloneInstallerName(version);
  return `markiro-standalone-${version}.update-draft.json`;
}

/** The single source of the version: the app's Tauri config. */
export async function readStandaloneVersion(configPath = STANDALONE_TAURI_CONFIG) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (!VERSION.test(config?.version ?? "")) {
    throw new Error(`${configPath} has no usable version`);
  }
  return config.version;
}

function validateProtocolRange(range) {
  const { protocol, minProtocol } = range ?? {};
  if (
    !Number.isSafeInteger(protocol) ||
    !Number.isSafeInteger(minProtocol) ||
    minProtocol < 1 ||
    minProtocol > protocol ||
    protocol > 4_294_967_295
  ) {
    throw new Error("the protocol range is invalid: 1 <= minProtocol <= protocol");
  }
}

/** `PROTOCOL_VERSION` and `MIN_PROTOCOL_VERSION` of this build, read from the wire crate's source. */
export async function readProtocolRange(path = STANDALONE_PROTO_LIB) {
  const source = (await readFile(path, "utf8")).replaceAll("\r\n", "\n");
  const constant = (name) => {
    const match = new RegExp(`^pub const ${name}: u32 = ([0-9]+);$`, "mu").exec(source);
    if (match === null) throw new Error(`${path} has no ${name}`);
    return Number(match[1]);
  };
  const range = {
    protocol: constant("PROTOCOL_VERSION"),
    minProtocol: constant("MIN_PROTOCOL_VERSION"),
  };
  validateProtocolRange(range);
  return range;
}

/**
 * The unsigned manifest draft (spec §10.2, §10.3): exactly what the build
 * knows, in the order the signed manifest keeps it.
 */
export function buildUpdateDraft({
  version,
  sourceSha,
  name,
  sha256,
  size,
  protocol,
  minProtocol,
}) {
  return {
    v: 1,
    product: UPDATE_PRODUCT,
    version,
    sourceSha,
    installer: { name, sha256, sizeBytes: size },
    protocol,
    minProtocol,
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateSource(repository, sha) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) {
    throw new Error("source repository is invalid");
  }
  if (!/^[a-f0-9]{40}$/.test(sha ?? "")) {
    throw new Error("source SHA must be a full lowercase Git commit SHA");
  }
}

function readDraft(bytes) {
  try {
    const draft = JSON.parse(bytes.toString("utf8"));
    validateProtocolRange(draft);
    return draft;
  } catch {
    throw new Error("prepared standalone update draft is invalid");
  }
}

export async function prepareStandaloneRelease({
  version,
  sourceRepository,
  sourceSha,
  bundleDir,
  outputDir,
  authenticode,
  protocol,
  minProtocol,
}) {
  validateSource(sourceRepository, sourceSha);
  const name = standaloneInstallerName(version);
  validateProtocolRange({ protocol, minProtocol });
  if (!AUTHENTICODE_STATUSES.includes(authenticode)) {
    throw new Error(`Authenticode status ${String(authenticode)} is neither signed nor unsigned`);
  }
  const installers = (await readdir(bundleDir)).filter((name) => name.endsWith("-setup.exe"));
  if (installers.length !== 1) {
    throw new Error(`expected exactly one NSIS installer in ${bundleDir}`);
  }
  await mkdir(outputDir, { recursive: true });
  if ((await readdir(outputDir)).length !== 0) {
    throw new Error(`prepared release directory is not empty: ${outputDir}`);
  }
  const bytes = await readFile(join(bundleDir, installers[0]));
  await writeFile(join(outputDir, name), bytes);
  const hash = sha256(bytes);
  const evidence = {
    schemaVersion: 1,
    product: "standalone",
    version,
    source: { repository: sourceRepository, sha: sourceSha },
    roles: [...ROLES],
    authenticode,
    assets: { [name]: { sha256: hash, size: bytes.length } },
  };
  const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  await writeFile(join(outputDir, EVIDENCE_FILE), evidenceBytes);
  const draftName = updateDraftName(version);
  const draft = buildUpdateDraft({
    version,
    sourceSha,
    name,
    sha256: hash,
    size: bytes.length,
    protocol,
    minProtocol,
  });
  const draftBytes = Buffer.from(`${JSON.stringify(draft, null, 2)}\n`, "utf8");
  await writeFile(join(outputDir, draftName), draftBytes);
  const sums = [
    [EVIDENCE_FILE, sha256(evidenceBytes)],
    [name, hash],
    [draftName, sha256(draftBytes)],
  ]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, hash]) => `${hash}  ${file}\n`)
    .join("");
  await writeFile(join(outputDir, CHECKSUM_FILE), sums, "utf8");
  return verifyPreparedStandaloneRelease({ directory: outputDir, version });
}

export async function verifyPreparedStandaloneRelease({ directory, version }) {
  const name = standaloneInstallerName(version);
  const draftName = updateDraftName(version);
  const expected = [CHECKSUM_FILE, EVIDENCE_FILE, name, draftName].sort();
  const entries = (await readdir(directory)).sort();
  if (entries.join("\n") !== expected.join("\n")) {
    throw new Error("prepared standalone release has an unexpected asset set");
  }
  const bytes = Object.fromEntries(
    await Promise.all(
      entries.map(async (entry) => [entry, await readFile(join(directory, entry))]),
    ),
  );
  const evidence = JSON.parse(bytes[EVIDENCE_FILE].toString("utf8"));
  if (
    evidence?.schemaVersion !== 1 ||
    evidence?.product !== "standalone" ||
    evidence?.version !== version ||
    JSON.stringify(evidence?.roles) !== JSON.stringify(ROLES) ||
    !AUTHENTICODE_STATUSES.includes(evidence?.authenticode)
  ) {
    throw new Error("prepared standalone release evidence is invalid");
  }
  validateSource(evidence.source?.repository, evidence.source?.sha);
  const asset = evidence.assets?.[name];
  if (
    Object.keys(evidence.assets ?? {}).length !== 1 ||
    asset?.sha256 !== sha256(bytes[name]) ||
    asset?.size !== bytes[name].length
  ) {
    throw new Error(`prepared standalone release checksum mismatch: ${name}`);
  }
  const lines = bytes[CHECKSUM_FILE].toString("utf8").trim().split("\n");
  const sums = new Map();
  for (const line of lines) {
    const match = /^([a-f0-9]{64}) {2}([^/\\]+)$/.exec(line);
    if (!match || sums.has(match[2])) throw new Error("prepared standalone SHA256SUMS is invalid");
    sums.set(match[2], match[1]);
  }
  if ([...sums.keys()].sort().join("\n") !== [EVIDENCE_FILE, name, draftName].sort().join("\n")) {
    throw new Error("prepared standalone SHA256SUMS names unexpected assets");
  }
  for (const [file, hash] of sums) {
    if (sha256(bytes[file]) !== hash) {
      throw new Error(`prepared standalone release checksum mismatch: ${file}`);
    }
  }
  const draft = readDraft(bytes[draftName]);
  const described = buildUpdateDraft({
    version,
    sourceSha: evidence.source.sha,
    name,
    sha256: asset.sha256,
    size: asset.size,
    protocol: draft.protocol,
    minProtocol: draft.minProtocol,
  });
  if (JSON.stringify(draft) !== JSON.stringify(described)) {
    throw new Error("prepared standalone update draft is invalid");
  }
  return { directory, name, evidence, draft, draftName };
}

async function main() {
  const { values } = parseArgs({
    options: {
      "bundle-dir": { type: "string" },
      "output-dir": { type: "string" },
      "source-repository": { type: "string" },
      "source-sha": { type: "string" },
      authenticode: { type: "string" },
    },
    strict: true,
  });
  const prepared = await prepareStandaloneRelease({
    version: await readStandaloneVersion(),
    sourceRepository: values["source-repository"],
    sourceSha: values["source-sha"],
    bundleDir: values["bundle-dir"],
    outputDir: values["output-dir"],
    authenticode: values.authenticode,
    ...(await readProtocolRange()),
  });
  process.stdout.write(
    `${prepared.name} ${prepared.evidence.assets[prepared.name].sha256} (${prepared.evidence.authenticode})\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
