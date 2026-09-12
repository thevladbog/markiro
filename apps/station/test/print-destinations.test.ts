// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  bindPrintDestination,
  readPrintDestination,
  replacePrintDestination,
} from "../src/lib/print-destinations.js";
import type { PrinterProfile } from "../src/lib/printer-routing.js";
import { openProductLabelWork } from "./support/product-label-work.js";

const first: PrinterProfile = {
  id: "one",
  name: "Boxes",
  target: { kind: "tcp", host: "10.0.0.1", port: 9100 },
  language: "zpl",
  dpi: 203,
};
const second: PrinterProfile = {
  ...first,
  id: "two",
  name: "Pallets",
  target: { kind: "usb", printer: "Zebra" },
};
const key = { scope: "owner", purpose: "box" as const, jobId: "sscc", attemptId: "label" };

describe("local print destinations", () => {
  it("pins before output, survives restart and isolates owners, purposes and attempts", async () => {
    const work = await openProductLabelWork();
    try {
      expect(await bindPrintDestination(work.exec, key, first)).toEqual(first);
      work.restart();
      expect(await bindPrintDestination(work.exec, key, second)).toEqual(first);
      expect(await bindPrintDestination(work.exec, key, null)).toEqual(first);
      for (const other of [
        { ...key, scope: "other" },
        { ...key, purpose: "pallet" as const },
        { ...key, attemptId: "retry" },
      ]) {
        expect(await readPrintDestination(work.exec, other)).toBeNull();
        expect(await bindPrintDestination(work.exec, other, second)).toEqual(second);
      }
      expect(await replacePrintDestination(work.exec, key, second, first)).toBe(false);
      expect(await replacePrintDestination(work.exec, key, first, second)).toBe(true);
      expect(await readPrintDestination(work.exec, key)).toEqual(second);
    } finally {
      work.close();
    }
  });

  it("never falls back from a damaged saved snapshot", async () => {
    const work = await openProductLabelWork();
    try {
      await bindPrintDestination(work.exec, key, first);
      await work.exec.run("UPDATE printer_destinations SET profile_json='{}'");
      await expect(bindPrintDestination(work.exec, key, second)).rejects.toThrow(
        "Invalid saved printer",
      );
    } finally {
      work.close();
    }
  });
});
