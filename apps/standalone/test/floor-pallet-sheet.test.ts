import {
  buildPalletSheetPresets,
  decodeMonoRaster,
  type MonoBitmap,
  type RasterizeTextFn,
} from "@markiro/domain";
import { describe, expect, it, vi } from "vitest";

import { reprintPallet } from "../src/floor/exceptions/pallet-exceptions.js";
import { shiftLabelRender } from "../src/floor/print/shift-render.js";
import {
  base64ToBytes,
  readPrintJob,
  recoverInterruptedJobs,
  sendLabelJob,
  UnsendableJobError,
  type PrintJob,
} from "../src/floor/print/print-jobs.js";
import {
  NoPrinterError,
  printAgain,
  printerForAgain,
  UnresolvableJobError,
} from "../src/floor/print/print-resolution.js";
import { createPrintRuntime } from "../src/floor/print/print-runtime.js";
import type { PrintResult, WindowsPrinting } from "../src/hardware/hardware.js";
import { logoToWire } from "../src/labels/logo.js";
import { closeBoxWithLabel } from "./support/printing.js";
import { PAIRING, rows } from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import {
  closeBoxOnPallet,
  palletContext,
  palletStation,
  type PalletStation,
} from "./support/pallets.js";
import {
  fakeRaster,
  GODEX_DRIVER,
  HP_A4,
  HP_LABEL,
  manualTimers,
  printingSettings,
  printStation,
  resolveContext,
  TSC,
  ZEBRA,
} from "./support/printing.js";

const LOGO: MonoBitmap = { width: 16, height: 8, stride: 2, pixels: new Uint8Array(16).fill(0xff) };
const [PORTRAIT] = buildPalletSheetPresets();
if (PORTRAIT === undefined) throw new Error("no stock sheet");
const FROZEN = {
  palletSheet: {
    id: "6a3f0c5e-1b2d-4e8f-9a7b-0c1d2e3f4a5b",
    name: PORTRAIT.name,
    revision: 1,
    spec: PORTRAIT.spec,
  },
  organization: { name: "ООО «Молочный завод»", inn: "7701234567", logo: logoToWire(LOGO) },
};

/** A text of 4 dots a character: jsdom has no canvas. */
const text: RasterizeTextFn = async (value, options) => {
  const width = Math.max(1, Math.min(value.length * 4, options.maxWidthPx ?? value.length * 4));
  const height = Math.ceil(options.fontSizePx * (options.lineHeight ?? 1.5));
  const stride = Math.ceil(width / 8);
  return {
    width,
    height,
    bytesPerRow: stride,
    totalBytes: stride * height,
    hex: "00".repeat(stride * height),
  };
};

/** The shell's driver printing: every print recorded with its paper, answered by `answer`. */
function fakeWindows(answer?: () => Promise<PrintResult>) {
  const prints: {
    queue: string;
    documentName: string;
    bytes: Uint8Array;
    paper: string | undefined;
  }[] = [];
  const windows: WindowsPrinting = {
    supportsWindowsPrinting: vi.fn(async () => true),
    printWindowsRaster: vi.fn(
      async (
        queue: string,
        bytes: Uint8Array,
        documentName: string,
        paper?: "a4",
      ): Promise<PrintResult> => {
        prints.push({ queue, documentName, bytes, paper });
        return answer !== undefined
          ? answer()
          : { sent: true, receipt: { queue, jobId: 9, documentName } };
      },
    ),
    getWindowsPrintJob: vi.fn(async () => ({ state: "present" as const, statusFlags: 0 })),
  };
  return { windows, prints };
}

function runtimeOf(shell: ReturnType<typeof fakeHardware>, windows: WindowsPrinting) {
  return createPrintRuntime(shell.hardware.printBytes, {
    windows,
    startTimer: manualTimers().startTimer,
  });
}

/** A station whose pallets print on the A4 printer; one box fills a pallet. */
async function a4Station(options: Parameters<typeof palletStation>[0] = {}) {
  const at = await palletStation({
    capacity: 1,
    frozen: FROZEN,
    settings: {
      printers: [ZEBRA, HP_A4, GODEX_DRIVER],
      assignments: { box: "zebra", pallet: "hp-a4", duplicate: null },
    },
    ...options,
  });
  return at;
}

