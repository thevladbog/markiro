import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile, chmod, symlink, link } from "node:fs/promises";
import { appendFileSync } from "node:fs";
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

// Retained history and source closures keep these buffers alive across every
// command boundary. Small records must not each pin the full control-file cap.
test("retained small private documents have a proportional memory budget", async (t) => {
  const { root } = await privateFixture(t);
  const bytes = Buffer.alloc(1024, 37);
  await writePrivateFile(root, "small.json", bytes);
  const retained = [];
  for (let i = 0; i < 32; i++) {
    const actual = await readPrivateFile(root, "small.json");
    assert.deepEqual(actual, bytes);
    retained.push(actual);
  }
  const backingBytes = [...new Set(retained.map((b) => b.buffer))].reduce(
    (sum, buffer) => sum + buffer.byteLength,
    0,
  );
  assert.ok(backingBytes <= 128 * 1024, `small documents retain ${backingBytes} bytes`);
});

for (const growthBytes of [64 * 1024, 1024 * 1024]) {
  test(`private read preserves bounded growth handling (${growthBytes} bytes)`, async (t) => {
    const { root } = await privateFixture(t);
    const initial = Buffer.from("x");
    const growth = Buffer.alloc(growthBytes, 41);
    await writePrivateFile(root, "growing.json", initial);
    const originalAlloc = Buffer.alloc;
    let grew = false;
    // Append after initial metadata has been checked, before the first read.
    const allocation = t.mock.method(Buffer, "alloc", (size, ...args) => {
      const result = originalAlloc(size, ...args);
      if (!grew) {
        grew = true;
        appendFileSync(join(root, "growing.json"), growth);
      }
      return result;
    });
    try {
      if (growthBytes < 1024 * 1024) {
        assert.deepEqual(
          await readPrivateFile(root, "growing.json"),
          Buffer.concat([initial, growth]),
        );
      } else {
        await assert.rejects(readPrivateFile(root, "growing.json"), {
          code: "ERR_HOST_PRIVATE_FILE",
        });
      }
      assert.equal(grew, true);
    } finally {
      allocation.mock.restore();
    }
  });
}
