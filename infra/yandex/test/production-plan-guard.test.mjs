import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const script = path.join(root, "infra/yandex/scripts/guard-production-plan.mjs");
const protectedAddresses = [
  "module.compute.yandex_vpc_address.app",
  "module.compute.yandex_compute_instance.app",
  "module.postgres.yandex_mdb_postgresql_cluster.production",
  "module.postgres.yandex_mdb_postgresql_database.application",
  "module.object_storage.yandex_storage_bucket.media",
  "module.object_storage.yandex_storage_bucket.audit",
];

async function withPlan(resourceChanges, callback) {
  const directory = await mkdtemp(path.join(tmpdir(), "markiro-plan-guard-"));
  const plan = path.join(directory, "plan.json");
  try {
    await writeFile(plan, JSON.stringify({ resource_changes: resourceChanges }), { mode: 0o600 });
    return callback(plan);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const change = (address, actions = ["no-op"]) => ({ address, change: { actions } });

test("production plan guard requires every protected address and permits non-destructive changes", async () => {
  await withPlan(
    protectedAddresses.map((address) => change(address)),
    (plan) => {
      execFileSync(process.execPath, [script, plan], { cwd: root, stdio: "pipe" });
    },
  );

  for (const missing of protectedAddresses) {
    await withPlan(
      protectedAddresses.filter((address) => address !== missing).map((address) => change(address)),
      (plan) =>
        assert.throws(() =>
          execFileSync(process.execPath, [script, plan], { cwd: root, stdio: "pipe" }),
        ),
    );
  }
});

test("production plan guard rejects deletion or replacement of every protected address", async () => {
  for (const protectedAddress of protectedAddresses) {
    for (const actions of [["delete"], ["create", "delete"], ["delete", "create"]]) {
      await withPlan(
        protectedAddresses.map((address) =>
          change(address, address === protectedAddress ? actions : ["no-op"]),
        ),
        (plan) =>
          assert.throws(() =>
            execFileSync(process.execPath, [script, plan], { cwd: root, stdio: "pipe" }),
          ),
      );
    }
  }
});
