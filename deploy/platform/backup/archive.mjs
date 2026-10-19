import { join } from "node:path";
import { rm, lstat } from "node:fs/promises";
import { createPrivateDirectory, writePrivateFile, readPrivateFile } from "../host/files.mjs";
import { openRuntime, readPrivateAbsolute, privateCopy } from "./local-runtime.mjs";
import { publishArchive } from "./files.mjs";
import {
  identity,
  plain,
  connection,
  fence,
  canonical,
  digest,
  ensure,
  validateInventory,
  fail,
  validateFencePair,
} from "./schemas.mjs";
export async function createDatabaseBackup({
  root,
  operationId,
  target,
  connectionFile,
  writerFence,
  run,
}) {
  identity(operationId, target);
  target = plain(target);
  ensure(typeof run === "function" && typeof writerFence?.observe === "function");
  const config = connection(
    JSON.parse(await readPrivateAbsolute(root, connectionFile)),
    operationId,
    target,
  );
  const name = `backup-${operationId}`;
  await createPrivateDirectory(root, name);
  const directory = join(root, name);
  await createPrivateDirectory(directory, "input");
  await createPrivateDirectory(directory, "output");
  const input = join(directory, "input"),
    output = join(directory, "output");
  let runtime, cleanup, problem, before, after, result;
  let phase = "connection";
  const startedAt = new Date().toISOString();
  try {
    for (const [field, name] of [
      ["serviceFile", "service.conf"],
      ["passFile", "password"],
      ["caFile", "ca.crt"],
    ])
      await privateCopy(root, config[field], join(input, name));
    await writePrivateFile(input, "request.json", Buffer.from(canonical({ operationId, target })));
    phase = "runtime";
    runtime = await openRuntime({ root, operationId, purpose: "archive", run });
    before = fence(
      await writerFence.observe({ operationId, target, boundary: "before-snapshot" }),
      operationId,
      target,
      "before-snapshot",
    );
    phase = "prepare";
    await runtime.prepare(input, config.network);
    phase = "worker";
    await runtime.execute();
    phase = "fence";
    after = fence(
      await writerFence.observe({ operationId, target, boundary: "after-snapshot" }),
      operationId,
      target,
      "after-snapshot",
    );
    ensure(
      before.fenceId === after.fenceId &&
        before.beganAt === after.beganAt &&
        before.enforcementSha256 === after.enforcementSha256,
    );
    validateFencePair({ before, after }, operationId, target);
    ensure(Date.parse(startedAt) <= Date.parse(before.observedAt));
    phase = "output";
    await runtime.output(output);
    const metadata = await lstat(join(output, "inventory.json"));
    if (metadata.uid !== process.getuid()) throw fail("output-owner");
    if ((metadata.mode & 0o7777) !== 0o600) throw fail("output-mode");
    if (metadata.size > 1048576) throw fail(`inventory-limit-${metadata.size}`);
    const captured = JSON.parse(await readPrivateFile(output, "inventory.json"));
    validateInventory(captured.inventory);
    ensure(
      typeof captured.snapshotId === "string" &&
        /^[A-F0-9-]+$/u.test(captured.snapshotId) &&
        captured.postgresVersion.startsWith("17."),
    );
    const dump = join(output, "database.dump");
    const h = await readFileHeader(dump);
    ensure(h === "PGDMP");
    result = { captured, dump };
  } catch (error) {
    problem = error.stage && error.stage !== "validation" ? error : fail(`${phase}-validation`);
  }
  try {
    cleanup = runtime ? await runtime.cleanup() : { verified: true, resources: [] };
  } catch (error) {
    cleanup = error.cleanup;
    problem = fail("cleanup");
  }
  // Credentials and incomplete worker files are task scratch, never archives.
  await rm(input, { recursive: true, force: true }).catch(() => {
    problem = fail("cleanup");
    if (cleanup) cleanup.verified = false;
  });
  if (problem) {
    await rm(output, { recursive: true, force: true }).catch(() => {
      problem = fail("cleanup");
    });
    await writePrivateFile(
      directory,
      "failure.json",
      Buffer.from(
        canonical({
          version: 1,
          kind: "platform-database-backup",
          status: "recovery-required",
          operationId,
          target,
          stage: problem.stage ?? "backup",
          cleanup: cleanup ?? { verified: false, resources: [] },
        }),
      ),
    );
    throw fail(problem.stage ?? "backup");
  }
  const archive = await publishArchive(directory, result.dump, "database.dump");
  const inventory = {
    version: 1,
    kind: "platform-database-backup",
    operationId,
    target,
    executorSha: runtime.config.executorSha,
    provenance: runtime.config.provenance,
    archiveSha256: archive.sha256,
    archiveBytes: archive.bytes,
    snapshotId: result.captured.snapshotId,
    fence: { before, after },
    startedAt,
    completedAt: new Date().toISOString(),
    runtime: {
      image: runtime.config.image,
      architecture: runtime.architecture,
      postgresVersion: result.captured.postgresVersion,
    },
    inventory: result.captured.inventory,
  };
  const inventoryBytes = Buffer.from(canonical(inventory) + "\n");
  await rm(output, { recursive: true, force: true });
  await writePrivateFile(directory, "inventory.json", inventoryBytes);
  return {
    archivePath: archive.path,
    archiveSha256: archive.sha256,
    inventoryPath: join(directory, "inventory.json"),
    inventorySha256: digest(inventoryBytes),
  };
}
async function readFileHeader(path) {
  const { open } = await import("node:fs/promises");
  const handle = await open(path, "r");
  try {
    const b = Buffer.alloc(5);
    await handle.read(b, 0, 5, 0);
    return b.toString();
  } finally {
    await handle.close();
  }
}
