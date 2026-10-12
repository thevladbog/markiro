import { decodeMonoRaster, mmToDots } from "@markiro/domain";
import { describe, expect, it, vi } from "vitest";

import type { PrintResult, WindowsPrinting } from "../src/hardware/hardware.js";
import { renderLabel } from "../src/floor/print/label-render.js";
import {
  base64ToBytes,
  readPrintJob,
  recoverInterruptedJobs,
  sendLabelJob,
  settleOutcome,
  type RenderLabel,
} from "../src/floor/print/print-jobs.js";
import { printAgain, UnresolvableJobError } from "../src/floor/print/print-resolution.js";
import { createPrintRuntime, PRINT_SEND_LIMIT_MS } from "../src/floor/print/print-runtime.js";
import type { PrinterProfile } from "../src/floor/setup/workstation-settings.js";
import { fakeHardware } from "./support/hardware.js";
import {
  closeBoxWithLabel,
  fakeRaster,
  fakeRender,
  flushPromises,
  jobRows,
  manualTimers,
  printStation,
  resolveContext,
  spyRender,
  ZEBRA,
} from "./support/printing.js";
import { PAIRING } from "./support/floor-work.js";

const GODEX: PrinterProfile = {
  id: "godex",
  name: "Godex через драйвер",
  target: { kind: "usb", printer: "Godex G500" },
  language: "zpl",
  dpi: 203,
  mode: "windows_driver",
};
const DOC_ID = "7d1c2a8e-3b4f-4c5d-9e6f-0a1b2c3d4e5f";

/** The shell's driver printing: every print recorded and answered by `answer`. */
function fakeWindows(answer?: (queue: string, documentName: string) => Promise<PrintResult>) {
  const prints: { queue: string; documentName: string; bytes: number }[] = [];
  const windows: WindowsPrinting = {
    supportsWindowsPrinting: vi.fn(async () => true),
    printWindowsRaster: vi.fn(
      async (queue: string, bytes: Uint8Array, documentName: string): Promise<PrintResult> => {
        prints.push({ queue, documentName, bytes: bytes.length });
        return answer !== undefined
          ? answer(queue, documentName)
          : { sent: true, receipt: { queue, jobId: 42, documentName } };
      },
    ),
    getWindowsPrintJob: vi.fn(async () => ({ state: "present" as const, statusFlags: 0 })),
  };
  return { windows, prints };
}

