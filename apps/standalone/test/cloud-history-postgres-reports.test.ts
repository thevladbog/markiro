import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { boxReportRowsSchema, shiftExportRowsSchema } from "../src/host/protocol.js";
import { cloudPalletRowsSchema } from "../src/host/cloud-history-read.js";
import { runCloudPalletExport, runExport } from "../src/office/exports/run-export.js";

// The Rust PostgreSQL seam invokes this with actual HTTP DTOs, never a curated fixture.
const directory = process.env.STANDALONE_HISTORY_ACCEPTANCE_OUT;
it.skipIf(directory === undefined)(
  "renders actual PostgreSQL-to-host final states and refuses a retired pallet",
  () => {
    if (directory === undefined) throw new Error("dedicated PostgreSQL seam output required");
    const input: unknown = JSON.parse(readFileSync(join(directory, "dto.json"), "utf8"));
    const data = z
      .object({
        before: shiftExportRowsSchema,
        after: shiftExportRowsSchema.optional(),
        retiredPallet: cloudPalletRowsSchema,
        livePallet: cloudPalletRowsSchema,
        boxReport: boxReportRowsSchema,
      })
      .parse(input);
    const options = {
      documentId: "70000000-0000-4000-8000-000000000092",
      formedAt: "2026-10-18T12:00:00.000Z",
      maxLines: null,
      palletId: null,
      formatId: "shift_xml_gismt_aggregation",
      formatVersion: 1,
    };
    const source = data.before;
    expect(source.boxes).toHaveLength(4);
    expect(source.boxes.every((box) => box.palletId !== null)).toBe(true);
    expect(source.codes).toHaveLength(2);
    expect(data.boxReport.openedAt).toContain("+00:00");
    expect(data.boxReport.closedAt).toBe("2026-10-16T11:00:00+00:00");
    expect(
      boxReportRowsSchema.safeParse({ ...data.boxReport, closedAt: "yesterday" }).success,
    ).toBe(false);
    expect(
      shiftExportRowsSchema.safeParse({
        ...source,
        shift: { ...source.shift, closedAt: "2026-10-16T09:00:00" },
      }).success,
    ).toBe(false);
    const report = runExport(source, options);
    expect(report.ok).toBe(true);
    if (!report.ok) throw new Error(report.failure);
    expect(report.parts).toHaveLength(1);
    const part = report.parts[0];
    if (part === undefined) throw new Error("missing generated part");
    const xml = Buffer.from(part.bytes).toString("utf8");
    expect(xml).toContain('operation_date_time="2026-10-16T09:00:00.000Z"');
    for (const box of source.boxes) {
      if (box.sscc === null) throw new Error("fixture closed box");
      if (box.disassembledAt === null) expect(xml).toContain(box.sscc);
      else expect(xml).not.toContain(box.sscc);
    }
    const retired = runCloudPalletExport(data.retiredPallet, {
      ...options,
      palletId: data.retiredPallet.pallet.id,
      formatId: "pallet_xml_gismt_aggregation",
    });
    expect(retired).toMatchObject({ ok: false, failure: "PALLET_DISASSEMBLED" });
    const live = runCloudPalletExport(data.livePallet, {
      ...options,
      palletId: data.livePallet.pallet.id,
      formatId: "pallet_xml_gismt_aggregation",
    });
    expect(live.ok).toBe(true);
    if (!live.ok) throw new Error(live.failure);
    const liveXml = Buffer.from(live.parts[0]?.bytes ?? []).toString("utf8");
    for (const box of data.livePallet.boxes) {
      if (box.pack.sscc === null) throw new Error("fixture closed box");
      if (box.pack.disassembledAt === null) expect(liveXml).toContain(box.pack.sscc);
      else expect(liveXml).not.toContain(box.pack.sscc);
    }
    writeFileSync(join(directory, "generated.xml"), part.bytes);
    if (data.after !== undefined) {
      const next = runExport(data.after, options);
      expect(next.ok).toBe(true);
      if (!next.ok) throw new Error(next.failure);
      const nextXml = Buffer.from(next.parts[0]?.bytes ?? []).toString("utf8");
      expect(data.after.codes).toHaveLength(1);
      expect(data.after.items).toHaveLength(1);
      const released = source.boxes.find((box) => box.id.endsWith("000000000041"));
      if (released?.sscc == null) throw new Error("fixture released box");
      expect(nextXml).not.toContain(released.sscc);
      expect(nextXml).not.toEqual(xml);
    }
  },
);
