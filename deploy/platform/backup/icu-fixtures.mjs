/** Disposable synthetic ICU checks. No source/production inventory is rewritten. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonical, digest, completedEvidence } from "./schemas.mjs";
import { createDatabaseBackup } from "./archive.mjs";
import { verifyDatabaseRestore } from "./restore.mjs";
import { publishArchive } from "./files.mjs";
import { createDatabaseSql } from "./locale.mjs";
import { workerRecipe } from "./worker-recipes.mjs";

export async function verifyIcuFixtures({
  root,
  operationId,
  target,
  source,
  cmd,
  document,
  backup,
  roleMapping,
  run,
  imageId,
  buildWorker,
  writerFence,
  onPhase,
}) {
  onPhase("ICU default metadata");
  const locale = document.inventory.objects.find((o) => o.kind === "DATABASE").locale;
  assert.equal(locale.provider, "i");
  assert.equal(locale.icuLocale, "en-US");
  assert.equal(locale.icuRules, null);
  assert.equal(locale.collate, "C");
  assert.equal(locale.ctype, "C");
  assert.equal(locale.collationVersion, locale.actualCollationVersion);
  assert.ok(locale.collationVersion.endsWith(".136"));
  const runtime = JSON.parse(await readFile(join(root, "backup-runtime.json"), "utf8"));
  const sql = async (statement, database = "postgres") =>
    cmd([
      "exec",
      source,
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-h",
      "/var/run/postgresql",
      "-U",
      "postgres",
      "-d",
      database,
      "-c",
      statement,
    ]);
  const customRoot = join(root, "icu-custom");
  await mkdir(customRoot, { mode: 0o700 });
  await writeFile(join(customRoot, "backup-runtime.json"), canonical(runtime), { mode: 0o600 });
  // ICU quoting punctuation is genuine parser input, not forged catalog metadata.
  const rules = "&a < 'b' < '-' < ';'";
  onPhase("ICU custom rules creation");
  await sql(
    createDatabaseSql({
      name: "icu_custom",
      owner: "postgres",
      locale: { ...locale, icuRules: rules },
    }),
  );
  await sql(
    "CREATE TABLE unicode_values(value text); INSERT INTO unicode_values VALUES ('é'),('é'),('Ёж'),('汉字'),('😀'),('a''b'),('-'),(';');",
    "icu_custom",
  );
  for (const name of ["ca.crt", "password"])
    await writeFile(join(customRoot, name), await readFile(join(root, name)), { mode: 0o600 });
  await writeFile(
    join(customRoot, "service.conf"),
    String(await readFile(join(root, "service.conf"))).replace(
      "dbname=markiro",
      "dbname=icu_custom",
    ),
    { mode: 0o600 },
  );
  const connection = JSON.parse(await readFile(join(root, "connection.json"), "utf8"));
  for (const [key, name] of [
    ["serviceFile", "service.conf"],
    ["passFile", "password"],
    ["caFile", "ca.crt"],
  ])
    connection[key] = join(customRoot, name);
  // The synthetic password file must match this second database too.
  await writeFile(
    join(customRoot, "password"),
    String(await readFile(join(root, "password"))).replace(":markiro:", ":icu_custom:"),
    { mode: 0o600 },
  );
  await writeFile(join(customRoot, "connection.json"), canonical(connection), { mode: 0o600 });
  onPhase("ICU custom rules backup");
  const customBackup = await createDatabaseBackup({
    root: customRoot,
    operationId,
    target,
    connectionFile: join(customRoot, "connection.json"),
    writerFence,
    run,
  });
  const customDocument = JSON.parse(await readFile(customBackup.inventoryPath, "utf8"));
  assert.equal(
    customDocument.inventory.objects.find((o) => o.kind === "DATABASE").locale.icuRules,
    rules,
  );
  const customReferences = new Set(customDocument.inventory.roles.map((r) => r.name));
  for (const object of customDocument.inventory.objects) {
    customReferences.add(object.owner);
    for (const acl of object.acl) {
      customReferences.add(acl.grantor);
      if (acl.grantee !== "PUBLIC") customReferences.add(acl.grantee);
    }
  }
  const customMapping = {
    ...roleMapping,
    roles: [...customReferences]
      .sort()
      .map(
        (source) =>
          roleMapping.roles.find((entry) => entry.source === source) ?? { source, target: source },
      ),
  };
  onPhase("ICU custom rules restore");
  const customProof = await verifyDatabaseRestore({
    root: customRoot,
    operationId,
    target,
    backup: customBackup,
    roleMapping: customMapping,
    run,
  });
  completedEvidence(JSON.parse(await readFile(customProof.evidencePath, "utf8")), {
    operationId,
    target,
    ...customBackup,
  });

  onPhase("ICU mismatch Bookworm build");
  const bookworm = await buildWorker(workerRecipe("libc"));
  try {
    onPhase("ICU Bookworm actual version");
    const observed = await cmd([
      "run",
      "--rm",
      "--label",
      `markiro.backup-fixture=${operationId}`,
      "--network",
      "none",
      "--user",
      "999:999",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--read-only",
      "--tmpfs",
      "/work:mode=1777",
      bookworm,
      "sh",
      "-ec",
      "mkdir -m 700 /work/private; initdb -D /work/private/data --locale-provider=icu --icu-locale=en-US --lc-collate=C --lc-ctype=C --encoding=UTF8 >/dev/null 2>&1; pg_ctl -D /work/private/data -l /work/private/server.log -o '-c listen_addresses= -c unix_socket_directories=/work/private' start >/dev/null; psql -X -tA -h /work/private -U postgres -d postgres -c 'SELECT pg_database_collation_actual_version(oid) FROM pg_database WHERE datname=current_database()'; pg_ctl -D /work/private/data stop >/dev/null",
    ]);
    const bookwormVersion = String(observed.stdout).trim();
    assert.equal(bookwormVersion, "153.120");
    onPhase("ICU wrong image binding negative");
    const negativeRoot = join(root, "icu-runtime-mismatch");
    await mkdir(negativeRoot, { mode: 0o700 });
    await writeFile(
      join(negativeRoot, "backup-runtime.json"),
      canonical({ ...runtime, image: bookworm }),
      { mode: 0o600 },
    );
    const wrongArchive = await publishArchive(negativeRoot, backup.archivePath, "database.dump", {
      sourceRoot: root,
    });
    const wrongInventory = join(negativeRoot, "inventory.json");
    await writeFile(wrongInventory, await readFile(backup.inventoryPath), { mode: 0o600 });
    // Production wrong-image binding remains rejected. No validation is relaxed.
    await assert.rejects(
      verifyDatabaseRestore({
        root: negativeRoot,
        operationId,
        target,
        backup: { ...backup, archivePath: wrongArchive.path, inventoryPath: wrongInventory },
        roleMapping,
        run,
      }),
    );
    const wrong = JSON.parse(
      await readFile(join(negativeRoot, `restore-${operationId}`, "failure.json"), "utf8"),
    );
    assert.equal(wrong.cleanup.verified, true);
    assert.equal(wrong.cleanup.resources.length, 0);
    await assert.rejects(readFile(join(negativeRoot, `restore-${operationId}`, "evidence.json")));
    onPhase("ICU natural locale mismatch negative");
    const mismatchRoot = join(root, "icu-natural-mismatch");
    await mkdir(mismatchRoot, { mode: 0o700 });
    await writeFile(
      join(mismatchRoot, "backup-runtime.json"),
      canonical({ ...runtime, image: bookworm }),
      { mode: 0o600 },
    );
    // Local-negative fixture adaptation only: rebind the tested worker image;
    // preserve the genuine locale and archive bytes/hash from Alpine ICU 136.
    const mismatchArchive = await publishArchive(
      mismatchRoot,
      backup.archivePath,
      "database.dump",
      { sourceRoot: root },
    );
    const syntheticDocument = { ...document, runtime: { ...document.runtime, image: bookworm } };
    const bytes = Buffer.from(canonical(syntheticDocument) + "\n");
    const inventoryPath = join(mismatchRoot, "synthetic-inventory.json");
    await writeFile(inventoryPath, bytes, { mode: 0o600 });
    await assert.rejects(
      verifyDatabaseRestore({
        root: mismatchRoot,
        operationId,
        target,
        backup: {
          ...backup,
          archivePath: mismatchArchive.path,
          inventoryPath,
          inventorySha256: digest(bytes),
        },
        roleMapping,
        run,
      }),
    );
    const failure = JSON.parse(
      await readFile(join(mismatchRoot, `restore-${operationId}`, "failure.json"), "utf8"),
    );
    assert.equal(failure.cleanup.verified, true);
    assert.ok(failure.cleanup.resources.length >= 3);
    assert.equal(failure.stage, "locale-compare-ERR_DATABASE_BACKUP");
    await assert.rejects(readFile(join(mismatchRoot, `restore-${operationId}`, "evidence.json")));
  } finally {
    const image = JSON.parse((await cmd(["image", "inspect", bookworm])).stdout)[0];
    assert.equal(image.Id, bookworm);
    assert.equal(image.Config.Labels["markiro.backup-fixture"], operationId);
    await cmd(["image", "rm", bookworm]);
    // Restore the tested ICU recipe before provenance-bound export.
    await buildWorker(workerRecipe("icu"));
  }
  return {
    kind: "synthetic-icu-proof",
    image: imageId,
    storedVersion: locale.collationVersion,
    actualVersion: locale.actualCollationVersion,
    checks: [
      "full default ICU fixture and Unicode roundtrip",
      "genuine custom rules with quoting punctuation roundtrip",
      "wrong image binding rejected unchanged",
      "natural Alpine136 to Bookworm120 mismatch rejected",
      "failure has no completed evidence and cleanup verified",
    ],
    syntheticInventoryAdaptation:
      "negative-only worker image rebinding; genuine locale and archive unchanged",
  };
}