describe("the print runtime's driver route", () => {
  it("sends a driver page to the Windows queue as Markiro:<uuid>, never through RAW", async () => {
    const shell = fakeHardware();
    const { windows, prints } = fakeWindows();
    const runtime = createPrintRuntime(shell.hardware.printBytes, {
      windows,
      newDocumentId: () => DOC_ID,
    });
    await expect(
      runtime.send("job-1", GODEX.target, new Uint8Array([1, 2]), "windows_driver"),
    ).resolves.toEqual({
      kind: "answered",
      result: {
        sent: true,
        receipt: { queue: "Godex G500", jobId: 42, documentName: `Markiro:${DOC_ID}` },
      },
    });
    expect(prints).toEqual([{ queue: "Godex G500", documentName: `Markiro:${DOC_ID}`, bytes: 2 }]);
    expect(shell.sends).toEqual([]);
    // RAW stays RAW, the default.
    await runtime.send("job-2", ZEBRA.target, new Uint8Array([65]));
    expect(shell.sends).toHaveLength(1);
    expect(prints).toHaveLength(1);
  });

  it("refuses a driver send to anything but a Windows queue, or without the shell's driver, sending nothing", async () => {
    const shell = fakeHardware();
    const { windows, prints } = fakeWindows();
    const runtime = createPrintRuntime(shell.hardware.printBytes, { windows });
    await expect(
      runtime.send("job-1", ZEBRA.target, new Uint8Array([1]), "windows_driver"),
    ).resolves.toEqual({ kind: "answered", result: { sent: false, code: "invalid_target" } });
    const bare = createPrintRuntime(shell.hardware.printBytes);
    await expect(
      bare.send("job-2", GODEX.target, new Uint8Array([1]), "windows_driver"),
    ).resolves.toEqual({ kind: "answered", result: { sent: false, code: "unsupported" } });
    expect(prints).toEqual([]);
    expect(shell.sends).toEqual([]);
    await expect(bare.supportsWindowsDriver()).resolves.toBe(false);
    await expect(runtime.supportsWindowsDriver()).resolves.toBe(true);
  });

  it("asks the spooler about the job's newest driver send, a late answer's receipt included", async () => {
    const shell = fakeHardware();
    let release: (result: PrintResult) => void = () => undefined;
    const { windows } = fakeWindows(
      () =>
        new Promise<PrintResult>((resolve) => {
          release = resolve;
        }),
    );
    const timers = manualTimers();
    const runtime = createPrintRuntime(shell.hardware.printBytes, {
      windows,
      startTimer: timers.startTimer,
      newDocumentId: () => DOC_ID,
    });
    await expect(runtime.checkWindowsJob("job-1")).resolves.toEqual({ state: "no_receipt" });
    const sending = runtime.send("job-1", GODEX.target, new Uint8Array([1]), "windows_driver");
    await vi.waitFor(() => expect(windows.printWindowsRaster).toHaveBeenCalledTimes(1));
    timers.expire();
    await expect(sending).resolves.toEqual({ kind: "timeout" });
    const receipt = { queue: "Godex G500", jobId: 7, documentName: `Markiro:${DOC_ID}` };
    release({ sent: false, code: "driver_unknown", receipt });
    await vi.waitFor(() => expect(runtime.isInFlight("job-1")).toBe(false));
    await expect(runtime.checkWindowsJob("job-1")).resolves.toEqual({
      state: "present",
      statusFlags: 0,
    });
    expect(windows.getWindowsPrintJob).toHaveBeenCalledWith(receipt);
  });
});

describe("a driver send's outcome", () => {
  it("is failed for a refusal before the start and unknown for a delivery in doubt", () => {
    const answered = (result: PrintResult) => settleOutcome({ kind: "answered", result });
    expect(answered({ sent: false, code: "queue_unavailable" })).toEqual({
      state: "failed",
      code: "queue_unavailable",
    });
    expect(answered({ sent: false, code: "geometry_mismatch" })).toEqual({
      state: "failed",
      code: "geometry_mismatch",
    });
    expect(answered({ sent: false, code: "driver_not_started" })).toEqual({
      state: "failed",
      code: "driver_not_started",
    });
    expect(answered({ sent: false, code: "driver_unknown" })).toEqual({
      state: "unknown",
      code: "driver_unknown",
    });
  });
});

describe("a box label on a printer in driver mode", () => {
  const driverSettings = {
    printers: [GODEX, ZEBRA],
    assignments: { box: "godex", pallet: null, duplicate: null },
  };

  it("goes to the Windows queue once and, in doubt, waits for the operator", async () => {
    const at = await printStation(driverSettings);
    const job = await closeBoxWithLabel(at);
    expect(job.printer).toEqual(GODEX);
    const shell = fakeHardware();
    const { windows, prints } = fakeWindows(async (queue, documentName) => ({
      sent: false,
      code: "driver_unknown",
      receipt: { queue, jobId: 9, documentName },
    }));
    const runtime = createPrintRuntime(shell.hardware.printBytes, { windows });
    const after = await sendLabelJob(resolveContext(at.local, runtime), job);
    expect(after).toMatchObject({ state: "unknown", errorCode: "driver_unknown", attempts: 1 });
    expect(prints).toHaveLength(1);
    expect(shell.sends).toEqual([]);
  });

  it("is a safe failure when the driver refuses before the start", async () => {
    const at = await printStation(driverSettings);
    const job = await closeBoxWithLabel(at);
    const { windows } = fakeWindows(async () => ({ sent: false, code: "geometry_mismatch" }));
    const runtime = createPrintRuntime(fakeHardware().hardware.printBytes, { windows });
    await expect(sendLabelJob(resolveContext(at.local, runtime), job)).resolves.toMatchObject({
      state: "failed",
      errorCode: "geometry_mismatch",
    });
  });

  it("is rendered again when printed again on a printer of the other way, even of the same language and resolution", async () => {
    const at = await printStation(driverSettings);
    const job = await closeBoxWithLabel(at);
    const shell = fakeHardware();
    const { windows } = fakeWindows(async () => ({ sent: false, code: "geometry_mismatch" }));
    const runtime = createPrintRuntime(shell.hardware.printBytes, { windows });
    const context = resolveContext(at.local, runtime);
    const failed = await sendLabelJob(context, job);
    const render = spyRender(fakeRender);
    const { boxTemplate } = at.shift.snapshot;
    await printAgain(
      context,
      failed,
      { reason: null, printer: ZEBRA },
      at.settings,
      { id: boxTemplate.id, rev: boxTemplate.rev, spec: boxTemplate.spec },
      render,
    );
    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0]?.[2]).toEqual(ZEBRA);
    expect(shell.sends).toHaveLength(1);
  });
});

