import { z } from "zod";
import {
  PALLET_REPRINT_V2_PROTOCOL,
  palletTemplateCatalogV2Schema,
  type PalletTemplateCatalogV2,
} from "@markiro/domain";
import type { SqlExecutor } from "../mirror.js";
import { StationApiError, type StationClient } from "../api-client.js";
import { AUTHORIZED_CREDENTIAL_OWNERS_SQL } from "../device-recovery.js";
import { warehouseNetworkUnavailable } from "./sources.js";
export async function loadPalletTemplates(
  client: Pick<StationClient, "get">,
  exec: SqlExecutor,
  owner: string,
  requiredProtocol: string = PALLET_REPRINT_V2_PROTOCOL,
): Promise<PalletTemplateCatalogV2 | null> {
  const cacheIdentity = requiredProtocol === PALLET_REPRINT_V2_PROTOCOL ? "pallet-v2" : "pallet-v3";
  try {
    if (typeof navigator !== "undefined" && !navigator.onLine)
      throw new TypeError("Failed to fetch");
    const caps = z
      .strictObject({ protocols: z.array(z.string()) })
      .parse(await client.get("/station/warehouse-reprint/source-capabilities"));
    if (!caps.protocols.includes(requiredProtocol)) return null;
    const catalog = palletTemplateCatalogV2Schema.parse(
      await client.get("/station/warehouse-reprint/pallet-templates-v2"),
    );
    await exec.run(
      "INSERT INTO warehouse_reprint_cache(owner,kind,identity,value_json) VALUES(?,'templates',?,?) ON CONFLICT(owner,kind,identity) DO UPDATE SET value_json=excluded.value_json",
      [owner, cacheIdentity, JSON.stringify(catalog)],
    );
    return catalog;
  } catch (e) {
    if (e instanceof StationApiError && e.status === 404) return null;
    if (!warehouseNetworkUnavailable(e)) throw e;
    const [row] = await exec.all<{ value_json: string }>(
      `SELECT value_json FROM warehouse_reprint_cache WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND kind='templates' AND identity=? ORDER BY rowid DESC LIMIT 1`,
      [owner, cacheIdentity],
    );
    return row ? palletTemplateCatalogV2Schema.parse(JSON.parse(row.value_json)) : null;
  }
}
