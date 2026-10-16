import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  NOTES_DRAFT_FILE,
  prepareStandaloneRelease,
  readProtocolRange,
  readStandaloneVersion,
  standaloneInstallerName,
  updateDraftName,
  verifyPreparedStandaloneRelease,
} from "../prepare.mjs";

const VERSION = "0.1.0";
const INSTALLER = "markiro-standalone-0.1.0-windows-x86_64-setup.exe";
const DRAFT = "markiro-standalone-0.1.0.update-draft.json";
// The protocol range travels with the source in every call below.
const SOURCE = {
  sourceRepository: "thevladbog/markiro",
  sourceSha: "a".repeat(40),
  protocol: 3,
  minProtocol: 1,
};
const byLocale = (left, right) => left.localeCompare(right);

async function bundle(...names) {
  const root = await mkdtemp(join(tmpdir(), "standalone-prepare-"));
  const bundleDir = join(root, "nsis");
  await mkdir(bundleDir);
  for (const name of names) await writeFile(join(bundleDir, name), `bytes of ${name}`);
  return { bundleDir, outputDir: join(root, "prepared") };
}

test("reads the version from the app's own Tauri config", async () => {
  assert.match(await readStandaloneVersion(), /^\d+\.\d+\.\d+$/);
});

test("names the installer by version and refuses anything that is not one", () => {
  assert.equal(standaloneInstallerName(VERSION), INSTALLER);
  for (const bad of ["", "0.1", "v0.1.0", "0.1.0-beta.1", "01.1.0", undefined]) {
    assert.throws(() => standaloneInstallerName(bad), /not a version/);
  }
});

test("prepares the installer, its evidence and checksums, and verifies them", async () => {
  const { bundleDir, outputDir } = await bundle("Markiro Standalone_0.1.0_x64-setup.exe");
  const prepared = await prepareStandaloneRelease({
    version: VERSION,
    ...SOURCE,
    bundleDir,
    outputDir,
    authenticode: "NotSigned",
  });
  assert.deepEqual(
    (await readdir(outputDir)).sort(),
    ["SHA256SUMS", INSTALLER, DRAFT, "release-evidence.json"].sort(),
  );
  assert.deepEqual(prepared.evidence, {
    schemaVersion: 1,
    product: "standalone",
    version: VERSION,
    source: { repository: "thevladbog/markiro", sha: "a".repeat(40) },
    roles: ["host", "station", "office"],
    authenticode: "NotSigned",
    assets: {
      [INSTALLER]: {
        sha256: "07fb0332d384ea8d15c76c2c6a4e176e93345d9f403b1cd17e8b0dd2e4d1ac62",
        size: 47,
      },
    },
  });
  const sums = await readFile(join(outputDir, "SHA256SUMS"), "utf8");
  assert.deepEqual(
    sums
      .trim()
      .split("\n")
      .map((line) => line.slice(66)),
    [INSTALLER, DRAFT, "release-evidence.json"].sort(byLocale),
  );
  // The unsigned draft holds what the build knows, in the manifest's order
  // (spec §10.2, §10.3); the owner adds the rest and signs it elsewhere.
  const draft = JSON.parse(await readFile(join(outputDir, DRAFT), "utf8"));
  assert.deepEqual(draft, {
    v: 1,
    product: "markiro-standalone",
    version: VERSION,
    sourceSha: "a".repeat(40),
    installer: {
      name: INSTALLER,
      sha256: "07fb0332d384ea8d15c76c2c6a4e176e93345d9f403b1cd17e8b0dd2e4d1ac62",
      sizeBytes: 47,
    },
    protocol: 3,
    minProtocol: 1,
  });
  assert.deepEqual(Object.keys(draft), [
    "v",
    "product",
    "version",
    "sourceSha",
    "installer",
    "protocol",
    "minProtocol",
  ]);
  assert.deepEqual(prepared.draft, draft);
  assert.equal(prepared.draftName, DRAFT);
  assert.equal(updateDraftName(VERSION), DRAFT);
  assert.throws(() => updateDraftName("0.1"), /not a version/);
  // At most 9 digits a part, as the app reads a manifest's versions.
  assert.throws(() => updateDraftName("1234567890.0.0"), /not a version/);
  assert.equal(
    updateDraftName("123456789.0.0"),
    "markiro-standalone-123456789.0.0.update-draft.json",
  );
});

test("refuses a bundle with no installer or with two", async () => {
  for (const names of [[], ["a-setup.exe", "b-setup.exe"], ["Markiro Standalone.msi"]]) {
    const { bundleDir, outputDir } = await bundle(...names);
    await assert.rejects(
      prepareStandaloneRelease({
        version: VERSION,
        ...SOURCE,
        bundleDir,
        outputDir,
        authenticode: "NotSigned",
      }),
      /exactly one NSIS installer/,
    );
  }
});

