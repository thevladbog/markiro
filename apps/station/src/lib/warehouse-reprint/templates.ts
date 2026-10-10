import { AUTHORIZED_CREDENTIAL_OWNERS_SQL } from "../device-recovery.js";
import { warehouseNetworkUnavailable } from "./sources.js";
import {
  productLabelValueDigest,
  warehouseTemplateCatalogSchema,
  type WarehouseTemplateCatalog,
  type WarehouseTemplate,
} from "@markiro/domain";
import { z } from "zod";
import { StationApiError, type StationClient } from "../api-client.js";
import type { SqlExecutor } from "../mirror.js";

const boxDefaultSchema = z.object({ defaultBoxLabelTemplateId: z.uuid().toLowerCase().nullable() });
const selectedIdsSchema = z.array(z.uuid().toLowerCase()).min(1).max(20);
const offline = () => typeof navigator !== "undefined" && !navigator.onLine;
// An HTTP response carries current server policy; it must never be hidden by a cache hit.
const networkUnavailable = (error: unknown) =>
  !(error instanceof StationApiError) && warehouseNetworkUnavailable(error);

async function readCachedTemplates(
  exec: SqlExecutor,
  owner: string,
  cause?: unknown,
): Promise<WarehouseTemplateCatalog> {
  const [cached] = await exec.all<{ value_json: string }>(
    `SELECT value_json FROM warehouse_reprint_cache WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND kind='templates' AND identity='catalog' ORDER BY rowid DESC LIMIT 1`,
    [owner],
  );
  if (!cached) throw new Error("WAREHOUSE_CATALOG_NETWORK", { cause });
  return warehouseTemplateCatalogSchema.parse(JSON.parse(cached.value_json));
}

async function cacheTemplates(
  exec: SqlExecutor,
  owner: string,
  catalog: WarehouseTemplateCatalog,
): Promise<void> {
  await exec.run(
    "INSERT INTO warehouse_reprint_cache(owner,kind,identity,value_json) VALUES(?,'templates','catalog',?) ON CONFLICT(owner,kind,identity) DO UPDATE SET value_json=excluded.value_json",
    [owner, JSON.stringify(catalog)],
  );
}

export async function loadWarehouseTemplates(
  client: StationClient,
  exec: SqlExecutor,
  owner: string,
): Promise<WarehouseTemplateCatalog> {
  if (offline()) return readCachedTemplates(exec, owner);
  let response: unknown;
  try {
    response = await client.get("/station/warehouse-reprint/templates");
  } catch (error) {
    if (!networkUnavailable(error)) throw error;
    return readCachedTemplates(exec, owner, error);
  }
  const catalog = warehouseTemplateCatalogSchema.parse(response);
  await cacheTemplates(exec, owner, catalog);
  return catalog;
}

/** Refresh fresh-job selections without downloading the entire cabinet catalog per scan. */
export async function refreshWarehouseTemplates(
  client: StationClient,
  exec: SqlExecutor,
  owner: string,
  catalog: WarehouseTemplateCatalog,
  ids: readonly string[],
): Promise<WarehouseTemplateCatalog> {
  const selected = new Set(selectedIdsSchema.parse(ids));
  if (offline()) return readCachedTemplates(exec, owner);
  let response: unknown;
  try {
    response = await client.get(
      `/station/warehouse-reprint/templates?ids=${[...selected].join(",")}`,
    );
  } catch (error) {
    if (!networkUnavailable(error)) throw error;
    return readCachedTemplates(exec, owner, error);
  }
  const fresh = warehouseTemplateCatalogSchema.parse(response);
  if (fresh.templates.some((template) => !selected.has(template.id)))
    throw new Error("WAREHOUSE_TEMPLATE_CATALOG_MISMATCH");
  const replacements = new Map(fresh.templates.filter((t) => t.enabled).map((t) => [t.id, t]));
  const previous = new Set(catalog.templates.map((t) => t.id));
  const templates = [
    ...catalog.templates.flatMap((t) => {
      if (!selected.has(t.id)) return [t];
      const replacement = replacements.get(t.id);
      return replacement ? [replacement] : [];
    }),
    ...fresh.templates.filter((t) => t.enabled && !previous.has(t.id)),
  ];
  const updated = warehouseTemplateCatalogSchema.parse({
    protocol: catalog.protocol,
    revision: productLabelValueDigest(templates),
    templates,
  });
  await cacheTemplates(exec, owner, updated);
  return updated;
}

/** Defaults come from the cabinet picker; only IDs present in the enabled catalog may be used. */
export async function loadWarehouseBoxDefault(
  client: StationClient,
  exec: SqlExecutor,
  owner: string,
): Promise<string | null> {
  const cachedDefault = async () => {
    const [cached] = await exec.all<{ value_json: string }>(
      `SELECT value_json FROM warehouse_reprint_cache WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND kind='templates' AND identity='box-default' ORDER BY rowid DESC LIMIT 1`,
      [owner],
    );
    return cached
      ? boxDefaultSchema.parse(JSON.parse(cached.value_json)).defaultBoxLabelTemplateId
      : null;
  };
  if (offline()) return cachedDefault();
  let response: unknown;
  try {
    response = await client.get("/shifts/box-label-templates");
  } catch (error) {
    if (!networkUnavailable(error)) throw error;
    return cachedDefault();
  }
  const value = boxDefaultSchema.parse(response);
  await exec.run(
    "INSERT INTO warehouse_reprint_cache(owner,kind,identity,value_json) VALUES(?,'templates','box-default',?) ON CONFLICT(owner,kind,identity) DO UPDATE SET value_json=excluded.value_json",
    [owner, JSON.stringify(value)],
  );
  return value.defaultBoxLabelTemplateId;
}

export function resolveWarehouseTemplateSelection(
  catalog: WarehouseTemplateCatalog,
  kind: "unit" | "box",
  previousId: string | null,
  defaultBoxId: string | null,
  chzProductGroupCode?: number | null,
): WarehouseTemplate | null {
  const eligible = catalog.templates.filter(
    (template) =>
      template.enabled &&
      template.purpose === (kind === "box" ? "box" : "product_duplicate") &&
      (chzProductGroupCode === undefined ||
        template.chzProductGroupCodes === null ||
        (chzProductGroupCode !== null &&
          template.chzProductGroupCodes.includes(chzProductGroupCode))),
  );
  return (
    eligible.find((t) => t.id === previousId) ??
    (kind === "box"
      ? eligible.find((t) => t.id === defaultBoxId)
      : eligible.length === 1
        ? eligible[0]
        : null) ??
    null
  );
}