function sheetRender(at: Pick<PalletStation, "shift">) {
  return shiftLabelRender(at.shift, { rasterize: fakeRaster, sheetRasterize: text });
}

/** The pallet jobs of the station, oldest first. */
async function palletJobs(at: PalletStation): Promise<PrintJob[]> {
  const found = rows(
    at.db,
    "SELECT id FROM floor_print_jobs WHERE purpose = 'pallet' ORDER BY rowid",
  );
  const jobs: PrintJob[] = [];
  for (const row of found) {
    const job = await readPrintJob(at.local, PAIRING, String(row["id"]));
    if (job !== null) jobs.push(job);
  }
  return jobs;
}

/** One box closes the pallet; answers its one prepared job. */
async function closedA4Pallet(at: PalletStation): Promise<PrintJob> {
  const closed = await closeBoxOnPallet(at, ["A1"], palletContext(at, { render: sheetRender(at) }));
  if (closed.kind !== "closed") throw new Error(closed.kind);
  const [job] = await palletJobs(at);
  if (job === undefined) throw new Error("the pallet closed without its job");
  return job;
}

describe("a pallet closes onto an A4 printer (plan А4)", () => {
  it("prepares the pallet's sheet from the shift's snapshot: one job, A4 bytes, the thermal pallet template", async () => {
    const at = await a4Station();
    const job = await closedA4Pallet(at);
    expect(await palletJobs(at)).toHaveLength(1);
    expect(job).toMatchObject({
      purpose: "pallet",
      state: "prepared",
      printer: HP_A4,
      errorCode: null,
      attempts: 0,
      templateId: at.pallets.template.id,
      templateRev: 63,
    });
    const page = decodeMonoRaster(base64ToBytes(job.bytesBase64 ?? ""));
    expect(page).toMatchObject({ widthMm: 210, heightMm: 297, dpi: 300 });
    // The box's own label is the thermal one, for the box printer.
    const [box] = rows(at.db, "SELECT printer FROM floor_print_jobs WHERE purpose = 'box'");
    expect(JSON.parse(String(box?.["printer"]))).toMatchObject({ id: "zebra" });
    expect(rows(at.db, "SELECT count(*) AS n FROM outbox WHERE kind = 'pallet_closed'")).toEqual([
      { n: 1 },
    ]);
  });

  it("prints a thermal label, not a sheet, when the pallet printer is not A4", async () => {
    const at = await a4Station({
      settings: {
        printers: [ZEBRA, HP_A4],
        assignments: { box: "zebra", pallet: "zebra", duplicate: null },
      },
    });
    const job = await closedA4Pallet(at);
    expect(job.printer).toEqual(ZEBRA);
    expect(new TextDecoder().decode(base64ToBytes(job.bytesBase64 ?? ""))).toContain("^XA");
  });

  it("keeps the pallet closed and its job failed, with no bytes, when the shift froze no sheet", async () => {
    const at = await a4Station({ frozen: { organization: FROZEN.organization } });
    const job = await closedA4Pallet(at);
    expect(job).toMatchObject({
      state: "failed",
      errorCode: "render_failed",
      bytesBase64: null,
      printer: HP_A4,
    });
    expect(rows(at.db, "SELECT closed_at IS NOT NULL AS closed FROM floor_pallets")).toEqual([
      { closed: 1 },
    ]);
    // Nothing can be sent from it: not as it is, and not by the runtime.
    const shell = fakeHardware();
    const { windows, prints } = fakeWindows();
    await expect(
      sendLabelJob(resolveContext(at.local, runtimeOf(shell, windows)), job),
    ).rejects.toBeInstanceOf(UnsendableJobError);
    expect(prints).toEqual([]);
    expect(shell.sends).toEqual([]);
  });

  it("keeps the pallet closed and its job failed when the shift froze no organization", async () => {
    const at = await a4Station({ frozen: { palletSheet: FROZEN.palletSheet } });
    const job = await closedA4Pallet(at);
    expect(job).toMatchObject({ state: "failed", errorCode: "render_failed", bytesBase64: null });
  });

  it("sends the sheet once through the Windows driver with the paper A4, never RAW, and settles it sent", async () => {
    const at = await a4Station();
    const job = await closedA4Pallet(at);
    const shell = fakeHardware();
    const { windows, prints } = fakeWindows();
    const sent = await sendLabelJob(resolveContext(at.local, runtimeOf(shell, windows)), job);
    expect(sent).toMatchObject({ state: "sent", attempts: 1 });
    expect(prints).toHaveLength(1);
    expect(prints[0]).toMatchObject({ queue: "HP LaserJet", paper: "a4" });
    expect(Array.from(prints[0]?.bytes ?? [])).toEqual(
      Array.from(base64ToBytes(job.bytesBase64 ?? "")),
    );
    expect(prints[0]?.documentName).toMatch(/^Markiro:[0-9a-f-]{36}$/);
    expect(shell.sends).toEqual([]);
  });

  it("sends a thermal driver label without the paper", async () => {
    const at = await a4Station({
      settings: {
        printers: [ZEBRA, GODEX_DRIVER],
        assignments: { box: "zebra", pallet: "godex", duplicate: null },
      },
    });
    const job = await closedA4Pallet(at);
    const { windows, prints } = fakeWindows();
    await sendLabelJob(resolveContext(at.local, runtimeOf(fakeHardware(), windows)), job);
    expect(prints).toHaveLength(1);
    expect(prints[0]?.paper).toBeUndefined();
    expect(vi.mocked(windows.printWindowsRaster).mock.calls[0]).toHaveLength(3);
  });

  it("waits for the operator after a send in doubt: never sent again by itself, again only with a reason", async () => {
    const at = await a4Station();
    const job = await closedA4Pallet(at);
    const shell = fakeHardware();
    const { windows, prints } = fakeWindows(async () => ({ sent: false, code: "driver_unknown" }));
    const runtime = runtimeOf(shell, windows);
    const context = resolveContext(at.local, runtime);
    const doubtful = await sendLabelJob(context, job);
    expect(doubtful).toMatchObject({ state: "unknown", errorCode: "driver_unknown" });
    // The recovery moves nothing on and sends nothing.
    await expect(recoverInterruptedJobs(context)).resolves.toBe(0);
    expect(prints).toHaveLength(1);
    // The panel's «Напечатать снова» needs the reason; without it nothing is sent.
    await expect(
      printAgain(
        context,
        doubtful,
        { reason: null, printer: null },
        at.settings,
        at.pallets.template,
      ),
    ).rejects.toBeInstanceOf(UnresolvableJobError);
    expect(prints).toHaveLength(1);
    // With a reason it is a new send of the very same sheet bytes (the printer's settings are the job's).
    const { windows: ok, prints: second } = fakeWindows();
    const again = await printAgain(
      resolveContext(at.local, runtimeOf(shell, ok)),
      doubtful,
      { reason: "damaged_label", printer: null },
      at.settings,
      at.pallets.template,
      sheetRender(at),
    );
    expect(again).toMatchObject({ state: "sent", attempts: 2 });
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ paper: "a4" });
    expect(Array.from(second[0]?.bytes ?? [])).toEqual(
      Array.from(base64ToBytes(job.bytesBase64 ?? "")),
    );
  });

  it("reads a sheet found `sending` after a restart as unknown and does not send it", async () => {
    const at = await a4Station();
    const job = await closedA4Pallet(at);
    at.db
      .prepare("UPDATE floor_print_jobs SET state = 'sending', attempts = 1 WHERE id = ?")
      .run(job.id);
    const { windows, prints } = fakeWindows();
    const context = resolveContext(at.local, runtimeOf(fakeHardware(), windows));
    await expect(recoverInterruptedJobs(context)).resolves.toBe(1);
    const after = await readPrintJob(at.local, PAIRING, job.id);
    expect(after).toMatchObject({ state: "unknown", errorCode: "interrupted" });
    expect(prints).toEqual([]);
  });
});

