import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { encodeMonoRaster } from "@markiro/domain";
import { WindowsDeliveryStatus } from "../src/ui/WindowsDeliveryStatus.js";
import { openProductLabelWork } from "./support/product-label-work.js";
import {
  preparePrintDelivery,
  claimPrintDelivery,
  recordPrintDeliveryResult,
  recoverPrintDeliveries,
  readPrintDelivery,
  resolvePrintDelivery,
} from "../src/lib/print-deliveries.js";
import { tauriWindowsPrinting } from "../src/lib/hardware.js";
import type { PrinterProfile } from "../src/lib/printer-routing.js";
import i18n from "../src/i18n/index.js";
afterEach(() => vi.restoreAllMocks());
it("warns before a repeat and keeps unknown after the spooler no longer lists the job", async () => {
  await i18n.changeLanguage("ru");
  const w = await openProductLabelWork();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const profile: PrinterProfile = {
    id: "p",
    name: "Q",
    target: { kind: "usb", printer: "Q" },
    mode: "windows_driver",
    language: "zpl",
    dpi: 203,
  };
  const key = { scope: "owner", purpose: "test" as const, jobId: "j", attemptId: "a" };
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
  let view: ReturnType<typeof render> | undefined;
  try {
    const row = await preparePrintDelivery(w.exec, key, profile, bytes);
    await claimPrintDelivery(w.exec, key);
    await recordPrintDeliveryResult(w.exec, key, {
      ok: false,
      error: {
        code: "driver_failure",
        phase: "delivery_unknown",
        receipt: { queue: "Q", jobId: 42, documentName: row.document_name },
      },
    });
    await recoverPrintDeliveries(w.exec);
    const observe = vi
      .spyOn(tauriWindowsPrinting, "getWindowsPrintJob")
      .mockResolvedValue({ state: "absent" });
    const writes = vi.spyOn(w.exec, "run");
    writes.mockClear();
    view = render(
      <WindowsDeliveryStatus
        exec={w.exec}
        scope="owner"
        purpose="test"
        onAcknowledge={async (key) => {
          await resolvePrintDelivery(w.exec, key);
        }}
      />,
    );
    await screen.findByText(/Исходное задание ещё может выйти из очереди/);
    expect(writes).not.toHaveBeenCalled();
    expect(screen.queryByRole("img")).toBeNull();
    const summary = screen.getByText("Сохранённая этикетка");
    const details = summary.closest("details");
    if (!details) throw new Error("Preview control unavailable");
    details.open = true;
    fireEvent(details, new Event("toggle"));
    await screen.findByRole("img");
    expect(writes).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Проверить очередь" }));
    await screen.findByText("Задания нет в очереди. Это не подтверждает физическую печать.");
    expect(observe).toHaveBeenCalledWith({
      queue: "Q",
      jobId: 42,
      documentName: row.document_name,
    });
    expect((await readPrintDelivery(w.exec, key))?.state).toBe("delivery_unknown");
    expect((await readPrintDelivery(w.exec, key))?.resolved_at).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Проверено оператором — закрыть уведомление" }),
    );
    await waitFor(async () =>
      expect((await readPrintDelivery(w.exec, key))?.resolved_at).toBeTruthy(),
    );
  } finally {
    view?.unmount();
    w.close();
  }
});