test("refuses an unknown signature status, a short commit and a non-empty output", async () => {
  const { bundleDir, outputDir } = await bundle("x-setup.exe");
  const base = { version: VERSION, ...SOURCE, bundleDir, outputDir, authenticode: "NotSigned" };
  await assert.rejects(
    prepareStandaloneRelease({ ...base, authenticode: "HashMismatch" }),
    /neither signed nor unsigned/,
  );
  await assert.rejects(
    prepareStandaloneRelease({ ...base, sourceSha: "abc123" }),
    /full lowercase/,
  );
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, "left-over"), "");
  await assert.rejects(prepareStandaloneRelease(base), /not empty/);
});

test("rejects changed bytes and an extra file", async () => {
  const { bundleDir, outputDir } = await bundle("x-setup.exe");
  await prepareStandaloneRelease({
    version: VERSION,
    ...SOURCE,
    bundleDir,
    outputDir,
    authenticode: "Valid",
  });
  await writeFile(join(outputDir, INSTALLER), "other bytes of x-setup.exe");
  await assert.rejects(
    verifyPreparedStandaloneRelease({ directory: outputDir, version: VERSION }),
    /checksum mismatch/,
  );
  await writeFile(join(outputDir, INSTALLER), "bytes of x-setup.exe");
  await verifyPreparedStandaloneRelease({ directory: outputDir, version: VERSION });
  await writeFile(join(outputDir, "notes.txt"), "");
  await assert.rejects(
    verifyPreparedStandaloneRelease({ directory: outputDir, version: VERSION }),
    /unexpected asset set/,
  );
});

test("the notes draft CI leaves beside the installer is tolerated, left out of SHA256SUMS and never read", async () => {
  const { bundleDir, outputDir } = await bundle("x-setup.exe");
  await prepareStandaloneRelease({
    version: VERSION,
    ...SOURCE,
    bundleDir,
    outputDir,
    authenticode: "Valid",
  });
  // Any content: the owner edits it, so its bytes are not a contract.
  await writeFile(join(outputDir, NOTES_DRAFT_FILE), "anything\n\u0000 at all");
  const verified = await verifyPreparedStandaloneRelease({
    directory: outputDir,
    version: VERSION,
  });
  assert.equal(verified.name, INSTALLER);
  const sums = await readFile(join(outputDir, "SHA256SUMS"), "utf8");
  assert.doesNotMatch(sums, /notes/u);
  assert.equal(NOTES_DRAFT_FILE, "notes.draft.txt");
});

const sha = (text) => createHash("sha256").update(text).digest("hex");
const PREPARE = join(import.meta.dirname, "..", "prepare.mjs");

async function prepared(authenticode = "NotSigned") {
  const { bundleDir, outputDir } = await bundle("x-setup.exe");
  await prepareStandaloneRelease({
    version: VERSION,
    ...SOURCE,
    bundleDir,
    outputDir,
    authenticode,
  });
  return outputDir;
}

/** Rewrites the evidence and keeps SHA256SUMS consistent with it. */
async function rewriteEvidence(directory, change) {
  const path = join(directory, "release-evidence.json");
  const evidence = JSON.parse(await readFile(path, "utf8"));
  change(evidence);
  const bytes = `${JSON.stringify(evidence, null, 2)}\n`;
  await writeFile(path, bytes);
  const sums = (await readFile(join(directory, "SHA256SUMS"), "utf8"))
    .trim()
    .split("\n")
    .map((line) =>
      line.endsWith("release-evidence.json") ? `${sha(bytes)}  release-evidence.json` : line,
    );
  await writeFile(join(directory, "SHA256SUMS"), `${sums.join("\n")}\n`);
}

test("the same inputs give the same bytes, and the evidence carries no clock or host", async () => {
  const first = await prepared("Valid");
  const second = await prepared("Valid");
  for (const name of ["SHA256SUMS", INSTALLER, DRAFT, "release-evidence.json"]) {
    assert.deepEqual(await readFile(join(first, name)), await readFile(join(second, name)), name);
  }
  const evidence = await readFile(join(first, "release-evidence.json"), "utf8");
  assert.doesNotMatch(evidence, /\d{4}-\d\d-\d\d|\/tmp|\/var|[A-Z]:\\/);
  const draft = await readFile(join(first, DRAFT), "utf8");
  assert.doesNotMatch(draft, /\d{4}-\d\d-\d\d|\/tmp|\/var|[A-Z]:\\|releasedAt|notes/);
});

