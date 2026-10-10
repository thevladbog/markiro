import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildWarehouseCodeOnlyLabelTemplate,
  productLabelValueDigest,
  warehouseBoxTemplate,
  warehouseTemplateSchema,
  WAREHOUSE_REPRINT_PROTOCOL,
  type WarehouseTemplate,
  type WarehouseTemplateCatalog,
} from "@markiro/domain";
import { StationApiError, type StationClient } from "../src/lib/api-client";
import { applyMigrations } from "../src/lib/mirror";
import { makeRotatingExec } from "./support/sqlite-exec";
import * as templates from "../src/lib/warehouse-reprint/templates";

function template(changes: Partial<WarehouseTemplate> = {}): WarehouseTemplate {
  const { digest, ...value } = { ...warehouseBoxTemplate(), ...changes };
  void digest;
  return warehouseTemplateSchema.parse({ ...value, digest: productLabelValueDigest(value) });
}
function catalog(values: WarehouseTemplate[]): WarehouseTemplateCatalog {
  return {
    protocol: WAREHOUSE_REPRINT_PROTOCOL,
    revision: productLabelValueDigest(values),
    templates: values,
  };
}
function station(get: ReturnType<typeof vi.fn>): StationClient {
  return { get } as unknown as StationClient;
}

describe("warehouse enabled template choices", () => {
  const unit = () =>
    template({
      id: crypto.randomUUID(),
      purpose: "product_duplicate",
      spec: buildWarehouseCodeOnlyLabelTemplate().spec,
    });

  it("uses the valid cabinet box default and keeps an explicit enabled prior choice", () => {
    const first = template({ id: crypto.randomUUID() });
    const cabinet = template({ id: crypto.randomUUID() });
    const values = catalog([first, cabinet]);
    expect(templates.resolveWarehouseTemplateSelection(values, "box", null, cabinet.id)?.id).toBe(
      cabinet.id,
    );
    expect(
      templates.resolveWarehouseTemplateSelection(values, "box", first.id, cabinet.id)?.id,
    ).toBe(first.id);
    expect(
      templates.resolveWarehouseTemplateSelection(values, "box", null, crypto.randomUUID()),
    ).toBeNull();
  });

  it("retains a valid unit choice or picks the sole enabled compatible candidate", () => {
    const first = unit();
    const second = unit();
    expect(
      templates.resolveWarehouseTemplateSelection(catalog([first, second]), "unit", first.id, null)
        ?.id,
    ).toBe(first.id);
    expect(
      templates.resolveWarehouseTemplateSelection(catalog([first, second]), "unit", null, null),
    ).toBeNull();
    expect(
      templates.resolveWarehouseTemplateSelection(
        catalog([template({ ...second, enabled: false }), first]),
        "unit",
        second.id,
        null,
      )?.id,
    ).toBe(first.id);
    const restricted = template({ ...second, chzProductGroupCodes: [4] });
    expect(
      templates.resolveWarehouseTemplateSelection(
        catalog([first, restricted]),
        "unit",
        null,
        null,
        5,
      )?.id,
    ).toBe(first.id);
    expect(
      templates.resolveWarehouseTemplateSelection(catalog([restricted]), "unit", null, null, null),
    ).toBeNull();
  });
});

