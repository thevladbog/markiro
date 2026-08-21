import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  listEvidenceFiles,
  sealEvidencePackage,
  verifyEvidencePackage,
} from "../evidence-package.mjs";
import { initializeEvidencePackage } from "../init.mjs";

const execFile = promisify(execFileCallback);
const toolRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const manifestName = "manifest.json";
const checksumsName = "SHA256SUMS";
const operationId = "INV-20260824-secure-01";

async function temporaryDirectory(t, prefix = "markiro-evidence-security-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { force: true, recursive: true }));
  return root;
}

function draft(id = operationId, overrides = {}) {
  return {
    manifestVersion: 1,
    operationId: id,
    protocolVersion: "inventory-recovery-v1",
    operator: { name: "Fixture operator", role: "founder" },
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
  await writeArtifact(root, "baseline/old-sscc.raw.txt", "original artifact bytes");
  await writeFile(join(root, manifestName), `${JSON.stringify(draft(), null, 2)}\n`);
  return root;
}

function filesystem(overrides = {}) {
  return { ...fsPromises, constants: fsConstants, ...overrides };
}

async function generatedBytes(root) {
  return {
    manifest: await readFile(join(root, manifestName), "utf8"),
    checksums: await readFile(join(root, checksumsName), "utf8"),
  };
}

async function assertGeneratedBytes(root, expected) {
  assert.equal(await readFile(join(root, manifestName), "utf8"), expected.manifest);
  assert.equal(await readFile(join(root, checksumsName), "utf8"), expected.checksums);
}

test("Windows-semantics identity checks reject a root swap without no-follow flags", async (t) => {
  const root = await packageFixture(t);
  const parked = `${root}.windows-original`;
  const replacement = await temporaryDirectory(t, "markiro-evidence-windows-replacement-");
  t.after(() => rm(parked, { force: true, recursive: true }));
  let swapped = false;
  const portable = filesystem({
    constants: { ...fsConstants, O_DIRECTORY: undefined, O_NOFOLLOW: undefined },
    async open(path, ...args) {
      if (!swapped && path === root) {
        swapped = true;
        await rename(root, parked);
        await rename(replacement, root);
      }
      return fsPromises.open(path, ...args);
    },
  });

  await assert.rejects(
    listEvidenceFiles(root, { filesystem: portable }),
    /filesystem identity changed.*root/i,
  );
});

test("initializer remains functional without no-follow flags and still binds root identity", async (t) => {
  const parent = await temporaryDirectory(t);
  const cleanRoot = join(parent, "clean-operation");
  const constantsWithoutNoFollow = {
    ...fsConstants,
    O_DIRECTORY: undefined,
    O_NOFOLLOW: undefined,
  };

  await initializeEvidencePackage(cleanRoot, operationId, {
    filesystem: filesystem({ constants: constantsWithoutNoFollow }),
  });
  assert.equal((await stat(join(cleanRoot, manifestName))).isFile(), true);

  const racedRoot = join(parent, "raced-operation");
  await mkdir(racedRoot);
  const parked = join(parent, "raced-operation-original");
  const replacement = join(parent, "raced-operation-replacement");
  await mkdir(replacement);
  let swapped = false;
  const portable = filesystem({
    constants: constantsWithoutNoFollow,
    async open(path, ...args) {
      if (!swapped && path === racedRoot) {
        swapped = true;
        await rename(racedRoot, parked);
        await rename(replacement, racedRoot);
      }
      return fsPromises.open(path, ...args);
    },
  });

  await assert.rejects(
    initializeEvidencePackage(racedRoot, operationId, { filesystem: portable }),
    /filesystem identity changed.*root/i,
  );
  await assert.rejects(stat(join(racedRoot, manifestName)), { code: "ENOENT" });
});

test("initializer rejects a scaffold directory replaced while it is bound", async (t) => {
  const root = await temporaryDirectory(t);
  const baseline = join(root, "baseline");
  const parked = `${root}.baseline-original`;
  const replacement = await temporaryDirectory(t, "markiro-evidence-init-replacement-");
  await mkdir(baseline);
  t.after(() => rm(parked, { force: true, recursive: true }));
  let swapped = false;
  const injected = filesystem({
    async open(path, ...args) {
      if (!swapped && path === baseline) {
        swapped = true;
        await rename(baseline, parked);
        await rename(replacement, baseline);
      }
      return fsPromises.open(path, ...args);
    },
  });

  await assert.rejects(
    initializeEvidencePackage(root, operationId, { filesystem: injected }),
    /filesystem identity changed.*baseline/i,
  );
  await assert.rejects(stat(join(root, manifestName)), { code: "ENOENT" });
});

test("fails closed when stable filesystem identity fields are unavailable", async (t) => {
  const root = await packageFixture(t);
  const injected = filesystem({
    async lstat(path, options) {
      const information = await fsPromises.lstat(path, options);
      Object.defineProperty(information, "ino", { configurable: true, value: 0n });
      return information;
    },
  });

  await assert.rejects(
    listEvidenceFiles(root, { filesystem: injected }),
    /stable filesystem identity fields are unavailable/i,
  );
});

test("rejects a root replaced between lstat and descriptor binding", async (t) => {
  const root = await packageFixture(t);
  const parked = `${root}.original`;
  const replacement = await temporaryDirectory(t, "markiro-evidence-root-replacement-");
  t.after(() => rm(parked, { force: true, recursive: true }));
  let swapped = false;
  const injected = filesystem({
    async open(path, ...args) {
      if (!swapped && path === root) {
        swapped = true;
        await rename(root, parked);
        await rename(replacement, root);
      }
      return fsPromises.open(path, ...args);
    },
  });

  await assert.rejects(
    listEvidenceFiles(root, { filesystem: injected }),
    /filesystem identity changed.*root/i,
  );
});

test("rejects an artifact replaced between lstat and descriptor open", async (t) => {
  const root = await packageFixture(t);
  const artifact = join(root, "baseline", "old-sscc.raw.txt");
  const parked = join(root, "baseline", "old-sscc.raw.txt.original.tmp");
  const replacement = join(root, "baseline", "old-sscc.raw.txt.replacement.tmp");
  await writeFile(replacement, "attacker-controlled replacement bytes");
  let swapped = false;
  const injected = filesystem({
    async open(path, ...args) {
      if (!swapped && path === artifact) {
        swapped = true;
        await rename(artifact, parked);
        await rename(replacement, artifact);
      }
      return fsPromises.open(path, ...args);
    },
  });

  await assert.rejects(
    sealEvidencePackage(root, { filesystem: injected }),
    /filesystem identity changed.*old-sscc\.raw\.txt/i,
  );
});

test("rejects a directory replaced while its entries are enumerated", async (t) => {
  const root = await packageFixture(t);
  const baseline = join(root, "baseline");
  const parked = `${root}.baseline-original`;
  const replacement = await temporaryDirectory(t, "markiro-evidence-directory-replacement-");
  await writeFile(join(replacement, "outside.txt"), "replacement directory bytes");
  t.after(() => rm(parked, { force: true, recursive: true }));
  let swapped = false;
  const injected = filesystem({
    async readdir(path, options) {
      if (!swapped && path === baseline) {
        swapped = true;
        await rename(baseline, parked);
        await rename(replacement, baseline);
      }
      return fsPromises.readdir(path, options);
    },
  });

  await assert.rejects(
    listEvidenceFiles(root, { filesystem: injected }),
    /filesystem identity changed.*baseline/i,
  );
});

test("verification parses the same manifest bytes that it checksums", async (t) => {
  const root = await packageFixture(t);
  await sealEvidencePackage(root);
  const manifestPath = join(root, manifestName);
  const original = JSON.parse(await readFile(manifestPath, "utf8"));
  const changedText = `${JSON.stringify({ ...original, operationNote: "changed between reads" }, null, 2)}\n`;
  let manifestOpenCount = 0;
  let mutated = false;
  const injected = filesystem({
    async open(path, ...args) {
      const handle = await fsPromises.open(path, ...args);
      if (path !== manifestPath) return handle;
      manifestOpenCount += 1;
      return new Proxy(handle, {
        get(target, property) {
          if (property === "close") {
            return async () => {
              await target.close();
              if (!mutated) {
                mutated = true;
                await writeFile(manifestPath, changedText);
              }
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  });

  assert.deepEqual(await verifyEvidencePackage(root, { filesystem: injected }), {
    checkedCount: 2,
  });
  assert.equal(manifestOpenCount, 1);
  assert.equal(mutated, true);
  assert.equal(
    JSON.parse(await readFile(manifestPath, "utf8")).operationNote,
    "changed between reads",
  );
});

test("initializer revalidates when a concurrent different operation wins installation", async (t) => {
  const parent = await temporaryDirectory(t);
  const root = join(parent, "operation");
  const competingId = "INV-20260824-competing-02";
  let injected = false;
  const injectedFilesystem = filesystem({
    async link(existingPath, newPath) {
      if (!injected && basename(newPath) === manifestName) {
        injected = true;
        await initializeEvidencePackage(root, competingId);
      }
      return fsPromises.link(existingPath, newPath);
    },
  });

  await assert.rejects(
    initializeEvidencePackage(root, operationId, { filesystem: injectedFilesystem }),
    /different operation/i,
  );
  const installed = JSON.parse(await readFile(join(root, manifestName), "utf8"));
  assert.equal(installed.operationId, competingId);
});

test("initializer removes an owned partial temporary file after a write failure", async (t) => {
  const root = await temporaryDirectory(t);
  await writeArtifact(root, "baseline/old-sscc.raw.txt", "");
  let failed = false;
  const injected = filesystem({
    async open(path, ...args) {
      const handle = await fsPromises.open(path, ...args);
      if (!failed && basename(path).startsWith(manifestName)) {
        failed = true;
        return {
          async close() {
            return handle.close();
          },
          async stat(options) {
            return handle.stat(options);
          },
          async sync() {
            return handle.sync();
          },
          async writeFile(contents, options) {
            await handle.writeFile(String(contents).slice(0, 12), options);
            throw Object.assign(new Error("injected partial write"), { code: "EIO" });
          },
        };
      }
      return handle;
    },
  });

  await assert.rejects(
    initializeEvidencePackage(root, operationId, { filesystem: injected }),
    /partial write|filesystem operation failed/i,
  );
  await assert.rejects(stat(join(root, manifestName)), { code: "ENOENT" });
  assert.equal((await stat(join(root, "baseline", "old-sscc.raw.txt"))).size, 0);
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.includes("manifest.json") && name.endsWith(".tmp")),
    [],
  );
});

test("initializer reports an unavailable atomic no-clobber capability", async (t) => {
  const root = await temporaryDirectory(t);
  const injected = filesystem({
    async link() {
      throw Object.assign(new Error("injected hard-link capability failure"), {
        code: "ENOTSUP",
      });
    },
  });

  await assert.rejects(
    initializeEvidencePackage(root, operationId, { filesystem: injected }),
    /atomic no-clobber installation is unavailable/i,
  );
  await assert.rejects(stat(join(root, "baseline", "old-sscc.raw.txt")), {
    code: "ENOENT",
  });
  assert.equal(
    (await readdir(join(root, "baseline"))).some((name) => name.endsWith(".tmp")),
    false,
  );
});

test("seal and reseal preserve own __proto__ operation and provenance metadata", async (t) => {
  const root = await temporaryDirectory(t);
  await writeArtifact(root, "baseline/old-sscc.raw.txt", "prototype fixture");
  const manifest = draft();
  Object.defineProperty(manifest, "__proto__", {
    enumerable: true,
    value: { operationMarker: "own operation metadata" },
  });
  Object.defineProperty(manifest.operator, "__proto__", {
    enumerable: true,
    value: { actorMarker: "own provenance metadata" },
  });
  await writeFile(join(root, manifestName), `${JSON.stringify(manifest, null, 2)}\n`);

  await sealEvidencePackage(root);
  await sealEvidencePackage(root);

  const sealed = JSON.parse(await readFile(join(root, manifestName), "utf8"));
  assert.equal(Object.hasOwn(sealed, "__proto__"), true);
  assert.deepEqual(sealed.__proto__, { operationMarker: "own operation metadata" });
  assert.equal(Object.hasOwn(sealed.artifacts[0].actor, "__proto__"), true);
  assert.deepEqual(sealed.artifacts[0].actor.__proto__, {
    actorMarker: "own provenance metadata",
  });
});

async function sealedChangedFixture(t) {
  const root = await packageFixture(t);
  await sealEvidencePackage(root);
  const previous = await generatedBytes(root);
  await writeFile(join(root, "baseline", "old-sscc.raw.txt"), "changed artifact bytes");
  return { previous, root };
}

test("backup rename failure leaves both previous generated files intact", async (t) => {
  const { previous, root } = await sealedChangedFixture(t);
  const injected = filesystem({
    async rename(source, destination) {
      if (destination.includes(".backup.tmp")) {
        throw Object.assign(new Error("injected backup rename failure"), { code: "EIO" });
      }
      return fsPromises.rename(source, destination);
    },
  });

  await assert.rejects(
    sealEvidencePackage(root, { filesystem: injected }),
    /backup.*failed|filesystem operation failed/i,
  );
  await assertGeneratedBytes(root, previous);
});

test("manifest installation rename failure restores both previous generated files", async (t) => {
  const { previous, root } = await sealedChangedFixture(t);
  const manifestPath = join(root, manifestName);
  const injected = filesystem({
    async rename(source, destination) {
      if (destination === manifestPath && !source.includes(".backup.tmp")) {
        throw Object.assign(new Error("injected manifest install failure"), { code: "EIO" });
      }
      return fsPromises.rename(source, destination);
    },
  });

  await assert.rejects(
    sealEvidencePackage(root, { filesystem: injected }),
    /install.*manifest|filesystem operation failed/i,
  );
  await assertGeneratedBytes(root, previous);
});

test("checksum installation rename failure rolls back an installed manifest", async (t) => {
  const { previous, root } = await sealedChangedFixture(t);
  const checksumPath = join(root, checksumsName);
  const injected = filesystem({
    async rename(source, destination) {
      if (destination === checksumPath && !source.includes(".backup.tmp")) {
        throw Object.assign(new Error("injected checksum install failure"), { code: "EIO" });
      }
      return fsPromises.rename(source, destination);
    },
  });

  await assert.rejects(
    sealEvidencePackage(root, { filesystem: injected }),
    /install.*SHA256SUMS|filesystem operation failed/i,
  );
  await assertGeneratedBytes(root, previous);
});

test("rollback failure reports that manual recovery is required", async (t) => {
  const { root } = await sealedChangedFixture(t);
  const manifestPath = join(root, manifestName);
  const checksumPath = join(root, checksumsName);
  const injected = filesystem({
    async rename(source, destination) {
      if (destination === checksumPath && !source.includes(".backup.tmp")) {
        throw Object.assign(new Error("injected checksum install failure"), { code: "EIO" });
      }
      if (destination === manifestPath && source.includes(".backup.tmp")) {
        throw Object.assign(new Error("injected rollback failure"), { code: "EIO" });
      }
      return fsPromises.rename(source, destination);
    },
  });

  await assert.rejects(
    sealEvidencePackage(root, { filesystem: injected }),
    /could not.*restore|manual recovery/i,
  );
  assert.equal(
    (await readdir(root)).some(
      (name) => name.startsWith(`${manifestName}.`) && name.endsWith(".backup.tmp"),
    ),
    true,
  );
});

test("backup cleanup failure is surfaced as actionable seal failure", async (t) => {
  const { root } = await sealedChangedFixture(t);
  const injected = filesystem({
    async rm(path, options) {
      if (path.includes(".backup.tmp")) {
        throw Object.assign(new Error("injected backup cleanup failure"), { code: "EIO" });
      }
      return fsPromises.rm(path, options);
    },
  });

  await assert.rejects(
    sealEvidencePackage(root, { filesystem: injected }),
    /backup cleanup failed.*manual/i,
  );
  assert.equal(
    (await readdir(root)).some((name) => name.endsWith(".backup.tmp")),
    true,
  );
});

test("persistent root replacement stops rollback before touching the replacement root", async (t) => {
  const { root } = await sealedChangedFixture(t);
  const parked = `${root}.owned-operation-root`;
  const replacement = await temporaryDirectory(t, "markiro-evidence-rollback-root-");
  const replacementManifest = "replacement-root manifest sentinel";
  const replacementChecksums = "replacement-root checksum sentinel";
  await writeFile(join(replacement, manifestName), replacementManifest);
  await writeFile(join(replacement, checksumsName), replacementChecksums);
  t.after(() => rm(parked, { force: true, recursive: true }));
  let swapped = false;
  const destructiveCallsAfterSwap = [];
  const checksumPath = join(root, checksumsName);
  const injected = filesystem({
    async rename(source, destination) {
      if (!swapped && destination === checksumPath && !source.includes(".backup.tmp")) {
        swapped = true;
        await fsPromises.rename(root, parked);
        await fsPromises.rename(replacement, root);
        throw Object.assign(new Error("injected install failure after root replacement"), {
          code: "EIO",
        });
      }
      if (swapped) destructiveCallsAfterSwap.push(["rename", source, destination]);
      return fsPromises.rename(source, destination);
    },
    async rm(path, options) {
      if (swapped) destructiveCallsAfterSwap.push(["rm", path]);
      return fsPromises.rm(path, options);
    },
  });

  await assert.rejects(
    sealEvidencePackage(root, { filesystem: injected }),
    /filesystem identity changed.*root|manual recovery/i,
  );
  assert.deepEqual(destructiveCallsAfterSwap, []);
  assert.equal(await readFile(join(root, manifestName), "utf8"), replacementManifest);
  assert.equal(await readFile(join(root, checksumsName), "utf8"), replacementChecksums);
});

test("staged temporary replacement is preserved instead of deleted during cleanup", async (t) => {
  const { previous, root } = await sealedChangedFixture(t);
  const foreignBytes = "foreign staged-path replacement";
  let stagedManifest;
  let ownedRecovery;
  const injected = filesystem({
    async open(path, ...args) {
      if (
        basename(path).startsWith(`${manifestName}.`) &&
        basename(path).endsWith(".tmp") &&
        !basename(path).endsWith(".backup.tmp")
      ) {
        stagedManifest = path;
      }
      return fsPromises.open(path, ...args);
    },
    async rename(source, destination) {
      if (destination.includes(".backup.tmp") && stagedManifest) {
        ownedRecovery = `${stagedManifest}.owned-recovery`;
        await fsPromises.rename(stagedManifest, ownedRecovery);
        await writeFile(stagedManifest, foreignBytes);
        throw Object.assign(new Error("injected backup failure after staged replacement"), {
          code: "EIO",
        });
      }
      return fsPromises.rename(source, destination);
    },
  });

  await assert.rejects(
    sealEvidencePackage(root, { filesystem: injected }),
    /ownership changed|manual recovery/i,
  );
  assert.equal(await readFile(stagedManifest, "utf8"), foreignBytes);
  assert.equal((await stat(ownedRecovery)).isFile(), true);
  await assertGeneratedBytes(root, previous);
});

test("installed output replacement is preserved instead of deleted during rollback", async (t) => {
  const { previous, root } = await sealedChangedFixture(t);
  const manifestPath = join(root, manifestName);
  const checksumPath = join(root, checksumsName);
  const installedRecovery = join(root, "manifest.installed-owned-recovery.tmp");
  const foreignBytes = "foreign installed-path replacement";
  const injected = filesystem({
    async rename(source, destination) {
      if (destination === checksumPath && !source.includes(".backup.tmp")) {
        await fsPromises.rename(manifestPath, installedRecovery);
        await writeFile(manifestPath, foreignBytes);
        throw Object.assign(new Error("injected checksum failure after installed replacement"), {
          code: "EIO",
        });
      }
      return fsPromises.rename(source, destination);
    },
  });

  await assert.rejects(
    sealEvidencePackage(root, { filesystem: injected }),
    /ownership changed|manual recovery/i,
  );
  assert.equal(await readFile(manifestPath, "utf8"), foreignBytes);
  assert.equal((await stat(installedRecovery)).isFile(), true);
  assert.equal(await readFile(checksumPath, "utf8"), previous.checksums);
  const manifestBackups = (await readdir(root)).filter(
    (name) => name.startsWith(`${manifestName}.`) && name.endsWith(".backup.tmp"),
  );
  assert.equal(manifestBackups.length, 1);
  assert.equal(await readFile(join(root, manifestBackups[0]), "utf8"), previous.manifest);
});

test("backup replacement is preserved instead of restored during rollback", async (t) => {
  const { previous, root } = await sealedChangedFixture(t);
  const manifestPath = join(root, manifestName);
  const checksumPath = join(root, checksumsName);
  const foreignBytes = "foreign backup-path replacement";
  let manifestBackup;
  let backupRecovery;
  const injected = filesystem({
    async rename(source, destination) {
      if (source === manifestPath && destination.includes(".backup.tmp")) {
        manifestBackup = destination;
      }
      if (destination === checksumPath && !source.includes(".backup.tmp")) {
        backupRecovery = `${manifestBackup}.owned-recovery`;
        await fsPromises.rename(manifestBackup, backupRecovery);
        await writeFile(manifestBackup, foreignBytes);
        throw Object.assign(new Error("injected checksum failure after backup replacement"), {
          code: "EIO",
        });
      }
      return fsPromises.rename(source, destination);
    },
  });

  await assert.rejects(
    sealEvidencePackage(root, { filesystem: injected }),
    /ownership changed|manual recovery/i,
  );
  assert.equal(await readFile(manifestBackup, "utf8"), foreignBytes);
  assert.equal(await readFile(backupRecovery, "utf8"), previous.manifest);
  await assert.rejects(stat(manifestPath), { code: "ENOENT" });
  assert.equal(await readFile(checksumPath, "utf8"), previous.checksums);
});

test("backup replacement is preserved instead of deleted during successful cleanup", async (t) => {
  const { previous, root } = await sealedChangedFixture(t);
  const manifestPath = join(root, manifestName);
  const checksumPath = join(root, checksumsName);
  const foreignBytes = "foreign backup cleanup replacement";
  let manifestBackup;
  let backupRecovery;
  const injected = filesystem({
    async rename(source, destination) {
      if (source === manifestPath && destination.includes(".backup.tmp")) {
        manifestBackup = destination;
      }
      const result = await fsPromises.rename(source, destination);
      if (destination === checksumPath && !source.includes(".backup.tmp")) {
        backupRecovery = `${manifestBackup}.owned-recovery`;
        await fsPromises.rename(manifestBackup, backupRecovery);
        await writeFile(manifestBackup, foreignBytes);
      }
      return result;
    },
  });

  await assert.rejects(
    sealEvidencePackage(root, { filesystem: injected }),
    /ownership changed|backup cleanup failed.*manual/i,
  );
  assert.equal(await readFile(manifestBackup, "utf8"), foreignBytes);
  assert.equal(await readFile(backupRecovery, "utf8"), previous.manifest);
});

test("successful enumeration surfaces a directory close failure after closing later handles", async (t) => {
  const root = await packageFixture(t);
  await writeArtifact(root, "photos/duplicates/close-fixture.bin", "close fixture bytes");
  const photosPath = join(root, "photos");
  const duplicatesPath = join(photosPath, "duplicates");
  let injectedCloseFailure = false;
  let ancestorClosedAfterFailure = false;
  let rootClosedAfterFailure = false;
  const injected = filesystem({
    async open(path, ...args) {
      const handle = await fsPromises.open(path, ...args);
      if (![root, photosPath, duplicatesPath].includes(path)) return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property !== "close") {
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return async () => {
            await target.close();
            if (path === duplicatesPath && !injectedCloseFailure) {
              injectedCloseFailure = true;
              throw Object.assign(new Error("injected directory close failure"), { code: "EIO" });
            }
            if (path === photosPath && injectedCloseFailure) ancestorClosedAfterFailure = true;
            if (path === root && injectedCloseFailure) rootClosedAfterFailure = true;
          };
        },
      });
    },
  });

  await assert.rejects(
    listEvidenceFiles(root, { filesystem: injected }),
    /filesystem descriptor cleanup failed/i,
  );
  assert.equal(injectedCloseFailure, true);
  assert.equal(ancestorClosedAfterFailure, true);
  assert.equal(rootClosedAfterFailure, true);
});

test("central CLI error handling bounds and sanitizes injected errors", async () => {
  let cli;
  await assert.doesNotReject(async () => {
    cli = await import("../cli.mjs");
  });
  let stderr = "";
  const exitCode = await cli.runCli({
    action: async () => {
      throw new Error(
        `private bytes\u0000\u001b[31m /private/customer/evidence/${"secret".repeat(100)}`,
      );
    },
    args: [],
    command: "evidence:test",
    expectedArgs: 0,
    stderr: { write: (text) => (stderr += text) },
    stdout: { write: () => undefined },
    usage: "evidence:test",
  });

  assert.equal(exitCode, 1);
  assert.ok(Buffer.byteLength(stderr) <= 320, stderr);
  assert.doesNotMatch(stderr, /private bytes|customer|secret|\u001b|\x1b/i);
  assert.doesNotMatch(stderr.slice(0, -1), /[\u0000-\u001f\u007f]/);
});

async function gitIgnored(relativePath) {
  try {
    await execFile("git", ["check-ignore", "--no-index", "--quiet", relativePath], {
      cwd: repositoryRoot,
    });
    return true;
  } catch (error) {
    if (error?.code === 1) return false;
    throw error;
  }
}

test("customer evidence ignore is anchored to the repository root", async () => {
  assert.equal(await gitIgnored("evidence/INV-20260824-fixture-01/manifest.json"), true);
  assert.equal(await gitIgnored("tools/example/evidence/fixture.txt"), false);
});
