// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { productLabelBytesDigest } from "@markiro/domain";
import { openProductLabelWork } from "./support/product-label-work.js";
import { renderPrintArtifact } from "../src/lib/print-artifact.js";
import { bytesToBase64, tauriWindowsPrinting } from "../src/lib/hardware.js";
import { createProductLabelWork } from "../src/lib/use-product-label-work.js";
import { readPrintDestination } from "../src/lib/print-destinations.js";
import { bindPrintDestination } from "../src/lib/print-destinations.js";
import { recordProductLabelAcceptance } from "../src/lib/product-labels/acceptance.js";
import {
  sendPreparedProductLabel,
  prepareProductLabelReprint,
  verifyProductLabel,
} from "../src/lib/product-labels/printing.js";
import { readProductLabelJob } from "../src/lib/product-labels/store.js";
import { readPrintDelivery } from "../src/lib/print-deliveries.js";
import type { PrinterProfile } from "../src/lib/printer-routing.js";
const profile: PrinterProfile = {
  id: "win",
  name: "Driver",
  target: { kind: "usb", printer: "Queue" },
  mode: "windows_driver",
  language: "tspl",
  dpi: 203,
};
afterEach(() => vi.restoreAllMocks());
describe("Windows duplicate output", () => {
  it("freezes raster bytes, claims before IPC and explicitly replays the same page", async () => {
    const w = await openProductLabelWork("required", undefined, false);
    try {
      const artifact = await renderPrintArtifact(
        w.input.policy.snapshot.spec,
        w.input.fields,
        profile,
        async () => ({ hex: "80", bytesPerRow: 1, totalBytes: 1, width: 1, height: 1 }),
      );
      const { language, ...common } = w.input.preparedEvent;
      void language;
      await recordProductLabelAcceptance(w.exec, {
        ...w.input,
        bytesBase64: bytesToBase64(artifact.bytes),
        preparedEvent: {
          ...common,
          printFormat: "mono-raster-v1",
          bytesDigest: productLabelBytesDigest(artifact.bytes),
        },
      });
      const key = {
        scope: w.input.credentialOwnership,
        purpose: "duplicate" as const,
        jobId: w.input.jobId,
        attemptId: w.input.preparedEvent.attemptId,
      };
      await bindPrintDestination(w.exec, key, profile);
      vi.spyOn(tauriWindowsPrinting, "preflightWindowsRaster").mockResolvedValue({ ok: true });
      const send = vi
        .spyOn(tauriWindowsPrinting, "printWindowsRaster")
        .mockImplementation(async (queue, bytes, documentName) => {
          const job = await readProductLabelJob(w.exec, w.input.credentialOwnership, w.input.jobId);
          expect(job?.projection.attemptState).toBe("sending");
          expect(bytes).toEqual(artifact.bytes);
          const delivery = await readPrintDelivery(w.exec, {
            ...key,
            attemptId: job?.projection.attemptId ?? "",
          });
          expect(delivery?.state).toBe("sending");
          return { ok: true, receipt: { queue, jobId: 42, documentName } };
        });
      const deps = { ...w.deps, profile, target: profile.target };
      expect((await sendPreparedProductLabel(deps, w.input.jobId)).attemptState).toBe("sent");
      await sendPreparedProductLabel(deps, w.input.jobId);
      expect(send).toHaveBeenCalledTimes(1);
      expect(tauriWindowsPrinting.preflightWindowsRaster).toHaveBeenCalledTimes(1);
      expect(w.print).not.toHaveBeenCalled();
      const attemptId = await prepareProductLabelReprint(w.exec, {
        ...w.actor,
        credentialOwnership: w.input.credentialOwnership,
        jobId: w.input.jobId,
        shiftId: w.input.shiftId,
        reason: "damaged",
      });
      await sendPreparedProductLabel(deps, w.input.jobId);
      expect(send).toHaveBeenCalledTimes(2);
      expect(
        await verifyProductLabel(w.exec, {
          ...w.actor,
          credentialOwnership: w.input.credentialOwnership,
          jobId: w.input.jobId,
          attemptId,
          raw: w.input.raw,
        }),
      ).toBe("match");
      expect(
        (await readProductLabelJob(w.exec, w.input.credentialOwnership, w.input.jobId))?.projection
          .status,
      ).toBe("completed");
    } finally {
      w.close();
    }
  });
});

it.each([
  { savedRaster: true, mode: "windows_driver", language: "zpl", dpi: 203, compatible: true },
  { savedRaster: true, mode: "windows_driver", language: "tspl", dpi: 203, compatible: true },
  { savedRaster: true, mode: "raw", language: "zpl", dpi: 203, compatible: false },
  { savedRaster: true, mode: "windows_driver", language: "zpl", dpi: 300, compatible: false },
  { savedRaster: false, mode: "windows_driver", language: "zpl", dpi: 203, compatible: false },
  { savedRaster: false, mode: "raw", language: "zpl", dpi: 203, compatible: true },
  { savedRaster: false, mode: "raw", language: "tspl", dpi: 203, compatible: false },
  { savedRaster: false, mode: "raw", language: "zpl", dpi: 300, compatible: false },
] as const)(
  "checks prepared printer compatibility by saved format and DPI: %j",
  async ({ savedRaster, mode, language, dpi, compatible }) => {
    const w = await openProductLabelWork("required", undefined, false);
    try {
      const artifact = await renderPrintArtifact(
        w.input.policy.snapshot.spec,
        w.input.fields,
        profile,
        async () => ({ hex: "80", bytesPerRow: 1, totalBytes: 1, width: 1, height: 1 }),
      );
      const { language: originalLanguage, ...common } = w.input.preparedEvent;
      void originalLanguage;
      const input = savedRaster
        ? {
            ...w.input,
            bytesBase64: bytesToBase64(artifact.bytes),
            preparedEvent: {
              ...common,
              printFormat: "mono-raster-v1" as const,
              bytesDigest: productLabelBytesDigest(artifact.bytes),
            },
          }
        : w.input;
      await recordProductLabelAcceptance(w.exec, input);
      const selected: PrinterProfile = { ...profile, id: "replacement", mode, language, dpi };
      const work = createProductLabelWork({
        exec: w.exec,
        shiftId: input.shiftId,
        credentialOwnership: input.credentialOwnership,
        getPrinting: () => w.deps,
        printers: () => [selected],
        prepare: async () => input,
      });
      await work.open();
      const changing = work.changePreparedPrinter(selected);
      if (compatible) await expect(changing).resolves.toBeUndefined();
      else await expect(changing).rejects.toThrow("Incompatible printer");
      expect(
        await readPrintDestination(w.exec, {
          scope: input.credentialOwnership,
          purpose: "duplicate",
          jobId: input.jobId,
          attemptId: input.preparedEvent.attemptId,
        }),
      ).toEqual(compatible ? selected : null);
      const saved = await readProductLabelJob(w.exec, input.credentialOwnership, input.jobId);
      expect(saved?.bytesBase64).toBe(input.bytesBase64);
      expect(saved?.projection.attemptState).toBe("prepared");
      expect(w.print).not.toHaveBeenCalled();
    } finally {
      w.close();
    }
  },
);
