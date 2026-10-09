import { AUTHORIZED_CREDENTIAL_OWNERS_SQL } from "../device-recovery.js";
import { warehouseNetworkUnavailable } from "./sources.js";
import { warehouseTemplateCatalogSchema, type WarehouseTemplateCatalog } from "@markiro/domain";
import type { StationClient } from "../api-client.js";
import type { SqlExecutor } from "../mirror.js";
export async function loadWarehouseTemplates(
  client: StationClient,
  exec: SqlExecutor,
  owner: string,
): Promise<WarehouseTemplateCatalog> {
  let response: unknown;
  try {
    response = await client.get("/station/warehouse-reprint/templates");
  } catch (error) {
    if (!warehouseNetworkUnavailable(error)) throw error;
    const [cached] = await exec.all<{ value_json: string }>(
      `SELECT value_json FROM warehouse_reprint_cache WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND kind='templates' AND identity='catalog' ORDER BY rowid DESC LIMIT 1`,
      [owner],
    );
    if (!cached) throw new Error("WAREHOUSE_CATALOG_NETWORK", { cause: error });
    return warehouseTemplateCatalogSchema.parse(JSON.parse(cached.value_json));
  }
  const catalog = warehouseTemplateCatalogSchema.parse(response);
  await exec.run(
    "INSERT INTO warehouse_reprint_cache(owner,kind,identity,value_json) VALUES(?,'templates','catalog',?) ON CONFLICT(owner,kind,identity) DO UPDATE SET value_json=excluded.value_json",
    [owner, JSON.stringify(catalog)],
  );
  return catalog;
}
