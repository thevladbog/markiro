import { readFile } from "node:fs/promises";
import process from "node:process";

const protectedAddresses = new Set([
  "module.compute.yandex_vpc_address.app",
  "module.compute.yandex_compute_instance.app",
  "module.postgres.yandex_mdb_postgresql_cluster.production",
  "module.postgres.yandex_mdb_postgresql_database.application",
  "module.object_storage.yandex_storage_bucket.media",
  "module.object_storage.yandex_storage_bucket.audit",
]);

export function guardProductionPlan(plan) {
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.resource_changes))
    throw new Error("production plan rejected");

  const seen = new Set();
  for (const resource of plan.resource_changes) {
    if (!resource || typeof resource !== "object" || typeof resource.address !== "string")
      throw new Error("production plan rejected");
    if (!protectedAddresses.has(resource.address)) continue;
    if (seen.has(resource.address)) throw new Error("production plan rejected");
    const actions = resource.change?.actions;
    if (!Array.isArray(actions) || actions.some((action) => typeof action !== "string"))
      throw new Error("production plan rejected");
    if (actions.includes("delete")) throw new Error("production plan rejected");
    seen.add(resource.address);
  }

  if (seen.size !== protectedAddresses.size) throw new Error("production plan rejected");
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    if (process.argv.length !== 3) throw new Error();
    guardProductionPlan(JSON.parse(await readFile(process.argv[2], "utf8")));
  } catch {
    process.stderr.write("production plan rejected\n");
    process.exitCode = 1;
  }
}
