// @vitest-environment node
import { describe, expect, it } from "vitest";
import { encodeMonoRaster } from "@markiro/domain";
import { openProductLabelWork } from "./support/product-label-work.js";
import {
  preparePrintDelivery,
  claimPrintDelivery,
  readPrintDelivery,
  recordPrintDeliveryResult,
  recoverPrintDeliveries,
} from "../src/lib/print-deliveries.js";
import type { PrinterProfile } from "../src/lib/printer-routing.js";
const profile: PrinterProfile = {
  id: "p",
  name: "Queue",
  target: { kind: "usb", printer: "Queue" },
  language: "tspl",
  dpi: 203,
  mode: "windows_driver",
};
const key = { scope: "owner", purpose: "test" as const, jobId: "test", attemptId: "attempt" };
const bytes = encodeMonoRaster({
  format: "mono-raster-v1",
  widthMm: 10,
  heightMm: 10,
  dpi: 203,
  widthDots: 80,
  heightDots: 80,
  stride: 10,
  requiredBounds: { left: 0, top: 0, right: 0, bottom: 0 },
  pixels: new Uint8Array(800),
});
describe("durable Windows delivery", () => {
  it("claims once across pooled connections and restart, then keeps the receipt", async () => {
    const w = await openProductLabelWork();
    try {
      await preparePrintDelivery(w.exec, key, profile, bytes);
      expect(
        await Promise.all([claimPrintDelivery(w.exec, key), claimPrintDelivery(w.exec, key)]),
      ).toEqual([true, false]);
      w.restart();
      expect(await claimPrintDelivery(w.exec, key)).toBe(false);
      const row = await readPrintDelivery(w.exec, key);
      expect(row?.state).toBe("sending");
      const receipt = { queue: "Queue", jobId: 123, documentName: row?.document_name ?? "" };
      await recordPrintDeliveryResult(w.exec, key, { ok: true, receipt });
      await recordPrintDeliveryResult(w.exec, key, {
        ok: false,
        error: { code: "driver_failure", phase: "delivery_unknown" },
      });
      expect(await readPrintDelivery(w.exec, key)).toMatchObject({
        state: "sent",
        receipt_json: JSON.stringify(receipt),
      });
    } finally {
      w.close();
    }
  });
  it("refuses changed artifact or profile for the same attempt", async () => {
    const w = await openProductLabelWork();
    try {
      await preparePrintDelivery(w.exec, key, profile, bytes);
      await expect(
        preparePrintDelivery(w.exec, key, { ...profile, language: "zpl" }, bytes),
      ).rejects.toThrow();
    } finally {
      w.close();
    }
  });
});

it("preserves a late receipt after recovery without turning uncertainty into success", async () => {
  const w = await openProductLabelWork();
  try {
    await preparePrintDelivery(w.exec, key, profile, bytes);
    await claimPrintDelivery(w.exec, key);
    const before = await readPrintDelivery(w.exec, key);
    await recoverPrintDeliveries(w.exec);
    const receipt = { queue: "Queue", jobId: 45, documentName: before?.document_name ?? "" };
    await recordPrintDeliveryResult(w.exec, key, { ok: true, receipt });
    expect(await readPrintDelivery(w.exec, key)).toMatchObject({
      state: "delivery_unknown",
      receipt_json: JSON.stringify(receipt),
    });
  } finally {
    w.close();
  }
});
