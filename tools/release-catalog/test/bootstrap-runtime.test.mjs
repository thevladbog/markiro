import test from "node:test";
import assert from "node:assert/strict";
import { constants, linkSync, unlinkSync } from "node:fs";
import { mkdtemp, chmod, realpath, readFile, open, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filesystemGuard } from "../bootstrap-runtime.mjs";
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bootstrap-rpc-")));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true }));
  return root;
}
async function request(root) {
  for (let n = 0; n < 200; n++) {
    try {
      return JSON.parse(await readFile(join(root, "1.request.json"), "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  throw Error("request absent");
}
async function publishReply(root, value, beforePublish = async () => {}) {
  const temporary = join(root, `${randomUUID()}.reply.tmp`),
    destination = join(root, "1.reply.json");
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value) + "\n");
      await file.sync();
      await file.chmod(0o400);
      await file.sync();
    } finally {
      await file.close();
    }
    await beforePublish();
    // Do not yield while the published inode still has the staging link:
    // readPrivate requires a single link as well as complete, immutable bytes.
    linkSync(temporary, destination);
    unlinkSync(temporary);
    const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
test("runtime waits for exact nonce/binding reply, with exclusive durable requests", async (t) => {
  const root = await fixture(t),
    binding = { operationId: "test", evidenceSha256: "a".repeat(64) };
  const guard = filesystemGuard(root),
    pending = guard(binding);
  const message = await request(root);
  assert.deepEqual(message.binding, binding);
  const value = { schema: 1, sequence: 1, nonce: message.nonce, binding, approved: true };
  await publishReply(root, value, async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(readFile(join(root, "1.reply.json")), (e) => e.code === "ENOENT");
  });
  await pending;
  await assert.rejects(filesystemGuard(root)(binding), (e) => e.code === "EEXIST");
});
for (const mutation of ["nonce", "binding", "denied"])
  test(`runtime refuses ${mutation} response`, async (t) => {
    const root = await fixture(t),
      binding = { operationId: "test" };
    const pending = filesystemGuard(root)(binding),
      message = await request(root);
    const reply = { schema: 1, sequence: 1, nonce: message.nonce, binding, approved: true };
    if (mutation === "nonce") reply.nonce = "wrong";
    if (mutation === "binding") reply.binding = { operationId: "other" };
    if (mutation === "denied") reply.approved = false;
    await Promise.all([
      assert.rejects(pending, /bootstrap guard rejected/),
      publishReply(root, reply),
    ]);
  });

test("database connectivity preflight enforces the existing verified TLS URL and makes only a read-only query", async () => {
  const { probeBootstrapDatabase } = await import("../bootstrap-runtime.mjs");
  const calls = [],
    pool = {
      connect: async () => ({
        query: async (sql) => calls.push(sql),
        release: () => calls.push("release"),
      }),
    };
  const url =
    "postgres://example@postgres/markiro?sslmode=verify-full&sslrootcert=/run/markiro-postgres/ca.crt";
  await probeBootstrapDatabase(pool, url);
  assert.deepEqual(calls, ["BEGIN READ ONLY", "SELECT 1", "ROLLBACK", "release"]);
  await assert.rejects(probeBootstrapDatabase(pool, url.replace("verify-full", "require")));
  const failing = {
    connect: async () => {
      throw Error("CA unavailable");
    },
  };
  await assert.rejects(probeBootstrapDatabase(failing, url), /CA unavailable/);
});