test("only the two statuses of an unsigned or a validly signed installer are accepted", async () => {
  for (const authenticode of ["NotTrusted", "UnknownError", "valid", "", undefined]) {
    const { bundleDir, outputDir } = await bundle("x-setup.exe");
    await assert.rejects(
      prepareStandaloneRelease({
        version: VERSION,
        ...SOURCE,
        bundleDir,
        outputDir,
        authenticode,
      }),
      /neither signed nor unsigned/,
      String(authenticode),
    );
  }
});

test("a bad version or source is refused before anything is written", async () => {
  const { bundleDir, outputDir } = await bundle("x-setup.exe");
  const base = { version: VERSION, ...SOURCE, bundleDir, outputDir, authenticode: "NotSigned" };
  await assert.rejects(prepareStandaloneRelease({ ...base, version: "0.1" }), /not a version/);
  for (const sourceRepository of ["", "thevladbog", "a/b/c", "a b/c", undefined]) {
    await assert.rejects(
      prepareStandaloneRelease({ ...base, sourceRepository }),
      /repository is invalid/,
      String(sourceRepository),
    );
  }
  for (const sourceSha of ["A".repeat(40), "a".repeat(41), "g".repeat(40), undefined]) {
    await assert.rejects(
      prepareStandaloneRelease({ ...base, sourceSha }),
      /full lowercase/,
      String(sourceSha),
    );
  }
  await assert.rejects(stat(outputDir), { code: "ENOENT" });
});

test("evidence that does not describe this release is refused even when the sums agree", async () => {
  const changes = {
    "schema version": (evidence) => (evidence.schemaVersion = 2),
    product: (evidence) => (evidence.product = "station"),
    version: (evidence) => (evidence.version = "0.2.0"),
    roles: (evidence) => evidence.roles.reverse(),
    authenticode: (evidence) => (evidence.authenticode = "HashMismatch"),
    "source sha": (evidence) => (evidence.source.sha = "short"),
    "source repository": (evidence) => (evidence.source.repository = "no-slash"),
  };
  for (const [what, change] of Object.entries(changes)) {
    const directory = await prepared();
    await rewriteEvidence(directory, change);
    await assert.rejects(
      verifyPreparedStandaloneRelease({ directory, version: VERSION }),
      /evidence is invalid|is invalid|full lowercase/,
      what,
    );
  }
  for (const [what, change] of Object.entries({
    size: (evidence) => (evidence.assets[INSTALLER].size += 1),
    hash: (evidence) => (evidence.assets[INSTALLER].sha256 = "0".repeat(64)),
    "an extra asset": (evidence) => (evidence.assets["other.exe"] = { sha256: "0", size: 0 }),
  })) {
    const directory = await prepared();
    await rewriteEvidence(directory, change);
    await assert.rejects(
      verifyPreparedStandaloneRelease({ directory, version: VERSION }),
      /checksum mismatch/,
      what,
    );
  }
});

test("SHA256SUMS must list exactly the installer and the evidence, once, with their hashes", async () => {
  const sumsPath = (directory) => join(directory, "SHA256SUMS");
  const cases = {
    "a changed evidence hash": [
      (lines) =>
        lines.map((line) =>
          line.endsWith("evidence.json") ? `${"0".repeat(64)}  release-evidence.json` : line,
        ),
      /checksum mismatch: release-evidence\.json/,
    ],
    "a changed installer hash": [
      (lines) =>
        lines.map((line) =>
          line.endsWith("setup.exe") ? `${"0".repeat(64)}  ${INSTALLER}` : line,
        ),
      /checksum mismatch: markiro-standalone/,
    ],
    "a changed draft hash": [
      (lines) =>
        lines.map((line) =>
          line.endsWith("update-draft.json") ? `${"0".repeat(64)}  ${DRAFT}` : line,
        ),
      /checksum mismatch: markiro-standalone-0\.1\.0\.update-draft\.json/,
    ],
    "a missing line": [(lines) => lines.slice(1), /names unexpected assets/],
    "a duplicated line": [(lines) => [...lines, lines[0]], /SHA256SUMS is invalid/],
    "a foreign file": [
      (lines) => [...lines, `${"0".repeat(64)}  other.exe`],
      /names unexpected assets/,
    ],
    "a path in the name": [
      (lines) => [...lines, `${"0".repeat(64)}  ../x`],
      /SHA256SUMS is invalid/,
    ],
    "a short hash": [(lines) => lines.map((line) => line.slice(1)), /SHA256SUMS is invalid/],
  };
  for (const [what, [change, expected]] of Object.entries(cases)) {
    const directory = await prepared();
    const lines = (await readFile(sumsPath(directory), "utf8")).trim().split("\n");
    await writeFile(sumsPath(directory), `${change(lines).join("\n")}\n`);
    await assert.rejects(
      verifyPreparedStandaloneRelease({ directory, version: VERSION }),
      expected,
      what,
    );
  }
});

