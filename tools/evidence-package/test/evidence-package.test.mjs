import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const toolRoot = fileURLToPath(new URL("..", import.meta.url));
const coreUrl = new URL("../evidence-package.mjs", import.meta.url);
const manifestName = "manifest.json";
const checksumsName = "SHA256SUMS";
const operationId = "INV-20260824-pilot-01";

async function loadCore() {
  let loaded;
  await assert.doesNotReject(async () => {
    loaded = await import(coreUrl.href);
  }, "the evidence-package module should be available");
  return loaded;
}

async function temporaryDirectory(t, prefix = "markiro-evidence-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { force: true, recursive: true }));
  return root;
}

function manifestDraft(overrides = {}) {
  return {
    manifestVersion: 1,
    operationId,
    protocolVersion: "inventory-recovery-v1",
    customer: { legalName: "Test fixture", site: "Test site" },
    operator: { name: "Test operator", role: "founder" },
    device: { id: "fixture-device", stationVersion: "0.0.0", apiVersion: "0.0.0" },
    timezone: "Europe/Moscow",
    newSscc: { threshold: "200", range: "200-299" },
    scorecardEligibility: {
      eligible: false,
      reason: "founder_led_inventory_recovery",
    },
    startedAt: "2026-08-24T06:00:00.000Z",
    completedAt: null,
    updatedAt: "2026-08-24T07:00:00.000Z",
    artifacts: [],
    ...overrides,
  };
}