describe("the runtime's driver sends under its discipline", () => {
  it("names every send's document afresh", async () => {
    const shell = fakeHardware();
    const { windows, prints } = fakeWindows();
    const ids = ["7d1c2a8e-3b4f-4c5d-9e6f-0a1b2c3d4e5f", "0f1e2d3c-4b5a-4968-8777-6655443322ff"];
    let next = 0;
    const runtime = createPrintRuntime(shell.hardware.printBytes, {
      windows,
      newDocumentId: () => ids[next++] ?? "",
    });
    await runtime.send("job-1", GODEX.target, new Uint8Array([1]), "windows_driver");
    await runtime.send("job-1", GODEX.target, new Uint8Array([1]), "windows_driver");
    expect(prints.map((print) => print.documentName)).toEqual(ids.map((id) => `Markiro:${id}`));
  });

  it("makes up a different document name of a real UUID for every send when none is given", async () => {
    const shell = fakeHardware();
    const { windows, prints } = fakeWindows();
    const runtime = createPrintRuntime(shell.hardware.printBytes, { windows });
    await runtime.send("job-1", GODEX.target, new Uint8Array([1]), "windows_driver");
    await runtime.send("job-1", GODEX.target, new Uint8Array([1]), "windows_driver");
    const names = prints.map((print) => print.documentName);
    for (const name of names) {
      expect(name).toMatch(
        /^Markiro:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
    expect(new Set(names).size).toBe(2);
  });

  it("answers a driver call that rejects as in doubt (driver_unknown) and a RAW call that rejects as outcome_unknown", async () => {
    const shell = fakeHardware(async () => {
      throw new Error("ipc gone");
    });
    const windows: WindowsPrinting = {
      ...fakeWindows().windows,
      printWindowsRaster: vi.fn(async () => {
        throw new Error("ipc gone");
      }),
    };
    const runtime = createPrintRuntime(shell.hardware.printBytes, { windows });
    await expect(
      runtime.send("job-1", GODEX.target, new Uint8Array([1]), "windows_driver"),
    ).resolves.toEqual({ kind: "answered", result: { sent: false, code: "driver_unknown" } });
    await expect(runtime.send("job-2", ZEBRA.target, new Uint8Array([1]))).resolves.toEqual({
      kind: "answered",
      result: { sent: false, code: "outcome_unknown" },
    });
  });

  it("waits 20 s for a driver answer, shorter than the shell's own 30 s, and keeps the job in flight past it", async () => {
    const shell = fakeHardware();
    const { windows } = fakeWindows(() => new Promise<PrintResult>(() => undefined));
    const timers = manualTimers();
    const runtime = createPrintRuntime(shell.hardware.printBytes, {
      windows,
      startTimer: timers.startTimer,
    });
    const sending = runtime.send("job-1", GODEX.target, new Uint8Array([1]), "windows_driver");
    await vi.waitFor(() => expect(windows.printWindowsRaster).toHaveBeenCalledTimes(1));
    expect(timers.timers.map((timer) => timer.ms)).toEqual([PRINT_SEND_LIMIT_MS]);
    expect(PRINT_SEND_LIMIT_MS).toBe(20_000);
    expect(runtime.isInFlight("job-1")).toBe(true);
    timers.expire();
    await expect(sending).resolves.toEqual({ kind: "timeout" });
    // The shell's call never returned: the job stays with it, and the address stays taken.
    expect(runtime.isInFlight("job-1")).toBe(true);
    expect(runtime.inFlight()).toEqual(["job-1"]);
  });

  it("starts a driver send only after the earlier send to its queue has really settled, and gives a late one up as busy, never sent", async () => {
    const shell = fakeHardware();
    shell.holdSends();
    const { windows } = fakeWindows();
    const timers = manualTimers();
    const runtime = createPrintRuntime(shell.hardware.printBytes, {
      windows,
      startTimer: timers.startTimer,
    });
    // A RAW send to the same Windows queue holds the address.
    const raw = runtime.send("job-1", GODEX.target, new Uint8Array([1]));
    await vi.waitFor(() => expect(shell.heldSends()).toBe(1));
    const driver = runtime.send("job-2", GODEX.target, new Uint8Array([2]), "windows_driver");
    await flushPromises();
    expect(windows.printWindowsRaster).not.toHaveBeenCalled();
    timers.expire();
    await expect(raw).resolves.toEqual({ kind: "timeout" });
    await expect(driver).resolves.toEqual({ kind: "busy" });
    // The held call settles at last: the driver page is never given to the shell.
    shell.releaseSend({ sent: true });
    await flushPromises();
    expect(windows.printWindowsRaster).not.toHaveBeenCalled();
    expect(runtime.isInFlight("job-2")).toBe(false);
  });

  it("keeps the receipt of the job's newest send only", async () => {
    const shell = fakeHardware();
    const releases: ((result: PrintResult) => void)[] = [];
    const { windows } = fakeWindows(
      () =>
        new Promise<PrintResult>((resolve) => {
          releases.push(resolve);
        }),
    );
    const timers = manualTimers();
    const runtime = createPrintRuntime(shell.hardware.printBytes, {
      windows,
      startTimer: timers.startTimer,
    });
    const receipt = (jobId: number) => ({
      queue: "Godex G500",
      jobId,
      documentName: `Markiro:${DOC_ID}`,
    });
    void runtime.send("job-1", GODEX.target, new Uint8Array([1]), "windows_driver");
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    // A new send of the job forgets what the old one will say; the old call settles first.
    void runtime.send("job-1", GODEX.target, new Uint8Array([2]), "windows_driver");
    releases[0]?.({ sent: false, code: "driver_unknown", receipt: receipt(1) });
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    await expect(runtime.checkWindowsJob("job-1")).resolves.toEqual({ state: "no_receipt" });
    releases[1]?.({ sent: false, code: "driver_unknown", receipt: receipt(2) });
    await vi.waitFor(() => expect(runtime.isInFlight("job-1")).toBe(false));
    await runtime.checkWindowsJob("job-1");
    expect(windows.getWindowsPrintJob).toHaveBeenCalledTimes(1);
    expect(windows.getWindowsPrintJob).toHaveBeenCalledWith(receipt(2));
  });

  it("forgets the old receipt as soon as the job is sent again", async () => {
    const shell = fakeHardware();
    const answers: PrintResult[] = [
      { sent: true, receipt: { queue: "Godex G500", jobId: 1, documentName: `Markiro:${DOC_ID}` } },
    ];
    let hold = false;
    const { windows } = fakeWindows(async () => {
      if (hold) return new Promise<PrintResult>(() => undefined);
      return answers[0] ?? { sent: true };
    });
    const runtime = createPrintRuntime(shell.hardware.printBytes, { windows });
    await runtime.send("job-1", GODEX.target, new Uint8Array([1]), "windows_driver");
    await expect(runtime.checkWindowsJob("job-1")).resolves.toMatchObject({ state: "present" });
    hold = true;
    void runtime.send("job-1", GODEX.target, new Uint8Array([1]), "windows_driver");
    await expect(runtime.checkWindowsJob("job-1")).resolves.toEqual({ state: "no_receipt" });
  });

  it("never lets an answer without a receipt or a failed observation read as a printed label", async () => {
    const shell = fakeHardware();
    const { windows } = fakeWindows();
    const runtime = createPrintRuntime(shell.hardware.printBytes, { windows });
    await runtime.send("job-1", GODEX.target, new Uint8Array([1]), "windows_driver");
    windows.getWindowsPrintJob = vi.fn(async () => {
      throw new Error("ipc gone");
    });
    await expect(runtime.checkWindowsJob("job-1")).resolves.toEqual({ state: "unavailable" });
    for (const state of [
      { state: "identity_mismatch" as const },
      { state: "unavailable" as const },
      { state: "absent" as const },
    ]) {
      windows.getWindowsPrintJob = vi.fn(async () => state);
      await expect(runtime.checkWindowsJob("job-1")).resolves.toEqual(state);
    }
    // Without the shell's driver there is nothing to ask.
    const bare = createPrintRuntime(shell.hardware.printBytes);
    await expect(bare.checkWindowsJob("job-1")).resolves.toEqual({ state: "no_receipt" });
  });

  it("says the shell cannot print through a driver when it says no or cannot be asked", async () => {
    const shell = fakeHardware();
    const { windows } = fakeWindows();
    windows.supportsWindowsPrinting = vi.fn(async () => false);
    await expect(
      createPrintRuntime(shell.hardware.printBytes, { windows }).supportsWindowsDriver(),
    ).resolves.toBe(false);
    windows.supportsWindowsPrinting = vi.fn(async () => {
      throw new Error("ipc gone");
    });
    await expect(
      createPrintRuntime(shell.hardware.printBytes, { windows }).supportsWindowsDriver(),
    ).resolves.toBe(false);
  });
});

describe("a driver job in doubt is never sent again by itself", () => {
  const driverSettings = {
    printers: [GODEX, ZEBRA],
    assignments: { box: "godex", pallet: null, duplicate: null },
  };
  const inDoubt = async (queue: string, documentName: string): Promise<PrintResult> => ({
    sent: false,
    code: "driver_unknown",
    receipt: { queue, jobId: 9, documentName },
  });

  it("stores the job as sent through the driver, kept as unknown with its snapshot, and sends nothing on a recovery", async () => {
    const at = await printStation(driverSettings);
    const job = await closeBoxWithLabel(at);
    const { windows, prints } = fakeWindows(inDoubt);
    const runtime = createPrintRuntime(fakeHardware().hardware.printBytes, { windows });
    const context = resolveContext(at.local, runtime);
    const after = await sendLabelJob(context, job);
    expect(after.printer).toEqual(GODEX);
    expect(after.printer?.mode).toBe("windows_driver");
    await expect(recoverInterruptedJobs(context)).resolves.toBe(0);
    await flushPromises();
    expect(prints).toHaveLength(1);
    expect(jobRows(at.db)[0]).toMatchObject({ state: "unknown", error_code: "driver_unknown" });
    // The spooler may be asked, which changes nothing of the job.
    await expect(runtime.checkWindowsJob("job-1")).resolves.toEqual({
      state: "present",
      statusFlags: 0,
    });
    await expect(readPrintJob(at.local, PAIRING, "job-1")).resolves.toMatchObject({
      state: "unknown",
      attempts: 1,
    });
    expect(prints).toHaveLength(1);
  });

  it("leaves a job a driver send still holds alone, and turns one left sending by a restart into unknown without a send or a receipt", async () => {
    const at = await printStation(driverSettings);
    const job = await closeBoxWithLabel(at);
    const { windows, prints } = fakeWindows(() => new Promise<PrintResult>(() => undefined));
    const first = createPrintRuntime(fakeHardware().hardware.printBytes, { windows });
    void sendLabelJob(resolveContext(at.local, first), job).catch(() => undefined);
    await vi.waitFor(() => expect(prints).toHaveLength(1));
    expect(jobRows(at.db)[0]).toMatchObject({ state: "sending" });
    // The app is still running: the runtime holds the job, the recovery keeps away.
    await expect(recoverInterruptedJobs(resolveContext(at.local, first))).resolves.toBe(0);
    expect(jobRows(at.db)[0]).toMatchObject({ state: "sending" });
    // After a restart nothing holds it and the receipt is gone: in doubt, never printed.
    const restarted = createPrintRuntime(fakeHardware().hardware.printBytes, { windows });
    await expect(recoverInterruptedJobs(resolveContext(at.local, restarted))).resolves.toBe(1);
    expect(jobRows(at.db)[0]).toMatchObject({ state: "unknown", error_code: "interrupted" });
    await expect(restarted.checkWindowsJob("job-1")).resolves.toEqual({ state: "no_receipt" });
    expect(prints).toHaveLength(1);
  });

  it("is printed again only by the operator's decision, with a reason, once more through the driver on the same bytes", async () => {
    const at = await printStation(driverSettings);
    const job = await closeBoxWithLabel(at);
    const { windows, prints } = fakeWindows(inDoubt);
    const runtime = createPrintRuntime(fakeHardware().hardware.printBytes, { windows });
    const context = resolveContext(at.local, runtime);
    const unknown = await sendLabelJob(context, job);
    const render = spyRender(fakeRender);
    const { boxTemplate } = at.shift.snapshot;
    const template = { id: boxTemplate.id, rev: boxTemplate.rev, spec: boxTemplate.spec };
    await expect(
      printAgain(context, unknown, { reason: null, printer: null }, at.settings, template, render),
    ).rejects.toBeInstanceOf(UnresolvableJobError);
    expect(prints).toHaveLength(1);
    const again = await printAgain(
      context,
      unknown,
      { reason: "printer_jam", printer: null },
      at.settings,
      template,
      render,
    );
    expect(again).toMatchObject({ state: "unknown", errorCode: "driver_unknown", attempts: 2 });
    // The same driver profile, language and resolution: the frozen page goes again, not re-rendered.
    expect(render).not.toHaveBeenCalled();
    expect(prints).toHaveLength(2);
    expect(again.bytesBase64).toBe(unknown.bytesBase64);
  });

  it("is rendered again when a RAW job is printed again on a driver printer of the same language and resolution", async () => {
    const at = await printStation({
      printers: [GODEX, ZEBRA],
      assignments: { box: "zebra", pallet: null, duplicate: null },
    });
    const job = await closeBoxWithLabel(at);
    const shell = fakeHardware(async () => ({ sent: false, code: "not_sent" }));
    const { windows, prints } = fakeWindows(async () => ({
      sent: false,
      code: "geometry_mismatch",
    }));
    const runtime = createPrintRuntime(shell.hardware.printBytes, { windows });
    const context = resolveContext(at.local, runtime);
    const failed = await sendLabelJob(context, job);
    expect(failed.state).toBe("failed");
    const render = spyRender(fakeRender);
    const { boxTemplate } = at.shift.snapshot;
    const again = await printAgain(
      context,
      failed,
      { reason: null, printer: GODEX },
      at.settings,
      { id: boxTemplate.id, rev: boxTemplate.rev, spec: boxTemplate.spec },
      render,
    );
    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0]?.[2]).toEqual(GODEX);
    expect(again).toMatchObject({ state: "failed", errorCode: "geometry_mismatch" });
    expect(prints).toHaveLength(1);
    expect(shell.sends).toHaveLength(1);
  });
});

