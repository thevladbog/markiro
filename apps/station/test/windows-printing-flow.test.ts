// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { productLabelBytesDigest } from "@markiro/domain";
import { openProductLabelWork } from "./support/product-label-work.js";
import { renderPrintArtifact } from "../src/lib/print-artifact.js";
import { bytesToBase64, tauriWindowsPrinting } from "../src/lib/hardware.js";
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