test("the command line prepares the release and refuses what the function refuses", async () => {
  const { bundleDir, outputDir } = await bundle("Markiro Standalone_0.1.0_x64-setup.exe");
  const args = [
    PREPARE,
    "--bundle-dir",
    bundleDir,
    "--output-dir",
    outputDir,
    "--source-repository",
    "thevladbog/markiro",
    "--source-sha",
    "a".repeat(40),
    "--authenticode",
    "NotSigned",
  ];
  const run = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(
    run.stdout,
    `${INSTALLER} 07fb0332d384ea8d15c76c2c6a4e176e93345d9f403b1cd17e8b0dd2e4d1ac62 (NotSigned)\n`,
  );
  // The output directory is not empty any more: a second run is refused.
  assert.notEqual(spawnSync(process.execPath, args, { encoding: "utf8" }).status, 0);
  const unknown = spawnSync(process.execPath, [PREPARE, "--sign-with", "x"], { encoding: "utf8" });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /sign-with/);
});

test("importing the module runs nothing", async () => {
  const run = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(`file://${PREPARE}`)})`],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "");
});

/** Rewrites the draft and keeps SHA256SUMS consistent with it. */
async function rewriteDraft(directory, change) {
  const path = join(directory, DRAFT);
  const draft = JSON.parse(await readFile(path, "utf8"));
  change(draft);
  const bytes = `${JSON.stringify(draft, null, 2)}\n`;
  await writeFile(path, bytes);
  const sums = (await readFile(join(directory, "SHA256SUMS"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => (line.endsWith(DRAFT) ? `${sha(bytes)}  ${DRAFT}` : line));
  await writeFile(join(directory, "SHA256SUMS"), `${sums.join("\n")}\n`);
}

test("reads the protocol range of the build from the wire crate, the one hello.json names", async () => {
  const hello = JSON.parse(await readFile("apps/standalone/proto/fixtures/hello.json", "utf8"));
  assert.deepEqual(await readProtocolRange(), {
    protocol: hello.protocol,
    minProtocol: hello.minProtocol,
  });
  const dir = await mkdtemp(join(tmpdir(), "standalone-proto-"));
  const lib = join(dir, "lib.rs");
  await writeFile(lib, "pub const PROTOCOL_VERSION: u32 = 3;\n");
  await assert.rejects(readProtocolRange(lib), /has no MIN_PROTOCOL_VERSION/);
  await writeFile(
    lib,
    "pub const PROTOCOL_VERSION: u32 = 2;\npub const MIN_PROTOCOL_VERSION: u32 = 3;\n",
  );
  await assert.rejects(readProtocolRange(lib), /protocol range is invalid/);
});

test("a protocol range that is not one is refused before anything is written", async () => {
  for (const range of [
    { protocol: 0, minProtocol: 0 },
    { protocol: 1, minProtocol: 2 },
    { protocol: 3.5, minProtocol: 1 },
    { protocol: 3, minProtocol: undefined },
    // Past `u32`, the type the host and the app read it as.
    { protocol: 2 ** 32, minProtocol: 1 },
  ]) {
    const { bundleDir, outputDir } = await bundle("x-setup.exe");
    await assert.rejects(
      prepareStandaloneRelease({
        version: VERSION,
        ...SOURCE,
        ...range,
        bundleDir,
        outputDir,
        authenticode: "NotSigned",
      }),
      /protocol range is invalid/,
      JSON.stringify(range),
    );
    await assert.rejects(stat(outputDir), { code: "ENOENT" });
  }
});

test("a draft that does not describe the installer is refused even when the sums agree", async () => {
  for (const [what, change] of Object.entries({
    hash: (draft) => (draft.installer.sha256 = "0".repeat(64)),
    size: (draft) => (draft.installer.sizeBytes += 1),
    version: (draft) => (draft.version = "0.2.0"),
    commit: (draft) => (draft.sourceSha = "b".repeat(40)),
    "a protocol as text": (draft) => (draft.protocol = "3"),
    "a range upside down": (draft) => (draft.minProtocol = 4),
    "an extra key": (draft) => (draft.channel = "stable"),
    "another product": (draft) => (draft.product = "station"),
  })) {
    const directory = await prepared();
    await rewriteDraft(directory, change);
    await assert.rejects(
      verifyPreparedStandaloneRelease({ directory, version: VERSION }),
      /update draft is invalid/,
      what,
    );
  }
});