async function writeArtifact(root, relativePath, bytes) {
  const target = join(root, ...relativePath.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return target;
}

async function packageFixture(t) {
  const root = await temporaryDirectory(t);
  await writeArtifact(root, "baseline/old-sscc.raw.txt", Buffer.from("abc"));
  await writeArtifact(root, "photos/duplicates/Фото 1.bin", Buffer.from([0, 1, 2, 255]));
  await writeFile(join(root, manifestName), `${JSON.stringify(manifestDraft(), null, 2)}\n`);
  return root;
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function runCli(script, args) {
  try {
    const result = await execFile(process.execPath, [join(toolRoot, script), ...args], {
      encoding: "utf8",
    });
    return { code: 0, stderr: result.stderr, stdout: result.stdout };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : -1,
      stderr: error.stderr ?? "",
      stdout: error.stdout ?? "",
    };
  }
}

test("lists evidence files in direct code-point order with POSIX paths", async (t) => {
  const { listEvidenceFiles } = await loadCore();
  const root = await temporaryDirectory(t);
  await writeArtifact(root, "photos/Я файл.bin", "one");
  await writeArtifact(root, "photos/a file.bin", "two");
  await writeArtifact(root, "baseline/é.txt", "three");

  assert.deepEqual(await listEvidenceFiles(root), [
    "baseline/é.txt",
    "photos/a file.bin",
    "photos/Я файл.bin",
  ]);
});

test("rejects arbitrary transient files during artifact enumeration", async (t) => {
  const { listEvidenceFiles } = await loadCore();
  const root = await temporaryDirectory(t);
  await writeArtifact(root, "baseline/kept.txt", "kept");
  await writeFile(join(root, manifestName), "draft");
  await writeFile(join(root, checksumsName), "checksums");
  await writeFile(join(root, "manifest.json.interrupted.tmp"), "temporary");

  await assert.rejects(listEvidenceFiles(root), /unlisted temporary file.*interrupted\.tmp/i);
});

test("hashes real file bytes with SHA-256", async (t) => {
  const { sha256File } = await loadCore();
  const root = await temporaryDirectory(t);
  const file = await writeArtifact(root, "baseline/value.bin", Buffer.from("abc"));

  assert.equal(
    await sha256File(file),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("builds literal artifact metadata from real files", async (t) => {
  const { buildManifest } = await loadCore();
  const root = await temporaryDirectory(t);
  await writeArtifact(root, "baseline/old-sscc.raw.txt", Buffer.from("abc"));
  const draft = manifestDraft();

  const manifest = await buildManifest(root, draft);

  assert.equal(manifest.operationId, operationId);
  assert.deepEqual(manifest.customer, draft.customer);
  assert.deepEqual(manifest.artifacts, [
    {
      path: "baseline/old-sscc.raw.txt",
      category: "baseline",
      byteSize: 3,
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      capturedAt: "2026-08-24T07:00:00.000Z",
      actor: { name: "Test operator", role: "founder" },
      physicalBoxRefs: [],
      evidenceRefs: [],
    },
  ]);
});

test("preserves prior per-path provenance while replacing stale artifacts", async (t) => {
  const { buildManifest } = await loadCore();
  const root = await temporaryDirectory(t);
  await writeArtifact(root, "baseline/old-sscc.raw.txt", "new bytes");
  const draft = manifestDraft({
    operationNote: "preserve this operation metadata",
    artifacts: [
      {
        path: "baseline/old-sscc.raw.txt",
        category: "old-category",
        byteSize: 1,
        sha256: "0".repeat(64),
        capturedAt: "2026-08-24T06:30:00.000Z",
        actor: { name: "Importer", role: "operator" },
        physicalBoxRefs: ["BOX-7"],
        evidenceRefs: ["PHOTO-2"],
      },
      {
        path: "photos/removed.jpg",
        capturedAt: "2026-08-24T06:40:00.000Z",
      },
    ],
  });

  const manifest = await buildManifest(root, draft);

  assert.equal(manifest.operationNote, "preserve this operation metadata");
  assert.equal(manifest.artifacts.length, 1);
  assert.equal(manifest.artifacts[0].category, "baseline");
  assert.equal(manifest.artifacts[0].capturedAt, "2026-08-24T06:30:00.000Z");
  assert.deepEqual(manifest.artifacts[0].actor, { name: "Importer", role: "operator" });
  assert.deepEqual(manifest.artifacts[0].physicalBoxRefs, ["BOX-7"]);
  assert.deepEqual(manifest.artifacts[0].evidenceRefs, ["PHOTO-2"]);
});

test("seals deterministically and includes the manifest in SHA256SUMS", async (t) => {
  const { sealEvidencePackage } = await loadCore();
  const root = await packageFixture(t);

  assert.deepEqual(await sealEvidencePackage(root), { artifactCount: 2, checksumCount: 3 });
  const firstManifest = await readFile(join(root, manifestName), "utf8");
  const firstChecksums = await readFile(join(root, checksumsName), "utf8");
  assert.match(firstChecksums, new RegExp(`^${sha256Bytes(firstManifest)}  manifest\\.json$`, "m"));
  assert.match(
    firstChecksums,
    /^ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad {2}baseline\/old-sscc\.raw\.txt$/m,
  );

  assert.deepEqual(await sealEvidencePackage(root), { artifactCount: 2, checksumCount: 3 });
  assert.equal(await readFile(join(root, manifestName), "utf8"), firstManifest);
  assert.equal(await readFile(join(root, checksumsName), "utf8"), firstChecksums);
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("verifies every checksummed file in a sealed package", async (t) => {
  const { sealEvidencePackage, verifyEvidencePackage } = await loadCore();
  const root = await packageFixture(t);
  await sealEvidencePackage(root);

  assert.deepEqual(await verifyEvidencePackage(root), { checkedCount: 3 });
});

test("rejects an artifact whose bytes changed after sealing", async (t) => {
  const { sealEvidencePackage, verifyEvidencePackage } = await loadCore();
  const root = await packageFixture(t);
  await sealEvidencePackage(root);
  await writeFile(join(root, "baseline", "old-sscc.raw.txt"), "changed");

  await assert.rejects(verifyEvidencePackage(root), /checksum mismatch.*old-sscc\.raw\.txt/i);
});

test("rejects a checksummed artifact that is missing", async (t) => {
  const { sealEvidencePackage, verifyEvidencePackage } = await loadCore();
  const root = await packageFixture(t);
  await sealEvidencePackage(root);
  await rm(join(root, "photos", "duplicates", "Фото 1.bin"));

  await assert.rejects(verifyEvidencePackage(root), /missing checksummed file.*Фото 1\.bin/i);
});

test("rejects a regular artifact omitted from SHA256SUMS", async (t) => {
  const { sealEvidencePackage, verifyEvidencePackage } = await loadCore();
  const root = await packageFixture(t);
  await sealEvidencePackage(root);
  await writeArtifact(root, "exports/system/unlisted.csv", "not sealed");

  await assert.rejects(verifyEvidencePackage(root), /unlisted regular file.*unlisted\.csv/i);
});

test("rejects an arbitrary temporary file before sealing", async (t) => {
  const { sealEvidencePackage } = await loadCore();
  const root = await packageFixture(t);
  await writeFile(join(root, "manifest.json.recovery.tmp"), "recovery bytes");

  await assert.rejects(
    sealEvidencePackage(root),
    /unlisted temporary file.*manifest\.json\.recovery\.tmp/i,
  );
});

test("rejects an arbitrary temporary file added after sealing", async (t) => {
  const { sealEvidencePackage, verifyEvidencePackage } = await loadCore();
  const root = await packageFixture(t);
  await sealEvidencePackage(root);
  const copyParent = await temporaryDirectory(t, "markiro-evidence-copy-");
  const divergentCopy = join(copyParent, "copy");
  await cp(root, divergentCopy, { recursive: true });
  await writeFile(join(divergentCopy, "copy-divergence.tmp"), "unsealed bytes");

  assert.deepEqual(await verifyEvidencePackage(root), { checkedCount: 3 });
  await assert.rejects(
    verifyEvidencePackage(divergentCopy),
    /unlisted temporary file.*copy-divergence\.tmp/i,
  );
});

test("rejects manifest metadata inconsistent with the sealed artifacts", async (t) => {
  const { sealEvidencePackage, verifyEvidencePackage } = await loadCore();
  const root = await packageFixture(t);
  await sealEvidencePackage(root);
  const manifestPath = join(root, manifestName);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.artifacts[0].byteSize += 1;
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(manifestPath, manifestText);
  const checksumPath = join(root, checksumsName);
  const checksums = await readFile(checksumPath, "utf8");
  await writeFile(
    checksumPath,
    checksums.replace(
      /^[0-9a-f]{64} {2}manifest\.json$/m,
      `${sha256Bytes(manifestText)}  manifest.json`,
    ),
  );

  await assert.rejects(verifyEvidencePackage(root), /manifest metadata mismatch/i);
});

test("rejects symlink files and directories without following them", async (t) => {
  const { listEvidenceFiles } = await loadCore();
  const root = await temporaryDirectory(t);
  const external = await temporaryDirectory(t, "markiro-evidence-external-");
  await writeFile(join(external, "outside.txt"), "outside");
  await symlink(join(external, "outside.txt"), join(root, "linked-file"));

  await assert.rejects(listEvidenceFiles(root), /symlink.*linked-file/i);

  await rm(join(root, "linked-file"));
  await symlink(external, join(root, "linked-directory"));
  await assert.rejects(listEvidenceFiles(root), /symlink.*linked-directory/i);
});

test("a failed seal leaves the previous manifest and checksums intact", async (t) => {
  const { sealEvidencePackage } = await loadCore();
  const root = await packageFixture(t);
  await sealEvidencePackage(root);
  const previousManifest = await readFile(join(root, manifestName), "utf8");
  const previousChecksums = await readFile(join(root, checksumsName), "utf8");
  const external = await temporaryDirectory(t, "markiro-evidence-external-");
  await writeFile(join(external, "outside.txt"), "outside");
  await symlink(join(external, "outside.txt"), join(root, "photos", "escape.jpg"));

  await assert.rejects(sealEvidencePackage(root), /symlink.*escape\.jpg/i);
  assert.equal(await readFile(join(root, manifestName), "utf8"), previousManifest);
  assert.equal(await readFile(join(root, checksumsName), "utf8"), previousChecksums);
});

test("rejects duplicate, traversal, absolute, and malformed checksum entries", async (t) => {
  const { sealEvidencePackage, verifyEvidencePackage } = await loadCore();
  const cases = [
    {
      name: "duplicate",
      rewrite: (valid) => `${valid}${valid.split("\n")[0]}\n`,
      expected: /duplicate checksum path/i,
    },
    {
      name: "traversal",
      rewrite: () => `${"0".repeat(64)}  ../outside.txt\n`,
      expected: /unsafe checksum path/i,
    },
    {
      name: "absolute POSIX path",
      rewrite: () => `${"0".repeat(64)}  /etc/passwd\n`,
      expected: /absolute checksum path/i,
    },
    {
      name: "absolute Windows path",
      rewrite: () => `${"0".repeat(64)}  C:\\outside.txt\n`,
      expected: /absolute checksum path/i,
    },
    {
      name: "malformed line",
      rewrite: () => `${"0".repeat(64)} manifest.json\n`,
      expected: /malformed checksum line/i,
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async (subtest) => {
      const root = await packageFixture(subtest);
      await sealEvidencePackage(root);
      const checksumPath = join(root, checksumsName);
      const valid = await readFile(checksumPath, "utf8");
      await writeFile(checksumPath, fixture.rewrite(valid));
      await assert.rejects(verifyEvidencePackage(root), fixture.expected);
    });
  }
});

test("rejects checksum paths that resolve outside the operation root", async (t) => {
  const { sealEvidencePackage, verifyEvidencePackage } = await loadCore();
  const root = await packageFixture(t);
  await sealEvidencePackage(root);
  const outside = join(dirname(root), "outside.txt");
  await writeFile(outside, "outside");
  t.after(() => rm(outside, { force: true }));
  await writeFile(
    join(root, checksumsName),
    `${sha256Bytes("outside")}  photos/../../outside.txt\n`,
  );

  await assert.rejects(verifyEvidencePackage(root), /unsafe checksum path/i);
});

test("enforces the 10000-artifact package limit", { timeout: 30_000 }, async (t) => {
  const { listEvidenceFiles } = await loadCore();
  const root = await temporaryDirectory(t);
  const directory = join(root, "photos");
  await mkdir(directory);
  for (let start = 0; start < 10_001; start += 250) {
    const end = Math.min(start + 250, 10_001);
    await Promise.all(
      Array.from({ length: end - start }, (_, offset) =>
        writeFile(join(directory, `${String(start + offset).padStart(5, "0")}.jpg`), ""),
      ),
    );
  }

  await assert.rejects(listEvidenceFiles(root), /file count limit.*10000/i);
});

test("rejects a manifest larger than the 4 MiB bound", async (t) => {
  const { sealEvidencePackage } = await loadCore();
  const root = await temporaryDirectory(t);
  await writeFile(join(root, manifestName), "x".repeat(4 * 1024 * 1024 + 1));

  await assert.rejects(sealEvidencePackage(root), /manifest.*size limit/i);
});

test("initializer creates only the P0 scaffold and a zero-byte raw baseline", async (t) => {
  const rootParent = await temporaryDirectory(t);
  const root = join(rootParent, "external-operation-root");

  const result = await runCli("init.mjs", [root, operationId]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /initialized evidence package.*INV-20260824-pilot-01/i);
  assert.equal((await stat(join(root, "baseline", "old-sscc.raw.txt"))).size, 0);
  assert.deepEqual(
    await Promise.all(
      [
        "amendments",
        "attestation",
        "baseline",
        "exports/system",
        "metrics",
        "photos/duplicates",
      ].map(async (relativePath) => [
        relativePath,
        (await stat(join(root, relativePath))).isDirectory(),
      ]),
    ),
    [
      ["amendments", true],
      ["attestation", true],
      ["baseline", true],
      ["exports/system", true],
      ["metrics", true],
      ["photos/duplicates", true],
    ],
  );
  const manifest = JSON.parse(await readFile(join(root, manifestName), "utf8"));
  assert.equal(manifest.operationId, operationId);
  assert.equal(manifest.manifestVersion, 1);
  assert.deepEqual(manifest.artifacts, []);
  assert.deepEqual(manifest.scorecardEligibility, {
    eligible: false,
    reason: "founder_led_inventory_recovery",
  });
});

test("initializer rejects invalid operation ids without creating the root", async (t) => {
  const parent = await temporaryDirectory(t);
  const invalidIds = [
    "INV-20260824-A-01",
    "INV-2026082-pilot-01",
    "INV-20260824-a-01",
    "INV-20260824-pilot-1",
    "../INV-20260824-pilot-01",
  ];

  for (const [index, invalidId] of invalidIds.entries()) {
    const root = join(parent, `operation-${index}`);
    const result = await runCli("init.mjs", [root, invalidId]);
    assert.notEqual(result.code, 0, invalidId);
    assert.match(result.stderr, /invalid operation id/i);
    await assert.rejects(stat(root), { code: "ENOENT" });
  }
});

test("initializer refuses to truncate a populated raw baseline", async (t) => {
  const root = await temporaryDirectory(t);
  const baseline = await writeArtifact(
    root,
    "baseline/old-sscc.raw.txt",
    "sensitive fixture bytes",
  );

  const result = await runCli("init.mjs", [root, operationId]);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /raw baseline.*not empty/i);
  assert.doesNotMatch(result.stderr, /sensitive fixture bytes/);
  assert.equal(await readFile(baseline, "utf8"), "sensitive fixture bytes");
  await assert.rejects(stat(join(root, manifestName)), { code: "ENOENT" });
});

test("initializer preserves an existing matching manifest on an idempotent rerun", async (t) => {
  const parent = await temporaryDirectory(t);
  const root = join(parent, "operation");
  assert.equal((await runCli("init.mjs", [root, operationId])).code, 0);
  const existing = manifestDraft({ operationNote: "do not overwrite" });
  const existingText = `${JSON.stringify(existing, null, 2)}\n`;
  await writeFile(join(root, manifestName), existingText);

  const result = await runCli("init.mjs", [root, operationId]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(join(root, manifestName), "utf8"), existingText);
  assert.equal((await stat(join(root, "baseline", "old-sscc.raw.txt"))).size, 0);
});

test("CLI seal and verify report operator-usable counts without file contents", async (t) => {
  const parent = await temporaryDirectory(t);
  const root = join(parent, "operation");
  assert.equal((await runCli("init.mjs", [root, operationId])).code, 0);
  await writeArtifact(root, "baseline/old-box-index.csv", "fixture,row\n");

  const sealed = await runCli("seal.mjs", [root]);
  assert.equal(sealed.code, 0, sealed.stderr);
  assert.match(sealed.stdout, /sealed evidence package: 2 artifacts, 3 checksums/i);
  assert.doesNotMatch(sealed.stdout, /fixture,row/);

  const verified = await runCli("verify.mjs", [root]);
  assert.equal(verified.code, 0, verified.stderr);
  assert.match(verified.stdout, /verified evidence package: 3 files/i);
  assert.doesNotMatch(verified.stdout, /fixture,row/);
});

test("CLI accepts the documented leading pnpm separator", async (t) => {
  const parent = await temporaryDirectory(t);
  const root = join(parent, "operation");

  const initialized = await runCli("init.mjs", ["--", root, operationId]);
  assert.equal(initialized.code, 0, initialized.stderr);

  const sealed = await runCli("seal.mjs", ["--", root]);
  assert.equal(sealed.code, 0, sealed.stderr);

  const verified = await runCli("verify.mjs", ["--", root]);
  assert.equal(verified.code, 0, verified.stderr);
});
