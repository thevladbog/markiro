import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  renderShiftExport,
  renderPalletAggregationExport,
  SHIFT_EXPORT_FORMATS,
  renderPalletPlacardHtml,
} from "@markiro/domain";
import { shiftExportRowsSchema } from "../src/host/protocol.js";
import { cloudPalletRowsSchema } from "../src/host/cloud-history-read.js";
import { runExport, runCloudPalletExport } from "../src/office/exports/run-export.js";
import { cloudPalletPlacardData } from "../src/office/forms/cloud-form-data.js";
import { disaggregationLineSchema } from "../src/host/disaggregation.js";

// The Rust route suite asserts these exact response objects after importing request.
const testModuleUrl = import.meta.url;
const fixture = z
  .object({
    request: z.object({ manifest: z.object({ exportedAt: z.iso.datetime({ offset: true }) }) }),
    exportSources: z.array(shiftExportRowsSchema),
    palletSources: z.array(cloudPalletRowsSchema),
    nullCloseExportSource: shiftExportRowsSchema,
  })
  .parse(
    JSON.parse(
      readFileSync(new URL("../proto/fixtures/cloud-history-read.json", testModuleUrl), "utf8"),
    ),
  );
const run = {
  documentId: "70000000-0000-4000-8000-000000000002",
  formedAt: "2026-10-17T12:00:00.000Z",
  maxLines: null,
  palletId: null,
};