describe("a box closed on a printer in driver mode, end to end", () => {
  // The real renderer (jsdom has no canvas, so the text rasterizer is the fake one).
  const render: RenderLabel = (spec, fields, printer) =>
    renderLabel(spec, fields, printer, fakeRaster);

  it.each([203, 300] as const)(
    "freezes a mono-raster page at the profile's %i dpi and sends it once to the Windows queue",
    async (dpi) => {
      const godex: PrinterProfile = { ...GODEX, dpi };
      const at = await printStation({
        printers: [godex, ZEBRA],
        assignments: { box: "godex", pallet: null, duplicate: null },
      });
      const job = await closeBoxWithLabel(at, render);
      expect(job).toMatchObject({ state: "prepared", errorCode: null, printer: godex });
      // The frozen bytes are the driver page, not the printer language's text.
      const frozen = base64ToBytes(job.bytesBase64 ?? "");
      const page = decodeMonoRaster(frozen);
      const { widthMm, heightMm } = at.shift.snapshot.boxTemplate.spec;
      expect(page).toMatchObject({
        format: "mono-raster-v1",
        dpi,
        widthMm,
        heightMm,
        widthDots: mmToDots(widthMm, dpi),
        heightDots: mmToDots(heightMm, dpi),
      });
      const shell = fakeHardware();
      const sent: Uint8Array[] = [];
      const windows: WindowsPrinting = {
        supportsWindowsPrinting: vi.fn(async () => true),
        printWindowsRaster: vi.fn(
          async (queue: string, bytes: Uint8Array, documentName: string): Promise<PrintResult> => {
            sent.push(bytes);
            return { sent: true, receipt: { queue, jobId: 42, documentName } };
          },
        ),
        getWindowsPrintJob: vi.fn(async () => ({ state: "present" as const, statusFlags: 0 })),
      };
      const runtime = createPrintRuntime(shell.hardware.printBytes, {
        windows,
        newDocumentId: () => DOC_ID,
      });
      const after = await sendLabelJob(resolveContext(at.local, runtime), job);
      expect(after).toMatchObject({ state: "sent", attempts: 1 });
      expect(windows.printWindowsRaster).toHaveBeenCalledTimes(1);
      expect(windows.printWindowsRaster).toHaveBeenCalledWith(
        "Godex G500",
        expect.any(Uint8Array),
        `Markiro:${DOC_ID}`,
      );
      // Exactly the frozen page reaches the queue, and nothing goes RAW.
      expect(Array.from(sent[0] ?? [])).toEqual(Array.from(frozen));
      expect(shell.sends).toEqual([]);
    },
  );
});

