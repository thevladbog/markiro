import { purgeWarehousePalletJobs } from "../src/lib/warehouse-reprint/pallet-sync.js";
// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import {
  buildPalletSheetPresets,
  createPalletSheetSnapshot,
  makePalletLabelSource,
  productLabelValueDigest,
  sheetLogoFingerprint,
} from "@markiro/domain";
import { applyMigrations } from "../src/lib/mirror.js";
import { makeRotatingExec } from "./support/sqlite-exec.js";
import {
  prepareWarehousePalletJob,
  sendWarehousePalletJob,
  warehousePalletJobView,
  recoverWarehousePalletJobs,
  settleWarehousePalletJob,
} from "../src/lib/warehouse-reprint/pallet-printing.js";
import { preparePrintDelivery, readPrintDelivery } from "../src/lib/print-deliveries.js";
import type { WindowsPrinting } from "../src/lib/hardware.js";
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
it("journals a driver refusal, remeasures only an unsent retry and preserves the original production attempt", async () => {
  const db = new DatabaseSync(":memory:"),
    exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  try {
    const preset = buildPalletSheetPresets()[0];
    if (!preset) throw new Error("Missing preset");
    const bitmap = { width: 4, height: 1, stride: 1, pixels: Uint8Array.of(128) };
    const content = {
      schemaVersion: 1,
      producerVersion: "logo-raster-v1",
      tenantId: "tenant",
      ownerDigest: "a".repeat(64),
      organizationName: "Plant",
      logoRevision: null,
      sourceChecksum: null,
      logo: {
        width: 4,
        height: 1,
        stride: 1,
        pixelsBase64: "gA==",
        digest: sheetLogoFingerprint(bitmap),
        source: "markiro",
      },
    };
    const brandingJson = JSON.stringify({ ...content, digest: productLabelValueDigest(content) });
    const source = makePalletLabelSource({
      version: 1,
      sscc: "146000000000001231",
      shiftId: "00000000-0000-4000-8000-000000000001",
      closedAt: "2026-10-11T00:00:00.000Z",
      boxCount: 1,
      itemCount: 1,
      boxSsccs: ["046000000000001234"],
      compositionDigest: "a".repeat(64),
      rendering: {
        kind: "a4",
        rendererVersion: "pallet-sheet-v1",
        template: createPalletSheetSnapshot({
          id: "00000000-0000-4000-8000-000000000002",
          name: "Portrait",
          revision: 1,
          spec: preset.spec,
        }),
        facts: {
          sscc: "146000000000001231",
          boxCount: 1,
          itemCount: 1,
          productPrintName: "Frozen",
          gtin14: "04600000000015",
          egaisCode: null,
          productionDate: "2026-10-11",
          shelfLifeDays: 1,
          shiftNumber: "S",
        },
        brandingJson,
      },
    });
    const profile = {
      id: "a4",
      name: "Office",
      mode: "windows_driver" as const,
      paper: "a4" as const,
      target: { kind: "usb" as const, printer: "Queue" },
      dpi: 300 as const,
      language: "zpl" as const,
    };
    const geometry = {
      widthMm: 210,
      heightMm: 297,
      printableBoundsMm: { left: 3, top: 7, right: 205, bottom: 293 },
      guardMm: 0.5,
      deviceDpiX: 600,
      deviceDpiY: 600,
      fingerprint: "geometry-1",
    };
    const measure = vi
      .fn<NonNullable<WindowsPrinting["getWindowsPageGeometry"]>>()
      .mockResolvedValue(geometry);
    const preflight = vi
      .fn<WindowsPrinting["preflightWindowsRaster"]>()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "driver_failure", phase: "before_start" },
      })
      .mockResolvedValue({ ok: true });
    const send = vi.fn<WindowsPrinting["printWindowsRaster"]>().mockResolvedValue({
      ok: false,
      error: { code: "driver_failure", phase: "delivery_unknown" },
    });
    const hardware: WindowsPrinting = {
      supportsWindowsPrinting: async () => true,
      getWindowsPageGeometry: measure,
      preflightWindowsRaster: preflight,
      printWindowsRaster: send,
      getWindowsPrintJob: async () => ({ state: "unavailable" }),
    };
    const job = await prepareWarehousePalletJob({
      exec,
      owner: "a".repeat(64),
      operatorId: "00000000-0000-4000-8000-000000000003",
      reason: "damaged",
      source,
      profile,
      tenantId: "tenant",
      hardware,
    });
    const original = {
      scope: "production",
      purpose: "pallet" as const,
      jobId: source.sscc,
      attemptId: "original",
    };
    const [stored] = await exec.all<{ bytes_base64: string; render_snapshot_json: string }>(
      "SELECT bytes_base64,render_snapshot_json FROM warehouse_pallet_jobs",
    );
    if (!stored) throw new Error("Missing job");
    await preparePrintDelivery(
      exec,
      original,
      profile,
      Uint8Array.from(atob(stored.bytes_base64), (c) => c.charCodeAt(0)),
      stored.render_snapshot_json,
    );
    const input = {
      exec,
      owner: "a".repeat(64),
      operatorId: "00000000-0000-4000-8000-000000000003",
      jobId: job.jobId,
      profile,
      tenantId: "tenant",
      hardware,
      isCurrent: () => true,
      print: vi.fn(),
    };
    await sendWarehousePalletJob(input);
    expect((await warehousePalletJobView(exec, input.owner, job.jobId)).state).toBe(
      "failed_before_send",
    );
    expect(send).not.toHaveBeenCalled();
    measure.mockResolvedValue({ ...geometry, fingerprint: "geometry-2" });
    await sendWarehousePalletJob({ ...input, retry: true });
    expect(
      await exec.all("SELECT state,error_code FROM printer_deliveries WHERE scope<>?", [
        original.scope,
      ]),
    ).toContainEqual({ state: "delivery_unknown", error_code: "driver_failure" });
    expect(measure).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await warehousePalletJobView(exec, input.owner, job.jobId)).state).toBe(
      "delivery_unknown",
    );
    await recoverWarehousePalletJobs(exec, input.owner, input.operatorId);
    expect(send).toHaveBeenCalledTimes(1);
    await expect(
      sendWarehousePalletJob({
        ...input,
        retry: true,
        profile: { ...profile, target: { kind: "usb", printer: "Other" } },
      }),
    ).rejects.toThrow("WAREHOUSE_PRINTER_CHANGED");
    await sendWarehousePalletJob({ ...input, retry: true });
    expect(measure).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[1]).toEqual(send.mock.calls[0]?.[1]);
    await settleWarehousePalletJob(exec, input.owner, job.jobId, input.operatorId, "skipped");
    expect((await readPrintDelivery(exec, original))?.resolved_at).toBeNull();
    expect(
      await exec.all(
        "SELECT 1 FROM printer_deliveries WHERE scope<>? AND resolved_at IS NULL AND state IN ('prepared','sending','delivery_unknown')",
        [original.scope],
      ),
    ).toHaveLength(0);
    await purgeWarehousePalletJobs(exec, input.owner, "2099-01-01T00:00:00.000Z");
    expect(await exec.all("SELECT * FROM warehouse_pallet_jobs")).toHaveLength(1);
    await exec.run("UPDATE warehouse_pallet_events SET receive_status='accepted'");
    await purgeWarehousePalletJobs(exec, input.owner, "2099-01-01T00:00:00.000Z");
    expect(await exec.all("SELECT * FROM warehouse_pallet_jobs")).toHaveLength(0);
    expect((await readPrintDelivery(exec, original))?.resolved_at).toBeNull();
  } finally {
    db.close();
  }
});