describe("«Напечатать снова» and «Другой принтер» of a pallet's sheet (plan А4)", () => {
  async function failedSheetJob(at: PalletStation) {
    const job = await closedA4Pallet(at);
    const { windows } = fakeWindows(async () => ({ sent: false, code: "queue_unavailable" }));
    return sendLabelJob(resolveContext(at.local, runtimeOf(fakeHardware(), windows)), job);
  }

  it("reuses the sheet's bytes for the same A4 printer", async () => {
    const at = await a4Station();
    const failed = await failedSheetJob(at);
    expect(failed.state).toBe("failed");
    const render = vi.fn(sheetRender(at));
    const { windows, prints } = fakeWindows();
    const again = await printAgain(
      resolveContext(at.local, runtimeOf(fakeHardware(), windows)),
      failed,
      { reason: null, printer: null },
      at.settings,
      at.pallets.template,
      render,
    );
    expect(render).not.toHaveBeenCalled();
    expect(again).toMatchObject({ state: "sent", attempts: 2 });
    expect(prints[0]?.paper).toBe("a4");
  });

  it("renders the thermal label again for a label printer, from the snapshot's pallet template", async () => {
    const at = await a4Station();
    const failed = await failedSheetJob(at);
    const render = vi.fn(sheetRender(at));
    const shell = fakeHardware();
    const again = await printAgain(
      resolveContext(at.local, runtimeOf(shell, fakeWindows().windows)),
      failed,
      { reason: null, printer: ZEBRA },
      at.settings,
      at.pallets.template,
      render,
    );
    expect(render).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledWith(at.pallets.template.spec, failed.fields, ZEBRA);
    expect(again.printer).toEqual(ZEBRA);
    expect(shell.sends).toHaveLength(1);
    expect(shell.sends[0]?.text).toContain("^XA");
  });

  it("renders the sheet again when a label printer's job goes to an A4 printer", async () => {
    const at = await a4Station({
      settings: {
        printers: [ZEBRA, HP_A4],
        assignments: { box: "zebra", pallet: "zebra", duplicate: null },
      },
    });
    const job = await closedA4Pallet(at);
    const shell = fakeHardware(async () => ({ sent: false, code: "not_sent" }));
    const failed = await sendLabelJob(
      resolveContext(at.local, runtimeOf(shell, fakeWindows().windows)),
      job,
    );
    expect(failed.state).toBe("failed");
    const render = vi.fn(sheetRender(at));
    const { windows, prints } = fakeWindows();
    const again = await printAgain(
      resolveContext(at.local, runtimeOf(fakeHardware(), windows)),
      failed,
      { reason: null, printer: HP_A4 },
      at.settings,
      at.pallets.template,
      render,
    );
    expect(render).toHaveBeenCalledWith(at.pallets.template.spec, failed.fields, HP_A4);
    expect(again).toMatchObject({ state: "sent", printer: HP_A4 });
    expect(decodeMonoRaster(prints[0]?.bytes ?? new Uint8Array()).widthMm).toBe(210);
    expect(prints[0]?.paper).toBe("a4");
  });

  it("renders the sheet again for the very printer settings of a label when only the paper differs", async () => {
    // Same queue, driver, language and 300 dpi: the profiles differ in the paper alone.
    const labelProfile = HP_LABEL;
    const at = await a4Station({
      settings: {
        printers: [labelProfile, ZEBRA],
        assignments: { box: "zebra", pallet: "hp-a4", duplicate: null },
      },
    });
    const job = await closedA4Pallet(at);
    expect(job.printer).toEqual(labelProfile);
    const { windows: failing } = fakeWindows(async () => ({
      sent: false,
      code: "queue_unavailable",
    }));
    const failed = await sendLabelJob(
      resolveContext(at.local, runtimeOf(fakeHardware(), failing)),
      job,
    );
    const render = vi.fn(sheetRender(at));
    const { windows, prints } = fakeWindows();
    const again = await printAgain(
      resolveContext(at.local, runtimeOf(fakeHardware(), windows)),
      failed,
      { reason: null, printer: HP_A4 },
      at.settings,
      at.pallets.template,
      render,
    );
    expect(render).toHaveBeenCalledTimes(1);
    expect(decodeMonoRaster(prints[0]?.bytes ?? new Uint8Array()).widthMm).toBe(210);
    expect(again.printer).toEqual(HP_A4);
  });
});

