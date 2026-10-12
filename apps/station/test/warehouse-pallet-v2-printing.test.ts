import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { makePalletRenderingV2, palletReprintEventV2Schema } from "@markiro/domain";
import {
  thermalPalletSource,
  thermalChoice,
} from "../../../packages/domain/test/support/pallet-reprint.js";
import { applyMigrations } from "../src/lib/mirror.js";
import { makeRotatingExec } from "./support/sqlite-exec.js";
import { warehousePreparedJobInput } from "./support/warehouse-reprint.js";
import {
  prepareWarehousePalletJob,
  settleWarehousePalletJob,
  sendWarehousePalletJob,
} from "../src/lib/warehouse-reprint/pallet-printing.js";
it("freezes selected rendering separately from original, synchronizes it before events and counts each send once", async () => {
  const db = new DatabaseSync(":memory:"),
    exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  try {
    const source = thermalPalletSource(),
      before = JSON.stringify(source),
      rendering = makePalletRenderingV2(source, thermalChoice()),
      input = warehousePreparedJobInput(),
      sessionId = crypto.randomUUID();
    await exec.run(
      "INSERT INTO warehouse_pallet_settings(owner,reason,session_id,session_status) VALUES('owner','damaged',?,'active')",
      [sessionId],
    );
    const job = await prepareWarehousePalletJob({
      exec,
      owner: "owner",
      operatorId: input.operatorId,
      source,
      rendering,
      sessionId,
      profile: input.printer,
      reason: "damaged",
      tenantId: "tenant",
      render: async () => new TextEncoder().encode("selected"),
    });
    expect(job.rendering).toEqual(rendering);
    expect(JSON.stringify(job.source)).toBe(before);
    const [row] = await exec.all<{ event_json: string }>(
      "SELECT event_json FROM warehouse_pallet_jobs",
    );
    expect(
      palletReprintEventV2Schema.parse(JSON.parse(row?.event_json ?? "{}")).renderingRevision,
    ).toBe(rendering.renderingRevision);
    const send = {
      exec,
      owner: "owner",
      operatorId: input.operatorId,
      jobId: job.jobId,
      profile: input.printer,
      isCurrent: () => true,
      print: vi.fn(async () => {}),
    };
    await Promise.all([sendWarehousePalletJob(send), sendWarehousePalletJob(send)]);
    expect(send.print).toHaveBeenCalledTimes(1);
    expect(
      (
        await exec.all<{ sent_count: number }>("SELECT sent_count FROM warehouse_pallet_settings")
      )[0]?.sent_count,
    ).toBe(1);
    await exec.run(
      "UPDATE warehouse_pallet_jobs SET event_json=json_set(event_json,'$.eventId',?)",
      [crypto.randomUUID()],
    );
    expect(
      (
        await exec.all<{ sent_count: number }>("SELECT sent_count FROM warehouse_pallet_settings")
      )[0]?.sent_count,
    ).toBe(1);
  } finally {
    db.close();
  }
});

import {
  a4PalletSource,
  sheetChoice,
} from "../../../packages/domain/test/support/pallet-reprint.js";
import { parsePalletSheetPrintSnapshot } from "../src/lib/pallet-sheet-print-snapshot.js";
vi.mock("../src/lib/rasterizer.js", () => ({
  rasterizeDriverText: async () => ({
    width: 8,
    height: 8,
    hex: "0000000000000000",
    totalBytes: 8,
    bytesPerRow: 1,
  }),
  rasterizeText: async () => ({
    width: 8,
    height: 8,
    hex: "0000000000000000",
    totalBytes: 8,
    bytesPerRow: 1,
  }),
}));
it("prepares each A4 layout with selected orientation and unchanged historical branding and facts", async () => {
  const db = new DatabaseSync(":memory:"),
    exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  try {
    const source = a4PalletSource(),
      before = JSON.stringify(source),
      input = warehousePreparedJobInput();
    const profile = {
      ...input.printer,
      mode: "windows_driver" as const,
      paper: "a4" as const,
      target: { kind: "usb" as const, printer: "Office" },
      dpi: 300 as const,
    };
    for (const index of [0, 1, 2]) {
      const choice = sheetChoice(index),
        rendering = makePalletRenderingV2(source, choice),
        measure = vi.fn(
          async (
            _queue: string,
            options: { mode: "a4_sheet"; orientation: "portrait" | "landscape" },
          ) => ({
            widthMm: options.orientation === "portrait" ? 210 : 297,
            heightMm: options.orientation === "portrait" ? 297 : 210,
            printableBoundsMm: {
              left: 3,
              top: 3,
              right: options.orientation === "portrait" ? 207 : 294,
              bottom: options.orientation === "portrait" ? 294 : 207,
            },
            guardMm: 0.5 as const,
            deviceDpiX: 600,
            deviceDpiY: 600,
            fingerprint: "fixture-" + index,
          }),
        );
      const job = await prepareWarehousePalletJob({
        exec,
        owner: "a".repeat(64),
        operatorId: input.operatorId,
        reason: "damaged",
        source,
        rendering,
        profile,
        tenantId: "tenant-fixture",
        hardware: {
          supportsWindowsPrinting: async () => true,
          getWindowsPageGeometry: measure,
          preflightWindowsRaster: async () => ({ ok: true }),
          printWindowsRaster: async () => ({
            ok: true,
            receipt: { queue: "Office", jobId: 1, documentName: "fixture" },
          }),
          getWindowsPrintJob: async () => ({ state: "absent" }),
        },
      });
      expect(measure).toHaveBeenCalledWith("Office", {
        mode: "a4_sheet",
        orientation: choice.snapshot.spec.page.orientation,
      });
      const [row] = await exec.all<{ render_snapshot_json: string }>(
        "SELECT render_snapshot_json FROM warehouse_pallet_jobs WHERE job_id=?",
        [job.jobId],
      );
      if (!row) throw new Error("Missing snapshot");
      const snapshot = parsePalletSheetPrintSnapshot(row.render_snapshot_json);
      expect(snapshot.template).toEqual(choice.snapshot);
      if (source.rendering.kind !== "a4") throw new Error("Expected A4");
      expect(snapshot.facts).toEqual(source.rendering.facts);
      expect(snapshot.brandingJson).toContain("Исторический завод");
      expect(JSON.stringify(job.source)).toBe(before);
      await settleWarehousePalletJob(exec, "a".repeat(64), job.jobId, input.operatorId, "skipped");
    }
  } finally {
    db.close();
  }
});