describe("the print runtime's A4 paper (plan А4)", () => {
  it("passes the paper A4 to the shell's driver call, and nothing for a label", async () => {
    const shell = fakeHardware();
    const { windows, prints } = fakeWindows();
    const runtime = createPrintRuntime(shell.hardware.printBytes, {
      windows,
      newDocumentId: () => DOC_ID,
    });
    await runtime.send("job-1", GODEX.target, new Uint8Array([1]), "windows_driver", "a4");
    await runtime.send("job-2", GODEX.target, new Uint8Array([2]), "windows_driver");
    expect(vi.mocked(windows.printWindowsRaster).mock.calls).toEqual([
      ["Godex G500", new Uint8Array([1]), `Markiro:${DOC_ID}`, "a4"],
      ["Godex G500", new Uint8Array([2]), `Markiro:${DOC_ID}`],
    ]);
    expect(prints).toHaveLength(2);
    expect(shell.sends).toEqual([]);
  });

  it("never gives an A4 sheet to a RAW printer: refused as invalid_target, nothing sent", async () => {
    const shell = fakeHardware();
    const { windows, prints } = fakeWindows();
    const runtime = createPrintRuntime(shell.hardware.printBytes, { windows });
    for (const mode of ["raw", undefined] as const) {
      await expect(
        runtime.send("job-1", ZEBRA.target, new Uint8Array([1]), mode, "a4"),
      ).resolves.toEqual({ kind: "answered", result: { sent: false, code: "invalid_target" } });
    }
    expect(shell.sends).toEqual([]);
    expect(prints).toEqual([]);
    // A sheet bound for a Windows queue in RAW mode is refused too, whatever the queue.
    await expect(
      runtime.send("job-2", GODEX.target, new Uint8Array([1]), "raw", "a4"),
    ).resolves.toEqual({ kind: "answered", result: { sent: false, code: "invalid_target" } });
    expect(shell.sends).toEqual([]);
  });

  it("keeps the spooler receipt of a sheet like a label's", async () => {
    const shell = fakeHardware();
    const { windows } = fakeWindows();
    const runtime = createPrintRuntime(shell.hardware.printBytes, {
      windows,
      newDocumentId: () => DOC_ID,
    });
    await runtime.send("job-1", GODEX.target, new Uint8Array([1]), "windows_driver", "a4");
    await expect(runtime.checkWindowsJob("job-1")).resolves.toEqual({
      state: "present",
      statusFlags: 0,
    });
  });
});
