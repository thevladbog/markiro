import { expect, it, vi } from "vitest";
import { productLabelValueDigest, warehouseBoxSource, warehouseBoxTemplate } from "@markiro/domain";
import { renderWarehouseLabel } from "../src/lib/warehouse-reprint/prepare";
import { warehousePreparedJobInput } from "./support/warehouse-reprint";
it("renders corrected SSCC in TSPL and ZPL at both DPIs with frozen fields", async () => {
  for (const language of ["tspl", "zpl"] as const)
    for (const dpi of [203, 300] as const) {
      const source = warehouseBoxSource();
      const printer = { ...warehousePreparedJobInput().printer, language, dpi };
      const out = await renderWarehouseLabel(source, warehouseBoxTemplate(), printer, async () => ({
        width: 8,
        height: 8,
        hex: "0000000000000000",
        totalBytes: 8,
        bytesPerRow: 1,
      }));
      expect(out.fields.date).toBe(source.fields.date);
      expect(out.fields.expiry).toBe(source.fields.expiry);
      expect(atob(out.bytesBase64)).not.toContain("!100");
      expect(atob(out.bytesBase64)).toContain(language === "tspl" ? '"EAN128"' : "^BC");
    }
});
it("denies incompatible purpose/group, unknown DPI and missing historical fields", async () => {
  const source = warehouseBoxSource();
  const t = warehouseBoxTemplate();
  const p = warehousePreparedJobInput().printer;
  const raster = async () => ({
    width: 8,
    height: 8,
    hex: "0000000000000000",
    totalBytes: 8,
    bytesPerRow: 1,
  });
  await expect(renderWarehouseLabel(source, t, { ...p, dpi: null }, raster)).rejects.toThrow(
    "WAREHOUSE_PRINTER_DPI",
  );
  const missing = { ...source, unavailableFields: ["date" as const] };
  const { revision: _revision, ...snapshot } = missing;
  void _revision;
  await expect(
    renderWarehouseLabel(
      { ...snapshot, revision: productLabelValueDigest(snapshot) },
      t,
      p,
      raster,
    ),
  ).rejects.toThrow("WAREHOUSE_SOURCE_FIELDS");
});
it("rejects group and purpose mismatches even with recomputed valid template digest", async () => {
  const source = warehouseBoxSource();
  const t = warehouseBoxTemplate();
  const p = warehousePreparedJobInput().printer;
  const raster = async () => ({
    width: 8,
    height: 8,
    hex: "0000000000000000",
    totalBytes: 8,
    bytesPerRow: 1,
  });
  const { digest, ...restricted } = { ...t, chzProductGroupCodes: [999] };
  void digest;
  await expect(
    renderWarehouseLabel(
      source,
      { ...restricted, digest: productLabelValueDigest(restricted) },
      p,
      raster,
    ),
  ).rejects.toThrow("WAREHOUSE_TEMPLATE_GROUP");
});

it("rasterizes ASCII frozen values as well as Cyrillic in newly prepared warehouse bytes", async () => {
  const source = warehouseBoxSource();
  const raster = vi.fn(async (_text: string) => ({
    width: 8,
    height: 1,
    hex: "80",
    totalBytes: 1,
    bytesPerRow: 1,
  }));
  const rendered = await renderWarehouseLabel(
    source,
    warehouseBoxTemplate(),
    warehousePreparedJobInput().printer,
    raster,
  );
  expect(raster.mock.calls.map(([text]) => text)).toContain(source.fields.date);
  expect(atob(rendered.bytesBase64)).not.toContain("TEXT ");
  expect(atob(rendered.bytesBase64)).toContain("BITMAP ");
});
