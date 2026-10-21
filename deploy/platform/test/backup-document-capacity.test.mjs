import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile, chmod, symlink, link } from "node:fs/promises";
import { join } from "node:path";
import { privateFixture } from "./host-fixtures.mjs";
import { readPrivateFile, writePrivateFile } from "../host/files.mjs";

const inventoryCapacity = Object.freeze({ maxBytes: 2 * 1024 * 1024 });
test("inventory capacity accepts the observed production size without expanding default files", async (t) => {
  const { root } = await privateFixture(t);
  const bytes = Buffer.alloc(1051095, 32);
  await writePrivateFile(root, "inventory.json", bytes, inventoryCapacity);
  assert.deepEqual(await readPrivateFile(root, "inventory.json", inventoryCapacity), bytes);
  await assert.rejects(readPrivateFile(root, "inventory.json"));
  await assert.rejects(writePrivateFile(root, "operation.json", bytes));
  await assert.rejects(writePrivateFile(root, "inventory.json", bytes, inventoryCapacity));
});
test("explicit inventory capacity remains bounded and rejects unsafe metadata", async (t) => {
  const { root } = await privateFixture(t);
  const bytes = Buffer.alloc(inventoryCapacity.maxBytes, 32);
  await writePrivateFile(root, "boundary.json", bytes, inventoryCapacity);
  assert.equal(
    (await readPrivateFile(root, "boundary.json", inventoryCapacity)).length,
    bytes.length,
  );
  await writeFile(join(root, "oversized.json"), Buffer.alloc(bytes.length + 1), { mode: 0o600 });
  await assert.rejects(readPrivateFile(root, "oversized.json", inventoryCapacity));
  await assert.rejects(
    writePrivateFile(root, "too-large.json", Buffer.alloc(bytes.length + 1), inventoryCapacity),
  );
  await assert.rejects(readPrivateFile(root, "boundary.json", { maxBytes: Infinity }));
  await assert.rejects(readPrivateFile(root, "boundary.json", { maxBytes: bytes.length + 1 }));
  await assert.rejects(
    readPrivateFile(root, "boundary.json", {
      get maxBytes() {
        throw Error("getter");
      },
    }),
  );
  await chmod(join(root, "boundary.json"), 0o644);
  await assert.rejects(readPrivateFile(root, "boundary.json", inventoryCapacity));
  await chmod(join(root, "boundary.json"), 0o600);
  await symlink(join(root, "boundary.json"), join(root, "symbolic.json"));
  await assert.rejects(readPrivateFile(root, "symbolic.json", inventoryCapacity));
  await link(join(root, "boundary.json"), join(root, "hard.json"));
  await assert.rejects(readPrivateFile(root, "boundary.json", inventoryCapacity));
});
