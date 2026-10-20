import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile, appendFile, symlink, link, readFile } from "node:fs/promises";
import { join } from "node:path";
import { privateFixture } from "./host-fixtures.mjs";
import { publishArchive, hashArchive } from "../backup/files.mjs";

test("streams a private archive larger than metadata limit and publishes exclusively", async (t) => {
  const { root } = await privateFixture(t);
  const source = join(root, "dump.partial");
  await writeFile(source, Buffer.alloc(3 * 1024 * 1024, 7), { mode: 0o600 });
  const result = await publishArchive(root, source, "archive.dump");
  assert.equal(result.bytes, 3 * 1024 * 1024);
  assert.equal((await hashArchive(root, result.path)).sha256, result.sha256);
  await assert.rejects(publishArchive(root, source, "archive.dump"));
  assert.equal((await readFile(result.path)).length, 3 * 1024 * 1024);
  await appendFile(result.path, "x");
  assert.notEqual((await hashArchive(root, result.path)).sha256, result.sha256);
});
test("archive hashing rejects symbolic and hard links and permissive files", async (t) => {
  const { root } = await privateFixture(t);
  const source = join(root, "source");
  await writeFile(source, "PGDMP", { mode: 0o600 });
  await symlink(source, join(root, "symbolic"));
  await assert.rejects(hashArchive(root, join(root, "symbolic")));
  await link(source, join(root, "hard"));
  await assert.rejects(
    hashArchive(root, source),
    (error) => error.code === "ERR_HOST_PRIVATE_FILE" && error.archiveReason === "links",
  );
  await writeFile(join(root, "public"), "PGDMP", { mode: 0o644 });
  await assert.rejects(
    hashArchive(root, join(root, "public")),
    (error) => error.code === "ERR_HOST_PRIVATE_FILE" && error.archiveReason === "mode",
  );
});