describe("warehouse catalog freshness and defaults cache", () => {
  let db: DatabaseSync;
  let exec: ReturnType<typeof makeRotatingExec>;
  beforeEach(async () => {
    db = new DatabaseSync(":memory:");
    exec = makeRotatingExec([db, db]);
    await applyMigrations(exec);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it("refreshes only selected ids, removes a disabled selection and retains the full picker cache", async () => {
    const first = template({ id: crypto.randomUUID(), name: "Before" });
    const disabled = template({ id: crypto.randomUUID() });
    const retained = template({ id: crypto.randomUUID() });
    const current = template({ ...first, name: "Cabinet update", revision: "b".repeat(64) });
    const initial = catalog([first, disabled, retained]);
    const get = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(catalog([current]));
    const client = station(get);
    await templates.loadWarehouseTemplates(client, exec, "owner");
    const result = await templates.refreshWarehouseTemplates(client, exec, "owner", initial, [
      first.id,
      disabled.id,
    ]);
    expect(get.mock.calls[1]?.[0]).toBe(
      `/station/warehouse-reprint/templates?ids=${first.id},${disabled.id}`,
    );
    expect(result.templates).toEqual([current, retained]);
    get.mockRejectedValue(new TypeError("offline"));
    expect(await templates.loadWarehouseTemplates(client, exec, "owner")).toEqual(result);
    expect(first.name).toBe("Before");
  });

  it("uses only the owner's last enabled catalog offline and never falls back for auth/server denial", async () => {
    const selected = template({ id: crypto.randomUUID() });
    const original = catalog([selected]);
    const get = vi.fn().mockResolvedValue(original);
    const client = station(get);
    await templates.loadWarehouseTemplates(client, exec, "owner");
    get.mockRejectedValue(new TypeError("offline"));
    expect(
      await templates.refreshWarehouseTemplates(client, exec, "owner", catalog([]), [selected.id]),
    ).toEqual(original);
    await expect(
      templates.refreshWarehouseTemplates(client, exec, "foreign", original, [selected.id]),
    ).rejects.toThrow("WAREHOUSE_CATALOG_NETWORK");
    for (const status of [401, 403, 500, 502, 503, 504]) {
      const denied = new StationApiError(status, "denied");
      get.mockRejectedValue(denied);
      await expect(
        templates.refreshWarehouseTemplates(client, exec, "owner", original, [selected.id]),
      ).rejects.toBe(denied);
    }
  });

  it("honors explicit offline mode without attempting a template/default request", async () => {
    const box = template();
    const get = vi
      .fn()
      .mockResolvedValueOnce(catalog([box]))
      .mockResolvedValueOnce({
        items: [],
        defaultBoxLabelTemplateId: box.id,
        defaultSource: "organization",
      });
    const client = station(get);
    await templates.loadWarehouseTemplates(client, exec, "owner");
    await templates.loadWarehouseBoxDefault(client, exec, "owner");
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    get.mockClear();
    expect(await templates.loadWarehouseTemplates(client, exec, "owner")).toEqual(catalog([box]));
    expect(await templates.loadWarehouseBoxDefault(client, exec, "owner")).toBe(box.id);
    expect(get).not.toHaveBeenCalled();
  });

  it("loads the existing cabinet organization default and caches a cleared default", async () => {
    const box = template();
    const get = vi.fn().mockResolvedValue({
      items: [],
      defaultBoxLabelTemplateId: box.id,
      defaultSource: "organization",
    });
    const client = station(get);
    expect(await templates.loadWarehouseBoxDefault(client, exec, "owner")).toBe(box.id);
    expect(get.mock.calls[0]?.[0]).toBe("/shifts/box-label-templates");
    get.mockResolvedValue({ items: [], defaultBoxLabelTemplateId: null, defaultSource: null });
    expect(await templates.loadWarehouseBoxDefault(client, exec, "owner")).toBeNull();
    get.mockRejectedValue(new TypeError("offline"));
    expect(await templates.loadWarehouseBoxDefault(client, exec, "owner")).toBeNull();
    expect(await templates.loadWarehouseBoxDefault(client, exec, "foreign")).toBeNull();
    for (const status of [401, 403, 500, 502, 503, 504]) {
      const denied = new StationApiError(status, "denied");
      get.mockRejectedValue(denied);
      await expect(templates.loadWarehouseBoxDefault(client, exec, "owner")).rejects.toBe(denied);
    }
  });

  it("does not treat an invalid successful server response as offline cached data", async () => {
    const selected = template();
    const initial = catalog([selected]);
    const get = vi.fn().mockResolvedValue(initial);
    const client = station(get);
    await templates.loadWarehouseTemplates(client, exec, "owner");
    get.mockResolvedValue({ ...initial, protocol: "different" });
    await expect(
      templates.refreshWarehouseTemplates(client, exec, "owner", initial, [selected.id]),
    ).rejects.toThrow();
    get.mockResolvedValue({ items: [], defaultBoxLabelTemplateId: "not-a-uuid" });
    await expect(templates.loadWarehouseBoxDefault(client, exec, "owner")).rejects.toThrow();
  });

  it("rejects an unrelated filtered response without altering the last enabled catalog", async () => {
    const selected = template();
    const initial = catalog([selected]);
    const get = vi.fn().mockResolvedValue(initial);
    const client = station(get);
    await templates.loadWarehouseTemplates(client, exec, "owner");
    get.mockResolvedValue(catalog([template({ id: crypto.randomUUID() })]));
    await expect(
      templates.refreshWarehouseTemplates(client, exec, "owner", initial, [selected.id]),
    ).rejects.toThrow("WAREHOUSE_TEMPLATE_CATALOG_MISMATCH");
    get.mockRejectedValue(new TypeError("offline"));
    expect(await templates.loadWarehouseTemplates(client, exec, "owner")).toEqual(initial);
  });
});
