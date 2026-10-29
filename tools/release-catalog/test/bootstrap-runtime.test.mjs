import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, chmod, realpath, readFile, writeFile, rm } from "node:fs/promises";
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
test("runtime waits for exact nonce/binding reply, with exclusive durable requests", async (t) => {
  const root = await fixture(t),
    binding = { operationId: "test", evidenceSha256: "a".repeat(64) };
  const guard = filesystemGuard(root),
    pending = guard(binding);
  const message = await request(root);
  assert.deepEqual(message.binding, binding);
  await writeFile(
    join(root, "1.reply.json"),
    JSON.stringify({ schema: 1, sequence: 1, nonce: message.nonce, binding, approved: true }),
    { mode: 0o400, flag: "wx" },
  );
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
    await writeFile(join(root, "1.reply.json"), JSON.stringify(reply), { mode: 0o400, flag: "wx" });
    await assert.rejects(pending, /bootstrap guard rejected/);
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