describe("a closed pallet's sheet is printed again with a new job and no new identity (plan А4)", () => {
  it("makes one new job with the same SSCC and fields, the same sheet bytes, sent with the paper A4", async () => {
    const at = await a4Station();
    const job = await closedA4Pallet(at);
    const first = fakeWindows();
    const sent = await sendLabelJob(
      resolveContext(at.local, runtimeOf(fakeHardware(), first.windows)),
      job,
    );
    expect(sent.state).toBe("sent");
    const second = fakeWindows();
    const reprinted = await reprintPallet(
      { ...resolveContext(at.local, runtimeOf(fakeHardware(), second.windows)), shift: at.shift },
      at.pallets,
      job.subjectId,
      { code: "damaged_label", text: null },
      at.settings,
      sheetRender(at),
    );
    expect(reprinted).toMatchObject({
      state: "sent",
      sscc: job.sscc,
      fields: job.fields,
      printer: HP_A4,
      subjectId: job.subjectId,
    });
    expect(reprinted.id).not.toBe(job.id);
    expect(second.prints).toHaveLength(1);
    expect(second.prints[0]?.paper).toBe("a4");
    expect(Array.from(second.prints[0]?.bytes ?? [])).toEqual(
      Array.from(first.prints[0]?.bytes ?? [1]),
    );
    expect(await palletJobs(at)).toHaveLength(2);
    // One pallet, one SSCC, one closing record: the reprint is an exception, not a new pallet.
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_pallets")).toEqual([{ n: 1 }]);
    expect(rows(at.db, "SELECT count(*) AS n FROM outbox WHERE kind = 'pallet_closed'")).toEqual([
      { n: 1 },
    ]);
    expect(rows(at.db, "SELECT count(*) AS n FROM outbox WHERE kind = 'pallet_exception'")).toEqual(
      [{ n: 1 }],
    );
  });
});