describe("imported report source to real domain files", () => {
  it("freezes a missing close to the snapshot while generation dates and document IDs change", () => {
    const source = fixture.nullCloseExportSource;
    expect(source.shift.closedAt).toBeNull();
    expect(source.shift.stationClosedAt).toBeNull();
    const documents = [
      { formedAt: "2026-10-18T12:00:00.000Z", documentId: "70000000-0000-4000-8000-000000000018" },
      { formedAt: "2026-10-19T12:00:00.000Z", documentId: "70000000-0000-4000-8000-000000000019" },
    ];
    for (const document of documents) {
      const result = runExport(source, {
        ...run,
        ...document,
        formatId: "shift_xml_gismt_aggregation_pallets",
        formatVersion: 1,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.failure);
      const xml = Buffer.from(result.parts[0]?.bytes ?? []).toString("utf8");
      expect(xml).toContain(`operation_date_time="${fixture.request.manifest.exportedAt}"`);
      expect(xml).toContain(`file_date_time="${document.formedAt}"`);
      expect(xml).toContain(`document_id="${document.documentId}"`);
    }
  });
  it("keeps explicit imported line provenance from the real route fixture", () => {
    const raw: unknown = JSON.parse(
      readFileSync(
        new URL("../proto/fixtures/cloud-history-disaggregation-line.json", testModuleUrl),
        "utf8",
      ),
    );
    const line = disaggregationLineSchema.parse(raw);
    expect(line.cloudHistory).toBe(true);
    expect(line).toEqual(raw);
  });
  it.each(SHIFT_EXPORT_FORMATS)(
    "renders $id with cloud grouping and full canonical text",
    (format) => {
      const rows = fixture.exportSources[0];
      if (rows === undefined) throw new Error("fixture");
      const codesByHash = new Map(rows.codes.map((c) => [c.codeHash, c.canonical]));
      const boxes = rows.boxes
        .map((box) => ({
          sscc: box.sscc ?? "",
          codes: rows.items
            .filter((item) => item.boxId === box.id)
            .map((item) => codesByHash.get(item.codeHash) ?? ""),
        }))
        .sort((a, b) => a.sscc.localeCompare(b.sscc));
      const first = boxes[0],
        warehouse = boxes[1],
        second = boxes[2];
      if (first === undefined || second === undefined || warehouse === undefined)
        throw new Error("fixture boxes");
      const p1 = rows.pallets[0],
        p2 = rows.pallets[1];
      if (p1?.sscc == null || p2?.sscc == null) throw new Error("fixture pallets");
      const source =
        format.boxMode === "flat"
          ? { mode: "flat" as const, codes: rows.codes.map((c) => c.canonical) }
          : format.boxMode === "boxes"
            ? { mode: "boxes" as const, boxes }
            : {
                mode: "pallets" as const,
                pallets: [
                  { sscc: p1.sscc, boxes: [first] },
                  { sscc: p2.sscc, boxes: [second] },
                ],
                looseBoxes: [warehouse],
              };
      const expected = renderShiftExport({
        formatId: format.id,
        formatVersion: format.version,
        productName: "Milk",
        shiftDate: "2026-10-16",
        maxLines: null,
        source,
        organizationInn: format.extension === "xml" ? rows.organization.inn : null,
        organizationName: format.extension === "xml" ? rows.organization.name : null,
        document: {
          documentId: run.documentId,
          documentNumber: "OCT26-007/S",
          fileDateTime: run.formedAt,
          operationDateTime: "2026-10-16T11:30:00.123Z",
        },
      });
      const result = runExport(rows, {
        ...run,
        formatId: format.id,
        formatVersion: format.version,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.parts).toEqual(expected);
        if (format.id === "shift_xml_gismt_aggregation_pallets")
          expect(Buffer.from(result.parts[0]?.bytes ?? [])).toEqual(
            readFileSync(new URL("../proto/fixtures/cloud-history-export.xml", testModuleUrl)),
          );
      }
    },
  );
  it("flat-only reprocessing makes TXT/CSV without an aggregation owner", () => {
    const rows = fixture.exportSources[1];
    if (rows === undefined) throw new Error("fixture");
    expect(rows.codes[0]?.flatOnly).toBe(true);
    for (const id of ["shift_txt_flat", "shift_csv_flat"]) {
      const result = runExport(rows, { ...run, formatId: id, formatVersion: 1 });
      expect(result.ok).toBe(true);
    }
    expect(
      runExport(rows, { ...run, formatId: "shift_xml_gismt_aggregation", formatVersion: 1 }),
    ).toEqual({ ok: false, failure: "SHIFT_HAS_NO_CODES" });
  });
  it("warehouse XML crosses shifts and placard preserves each declared date", () => {
    const rows = fixture.palletSources[1];
    if (rows === undefined) throw new Error("fixture");
    expect(rows.boxes.map((box) => box.productionDate)).toEqual(["2026-10-16", null]);
    const formatId = "pallet_xml_gismt_aggregation";
    const result = runCloudPalletExport(rows, {
      ...run,
      formatId,
      formatVersion: 1,
      palletId: rows.pallet.id,
    });
    const expected = renderPalletAggregationExport({
      formatId,
      formatVersion: 1,
      organizationInn: rows.organization.inn,
      organizationName: rows.organization.name,
      productName: "Frozen warehouse product",
      closedDate: "2026-10-16",
      documentId: run.documentId,
      fileDateTime: run.formedAt,
      operationDateTime: "2026-10-16T10:00:00.000Z",
      pallet: {
        sscc: rows.pallet.sscc ?? "",
        boxSsccs: rows.boxes.map((box) => box.pack.sscc ?? ""),
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.parts).toEqual([expected]);
    const data = cloudPalletPlacardData(rows);
    expect(data?.shelfLifeDays).toBe(15);
    expect(data?.boxes[1]?.productionDate).toBeNull();
    if (data === null) throw new Error("fixture placard");
    expect(renderPalletPlacardHtml(data, "a4")).toContain("См. на продукции");
  });
});

it("keeps cloud form times in the original zone after the local organization changes zone", async () => {
  const { renderForm } = await import("../src/office/forms/render-form.js");
  const { boxReportRowsSchema } = await import("../src/host/protocol.js");
  const original = JSON.parse(
    readFileSync(new URL("../proto/fixtures/box-report-rows.json", testModuleUrl), "utf8"),
  ) as Record<string, unknown>;
  const rows = boxReportRowsSchema.parse({
    ...original,
    organization: { name: "Frozen", inn: null, timeZone: "Europe/Moscow" },
  });
  const changed = renderForm({ kind: "box", rows, timeZone: "America/New_York" });
  const source = renderForm({ kind: "box", rows, timeZone: "Europe/Moscow" });
  expect(changed?.html).toBe(source?.html);
});

it("gives a fixed source refusal for an unsupported frozen form zone instead of native fallback", async () => {
  const { renderForm } = await import("../src/office/forms/render-form.js");
  const { boxReportRowsSchema } = await import("../src/host/protocol.js");
  const original = JSON.parse(
    readFileSync(new URL("../proto/fixtures/box-report-rows.json", testModuleUrl), "utf8"),
  ) as Record<string, unknown>;
  const rows = boxReportRowsSchema.parse({
    ...original,
    organization: { name: "Frozen", inn: null, timeZone: "Mars/Base" },
  });
  expect(() => renderForm({ kind: "box", rows, timeZone: "Europe/Moscow" })).toThrow(
    "history_time_zone_unsupported",
  );
  expect(rows.organization.timeZone).toBe("Mars/Base");
});
