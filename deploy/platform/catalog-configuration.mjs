import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { canonical, ensure } from "./backup/schemas.mjs";
import {
  readConfigurationHead,
  resolveBoundConfigurationRuntime,
} from "./host/configuration-source.mjs";

/** Called under the shared host lock and again at each catalog source boundary. */
export async function verifyCatalogConfigurationSource(operation, stateRoot) {
  try {
    await lstat(join(stateRoot, "config-pending.json"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (operation.schema === 1) {
      ensure((await readConfigurationHead(stateRoot)) === null);
      return;
    }
    ensure(operation.schema === 2);
    const selected = await resolveBoundConfigurationRuntime({
      root: stateRoot,
      baseline: operation.configuration.baseline,
      expectedHead: operation.configuration.head,
    });
    ensure(selected.acceptedOperationId === operation.acceptedOperationId);
    ensure(canonical(selected.api) === canonical(operation.containers.api));
    ensure(canonical(selected.runtime) === canonical(operation.configuration.runtime));
    return;
  }
  throw new Error("Catalog configuration operation is pending.");
}