describe("an A4 printer takes no box label (plan А4)", () => {
  async function failedBoxJob(at: Awaited<ReturnType<typeof printStation>>) {
    const job = await closeBoxWithLabel(at);
    const shell = fakeHardware(async () => ({ sent: false, code: "not_sent" }));
    return sendLabelJob(resolveContext(at.local, runtimeOf(shell, fakeWindows().windows)), job);
  }

  function template(at: Awaited<ReturnType<typeof printStation>>) {
    const { id, rev, spec } = at.shift.snapshot.boxTemplate;
    return { id, rev, spec };
  }

  it("is refused for a box's «Другой принтер», changing and sending nothing", async () => {
    const at = await printStation({ printers: [ZEBRA, HP_A4] });
    const failed = await failedBoxJob(at);
    expect(failed.state).toBe("failed");
    const shell = fakeHardware();
    const { windows, prints } = fakeWindows();
    const render = vi.fn(async () => new Uint8Array([1]));
    await expect(
      printAgain(
        resolveContext(at.local, runtimeOf(shell, windows)),
        failed,
        { reason: null, printer: HP_A4 },
        at.settings,
        template(at),
        render,
      ),
    ).rejects.toBeInstanceOf(NoPrinterError);
    expect(render).not.toHaveBeenCalled();
    expect(prints).toEqual([]);
    expect(shell.sends).toEqual([]);
    expect(rows(at.db, "SELECT state, attempts FROM floor_print_jobs")).toEqual([
      { state: "failed", attempts: 1 },
    ]);
  });

  it("is not the box's own printer either, once its profile was changed to A4", () => {
    const job = { printer: ZEBRA, purpose: "box" } as const;
    const changed = { ...HP_A4, id: ZEBRA.id };
    const settings = printingSettings({ printers: [changed, TSC] });
    expect(printerForAgain(job, settings, null)).toBeNull();
    expect(printerForAgain(job, settings, TSC)).toEqual(TSC);
    // The purpose's printer, even if a settings object that was not read says A4 for a box.
    const raw = {
      printers: [HP_A4],
      assignments: { box: "hp-a4", pallet: "hp-a4", duplicate: null },
    };
    expect(printerForAgain({ printer: null, purpose: "box" }, raw, null)).toBeNull();
    expect(printerForAgain({ printer: null, purpose: "pallet" }, raw, null)).toEqual(HP_A4);
    expect(printerForAgain({ printer: null, purpose: "pallet" }, raw, ZEBRA)).toEqual(ZEBRA);
  });
});
