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
  prepareWindowsReprint,
  resolvePrintDelivery,
} from "../src/lib/print-deliveries.js";
import { bindPrintDestination } from "../src/lib/print-destinations.js";
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

it("releases settled raster payloads but preserves uncertain output and receipt metadata", async () => {
  const w = await openProductLabelWork();
  try {
    const row = await preparePrintDelivery(w.exec, key, profile, bytes);
    await claimPrintDelivery(w.exec, key);
    await recordPrintDeliveryResult(w.exec, key, {
      ok: false,
      error: {
        code: "driver_failure",
        phase: "delivery_unknown",
      },
    });
    expect((await readPrintDelivery(w.exec, key))?.artifact_base64).toBeTruthy();
    await resolvePrintDelivery(w.exec, key);
    expect(await readPrintDelivery(w.exec, key)).toMatchObject({
      artifact_base64: "",
      artifact_digest: row.artifact_digest,
      state: "delivery_unknown",
    });
    const sentKey = { ...key, jobId: "sent" };
    const sent = await preparePrintDelivery(w.exec, sentKey, profile, bytes);
    await claimPrintDelivery(w.exec, sentKey);
    await recordPrintDeliveryResult(w.exec, sentKey, {
      ok: true,
      receipt: { queue: "Queue", jobId: 1, documentName: sent.document_name },
    });
    expect(await readPrintDelivery(w.exec, sentKey)).toMatchObject({
      artifact_base64: "",
      artifact_digest: sent.artifact_digest,
      state: "sent",
    });
  } finally {
    w.close();
  }
});

it("allows rerender at corrected DPI only after a proven before-send failure", async () => {
  const key = { scope: "owner", purpose: "box" as const, jobId: "box", attemptId: "attempt" };
  const w = await openProductLabelWork();
  try {
    await bindPrintDestination(w.exec, key, profile);
    await preparePrintDelivery(w.exec, key, profile, bytes);
    await claimPrintDelivery(w.exec, key);
    await recordPrintDeliveryResult(w.exec, key, {
      ok: false,
      error: {
        code: "geometry_mismatch",
        phase: "before_start",
      },
    });
    const corrected = { ...profile, dpi: 300 as const };
    const newBytes = encodeMonoRaster({
      format: "mono-raster-v1",
      widthMm: 10,
      heightMm: 10,
      dpi: 300,
      widthDots: 118,
      heightDots: 118,
      stride: 15,
      requiredBounds: { left: 0, top: 0, right: 0, bottom: 0 },
      pixels: new Uint8Array(1770),
    });
    const retry = await prepareWindowsReprint(w.exec, key, corrected, async () => newBytes);
    expect(retry?.bytes).toEqual(newBytes);
    expect(retry?.key.attemptId).not.toBe(key.attemptId);
    expect((await readPrintDelivery(w.exec, key))?.resolved_at).toBeTruthy();
  } finally {
    w.close();
  }
});

it.each(["prepared", "delivery_unknown"] as const)(
  "regenerates a resolved %s attempt whose raster was released",
  async (state) => {
    const key = { scope: "owner", purpose: "box" as const, jobId: "box", attemptId: "attempt" };
    const w = await openProductLabelWork();
    try {
      await bindPrintDestination(w.exec, key, profile);
      await preparePrintDelivery(w.exec, key, profile, bytes);
      if (state === "delivery_unknown") {
        await claimPrintDelivery(w.exec, key);
        await recoverPrintDeliveries(w.exec);
      }
      await resolvePrintDelivery(w.exec, key);
      expect((await readPrintDelivery(w.exec, key))?.artifact_base64).toBe("");
      let rendered = false;
      const next = await prepareWindowsReprint(w.exec, key, profile, async () => {
        rendered = true;
        return bytes;
      });
      expect(rendered).toBe(true);
      expect(next?.key.attemptId).not.toBe(key.attemptId);
      expect((await readPrintDelivery(w.exec, key))?.state).toBe(state);
    } finally {
      w.close();
    }
  },
);

it("replays an unresolved unknown attempt without invoking regeneration", async () => {
  const key = { scope: "owner", purpose: "box" as const, jobId: "box", attemptId: "attempt" };
  const w = await openProductLabelWork();
  try {
    await bindPrintDestination(w.exec, key, profile);
    await preparePrintDelivery(w.exec, key, profile, bytes);
    await claimPrintDelivery(w.exec, key);
    await recoverPrintDeliveries(w.exec);
    const next = await prepareWindowsReprint(w.exec, key, profile, async () => {
      throw new Error("Must replay saved bytes");
    });
    expect(next?.bytes).toEqual(bytes);
  } finally {
    w.close();
  }
});
