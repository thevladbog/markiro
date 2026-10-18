import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildPalletSheetPresets,
  decodeMonoRaster,
  type MonoBitmap,
  type RasterizeTextFn,
} from "@markiro/domain";

import * as LabelRender from "../src/floor/print/label-render.js";
import type { PrintRuntime, SendOutcome } from "../src/floor/print/print-runtime.js";
import { LOGO_UNAVAILABLE_LINE } from "../src/floor/print/shift-render.js";
import type {
  PrinterProfile,
  WorkstationSettings,
} from "../src/floor/setup/workstation-settings.js";
import { keepEnteredShift } from "../src/floor/shifts/shift-copies.js";
import { readKnownOrganizationLogo } from "../src/floor/warehouse/warehouse-logo.js";
import {
  reprintScan,
  sendWarehouseJob,
  prepareWarehouseJob,
  WarehousePrinterError,
  type WarehouseContext,
} from "../src/floor/warehouse/warehouse-work.js";
import { SHEET_AUTO, sheetChoiceOf } from "../src/floor/warehouse/warehouse-sheet.js";
import { readJob, startSession } from "../src/floor/warehouse/warehouse-store.js";
import type { PrintResult, PrintTarget } from "../src/hardware/hardware.js";
import type {
  EnteredShift,
  PalletSheets,
  WarehouseLookupResult,
  WarehouseSource,
} from "../src/host/protocol.js";
import * as Rasterizer from "../src/labels/rasterizer.js";
import { ENTERED, OPERATOR_ID, PAIRING, rows } from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";
import { GODEX_DRIVER, HP_A4, setUpPrinting, TSC, ZEBRA } from "./support/printing.js";
import {
  BOX_SOURCE,
  BOX_SSCC,
  BOX_TEMPLATE,
  KM,
  PALLET_SOURCE,
  PALLET_SSCC,
  PALLET_TEMPLATE,
  seedWarehouseCopies,
  UNIT_SOURCE,
  UNIT_TEMPLATE,
} from "./support/warehouse.js";

// The app's own rasterizers, replaced by spies that draw a blank line (jsdom has
// no canvas): the tests see which one a reprint's render hands the label (plan
// ДРВ: a driver page only from the bundled face; a RAW label the best-effort one).
vi.mock("../src/labels/rasterizer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof Rasterizer>();
  const blank: RasterizeTextFn = async (_text, options) => {
    const width = Math.max(1, Math.min(8, options.maxWidthPx ?? 8));
    const height = Math.ceil(options.fontSizePx * (options.lineHeight ?? 1.5));
    return { width, height, bytesPerRow: 1, totalBytes: height, hex: "00".repeat(height) };
  };
  return { ...actual, rasterizeText: vi.fn(blank), rasterizeDriverText: vi.fn(blank) };
});

// The real `renderLabel`, watched: which rasterizer, logo and options a reprint hands it.
vi.mock("../src/floor/print/label-render.js", async (importOriginal) => {
  const actual = await importOriginal<typeof LabelRender>();
  return { ...actual, renderLabel: vi.fn(actual.renderLabel) };
});

const SESSION = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
const OTHER_DEVICE = "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a";

/** The bundled Markiro logo, as a test gives it: one row of eight dots. */
const MARKIRO: MonoBitmap = { width: 8, height: 1, stride: 1, pixels: Uint8Array.of(0xff) };

/** A logo as a snapshot freezes it, and the bitmap the station reads from it. */
function logo(pixelsBase64: string, bytes: number[]) {
  return {
    wire: { width: 10, height: 2, pixelsBase64 },
    bitmap: { width: 10, height: 2, stride: 2, pixels: Uint8Array.from(bytes) } as MonoBitmap,
  };
}
const OLDER = logo("8MAPQA==", [0xf0, 0xc0, 0x0f, 0x40]);
const NEWER = logo("wMAAQA==", [0xc0, 0xc0, 0x00, 0x40]);
const OTHERS = logo("gEAAQA==", [0x80, 0x40, 0x00, 0x40]);

interface Sent {
  jobId: string | null;
  target: PrintTarget;
  bytes: Uint8Array;
  mode: string | undefined;
  paper: string | undefined;
}

/** A print runtime that keeps every send as it was asked and answers from `answers` (else sent). */
function fakeRuntime(answers: PrintResult[] = []) {
  const sends: Sent[] = [];
  const runtime: PrintRuntime = {
    send: vi.fn(async (jobId, target, bytes, mode, paper): Promise<SendOutcome> => {
      sends.push({ jobId, target, bytes, mode, paper });
      return { kind: "answered", result: answers.shift() ?? { sent: true } };
    }),
    isInFlight: () => false,
    inFlight: () => [],
    checkWindowsJob: async () => ({ state: "no_receipt" }),
    supportsWindowsDriver: async () => true,
  };
  return { runtime, sends };
}

const [PORTRAIT_SHEET] = buildPalletSheetPresets();
if (PORTRAIT_SHEET === undefined) throw new Error("no stock sheet");
const SHEET_SPEC = PORTRAIT_SHEET.spec;
const SHEET_ID = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
const OTHER_SHEET_ID = "6b7c8d9e-0f1a-4b2c-9d3e-4f5a6b7c8d9e";

/** The sheets the host lists: the stock portrait sheet, and another one off the default. */
function hostSheets(defaultId: string | null = SHEET_ID): PalletSheets {
  return {
    sheets: [
      {
        id: SHEET_ID,
        name: "Вертикальная",
        enabled: true,
        presetKey: null,
        revision: 3,
        spec: SHEET_SPEC,
      },
      {
        id: OTHER_SHEET_ID,
        name: "Другая",
        enabled: true,
        presetKey: null,
        revision: 1,
        spec: SHEET_SPEC,
      },
    ],
    defaultId,
  };
}

/** A station with the warehouse copies, `printers` assigned so, and an open session. */
async function station(
  printers: PrinterProfile[],
  assignments: WorkstationSettings["assignments"],
  options: {
    answers?: PrintResult[];
    fallbackLogo?: () => Promise<MonoBitmap>;
    sheets?: WarehouseContext["sheets"];
    pallet?: string;
  } = {},
) {
  const { db, executor } = openLocalDb();
  seedWarehouseCopies(db);
  await setUpPrinting(executor, { printers, assignments });
  const { runtime, sends } = fakeRuntime(options.answers);
  const fallbackLogo = vi.fn(options.fallbackLogo ?? (async () => MARKIRO));
  const report = vi.fn();
  let tick = Date.parse("2026-10-09T07:00:00.000Z");
  let id = 0;
  const context: WarehouseContext = {
    local: executor,
    pairing: PAIRING,
    runtime,
    now: () => new Date((tick += 1000)),
    newId: () => `00000000-0000-4000-8000-${String((id += 1)).padStart(12, "0")}`,
    labelDeps: {
      fallbackLogo,
      report,
      // The sheet's text and the bundled logo, as the tests of the shift's sheet give them.
      sheetRasterize: async (_text, textOptions) => ({
        width: 8,
        height: Math.ceil(textOptions.fontSizePx * (textOptions.lineHeight ?? 1.5)),
        bytesPerRow: 1,
        totalBytes: Math.ceil(textOptions.fontSizePx * (textOptions.lineHeight ?? 1.5)),
        hex: "00".repeat(Math.ceil(textOptions.fontSizePx * (textOptions.lineHeight ?? 1.5))),
      }),
      loadMarkiro: async () => MARKIRO,
    },
    ...(options.sheets === undefined ? {} : { sheets: options.sheets }),
  };
  const session = await startSession(executor, PAIRING, {
    id: SESSION,
    reason: "damaged",
    templates: {
      unit: UNIT_TEMPLATE,
      box: BOX_TEMPLATE,
      pallet: options.pallet ?? PALLET_TEMPLATE,
    },
    operatorId: OPERATOR_ID,
    at: "2026-10-09T07:00:00.000Z",
  });
  return { db, local: executor, context, session, sends, fallbackLogo, report };
}

type Station = Awaited<ReturnType<typeof station>>;

function reprint(at: Station, raw: string, source: WarehouseSource) {
  return reprintScan(at.context, {
    session: at.session,
    raw,
    operatorId: OPERATOR_ID,
    online: true,
    ask: async (): Promise<WarehouseLookupResult> => ({ status: "found", source }),
  });
}

/** A shift this pairing (or another) entered, its snapshot freezing `organization`. */
async function keepShift(
  at: Station,
  shift: { id: string; openedAt: string; organization?: unknown; deviceId?: string },
) {
  const entered = {
    ...ENTERED,
    id: shift.id,
    openedAt: shift.openedAt,
    snapshot: {
      ...ENTERED.snapshot,
      ...(shift.organization === undefined ? {} : { organization: shift.organization }),
    },
  } as EnteredShift;
  await keepEnteredShift(
    at.local,
    { ...PAIRING, deviceId: shift.deviceId ?? PAIRING.deviceId },
    entered,
    shift.openedAt,
    1_790_000_000_000,
  );
}

/** The arguments of the last `renderLabel` call: spec, fields, printer, rasterize, logo, options. */
function lastRender(): unknown[] {
  const calls = vi.mocked(LabelRender.renderLabel).mock.calls;
  const last = calls[calls.length - 1];
  if (last === undefined) throw new Error("nothing was rendered");
  return last;
}

function text(bytes: Uint8Array | undefined): string {
  return Array.from(bytes ?? [], (byte) => String.fromCharCode(byte)).join("");
}

beforeEach(() => {
  vi.mocked(LabelRender.renderLabel).mockClear();
  vi.mocked(Rasterizer.rasterizeText).mockClear();
  vi.mocked(Rasterizer.rasterizeDriverText).mockClear();
});

describe("a warehouse reprint's logo (plan СКЛ × А4, the shift labels' rule)", () => {
  it("prints the organization logo of the newest shift snapshot this pairing keeps", async () => {
    const at = await station([ZEBRA], { box: "zebra", pallet: "zebra", duplicate: null });
    // Stored newest first and with the lower id, so the order is the opening's, neither the
    // insertion's nor the id's.
    await keepShift(at, {
      id: "11111111-1111-4111-8111-111111111111",
      openedAt: "2026-10-08T06:00:00Z",
      organization: { name: "Завод", inn: null, logo: NEWER.wire },
    });
    await keepShift(at, {
      id: "11111111-1111-4111-8111-111111111112",
      openedAt: "2026-10-07T06:00:00Z",
      organization: { name: "Завод", inn: null, logo: OLDER.wire },
    });
    // Another pairing's newer shift (kept by a forget) is not this station's knowledge.
    await keepShift(at, {
      id: "11111111-1111-4111-8111-111111111113",
      openedAt: "2026-10-09T06:00:00Z",
      organization: { name: "Другой", inn: null, logo: OTHERS.wire },
      deviceId: OTHER_DEVICE,
    });
    const outcome = await reprint(at, PALLET_SSCC, PALLET_SOURCE);
    expect(outcome).toMatchObject({ kind: "printed", job: { state: "sent" } });
    const [, , printer, rasterize, drawn, options] = lastRender();
    expect(printer).toMatchObject({ id: "zebra" });
    expect(rasterize).toBeUndefined();
    expect(drawn).toEqual(NEWER.bitmap);
    expect(options).toEqual({});
    expect(at.fallbackLogo).not.toHaveBeenCalled();
    expect(await readKnownOrganizationLogo(at.local, PAIRING)).toEqual(NEWER.bitmap);
  });

  it.each([
    ["no shift snapshot at all", undefined],
    ["a snapshot of a host before plan А4 (no organization)", "none"],
    ["an organization that froze no logo", { name: "Завод", inn: null, logo: null }],
    [
      "a logo this build cannot read",
      { name: "Завод", inn: null, logo: { width: 10, height: 2, pixelsBase64: "%%%" } },
    ],
  ] as const)("takes the bundled Markiro logo with %s", async (_name, organization) => {
    const at = await station([ZEBRA], { box: "zebra", pallet: "zebra", duplicate: null });
    if (organization !== undefined) {
      await keepShift(at, {
        id: "11111111-1111-4111-8111-111111111111",
        openedAt: "2026-10-08T06:00:00Z",
        ...(organization === "none" ? {} : { organization }),
      });
    }
    expect(await readKnownOrganizationLogo(at.local, PAIRING)).toBeNull();
    await reprint(at, PALLET_SSCC, PALLET_SOURCE);
    expect(lastRender()[4]).toEqual(MARKIRO);
    expect(at.fallbackLogo).toHaveBeenCalledTimes(1);
  });

  it("draws a unit's code as the shared raster through the same render", async () => {
    const at = await station([ZEBRA, TSC], { box: "zebra", pallet: null, duplicate: "tsc" });
    const outcome = await reprint(at, KM, UNIT_SOURCE);
    expect(outcome).toMatchObject({ kind: "printed", job: { state: "sent", kind: "unit" } });
    const [, , printer, rasterize, , options] = lastRender();
    expect(printer).toMatchObject({ id: "tsc" });
    expect(rasterize).toBeUndefined();
    expect(options).toEqual({ kmDataMatrix: "raster" });
    expect(at.sends[0]).toMatchObject({ mode: "raw", target: TSC.target });
  });

  it("reads no logo for a layout without a logo box", async () => {
    const at = await station([ZEBRA], { box: "zebra", pallet: "zebra", duplicate: null });
    await keepShift(at, {
      id: "11111111-1111-4111-8111-111111111111",
      openedAt: "2026-10-08T06:00:00Z",
      organization: { name: "Завод", inn: null, logo: OLDER.wire },
    });
    await reprint(at, BOX_SSCC, BOX_SOURCE);
    expect(lastRender()[4]).toBeNull();
    expect(at.fallbackLogo).not.toHaveBeenCalled();
  });

  it("prints a label whose logo cannot be had with the box empty, and says so once", async () => {
    const at = await station(
      [ZEBRA],
      { box: "zebra", pallet: "zebra", duplicate: null },
      {
        fallbackLogo: () => Promise.reject(new Error("no picture")),
      },
    );
    const outcome = await reprint(at, PALLET_SSCC, PALLET_SOURCE);
    expect(outcome).toMatchObject({ kind: "printed", job: { state: "sent" } });
    expect(lastRender()[4]).toBeNull();
    expect(at.report.mock.calls).toEqual([[LOGO_UNAVAILABLE_LINE]]);
    expect(at.sends).toHaveLength(1);
  });
});

describe("a warehouse reprint on a printer in driver mode (plan ДРВ)", () => {
  it("sends a box through the Windows driver as a page drawn with the bundled face only", async () => {
    const at = await station([GODEX_DRIVER], { box: "godex", pallet: null, duplicate: null });
    const outcome = await reprint(at, BOX_SSCC, BOX_SOURCE);
    expect(outcome).toMatchObject({ kind: "printed", job: { state: "sent" } });
    expect(at.sends).toHaveLength(1);
    expect(at.sends[0]).toMatchObject({ mode: "windows_driver", target: GODEX_DRIVER.target });
    expect(at.sends[0]?.paper).toBeUndefined();
    const page = decodeMonoRaster(at.sends[0]?.bytes ?? new Uint8Array());
    expect(page.dpi).toBe(203);
    expect(Rasterizer.rasterizeDriverText).toHaveBeenCalled();
    expect(Rasterizer.rasterizeText).not.toHaveBeenCalled();
  });

  it("sends a RAW printer its language, drawn with the best-effort rasterizer, as RAW", async () => {
    const at = await station([ZEBRA, TSC], { box: "zebra", pallet: null, duplicate: null });
    await reprint(at, BOX_SSCC, BOX_SOURCE);
    expect(at.sends[0]).toMatchObject({ mode: "raw", target: ZEBRA.target });
    expect(at.sends[0]?.paper).toBeUndefined();
    expect(text(at.sends[0]?.bytes)).toContain("^XA");
    expect(Rasterizer.rasterizeText).toHaveBeenCalled();
    expect(Rasterizer.rasterizeDriverText).not.toHaveBeenCalled();
  });

  it("refuses a driver page when the bundled face is unavailable: render_failed, nothing sent", async () => {
    const at = await station([GODEX_DRIVER], { box: "godex", pallet: null, duplicate: null });
    vi.mocked(Rasterizer.rasterizeDriverText).mockRejectedValue(
      new Rasterizer.RasterUnavailableError("The bundled label font is unavailable"),
    );
    try {
      const outcome = await reprint(at, BOX_SSCC, BOX_SOURCE);
      expect(outcome).toMatchObject({
        kind: "printed",
        job: { state: "failed", errorCode: "render_failed" },
      });
    } finally {
      vi.mocked(Rasterizer.rasterizeDriverText).mockReset();
    }
    expect(at.sends).toEqual([]);
    expect(Rasterizer.rasterizeText).not.toHaveBeenCalled();
  });

  it("renders a retry again for a printer whose mode changed, so RAW bytes never reach a driver queue", async () => {
    // The same queue's language and resolution: only the mode differs.
    const at = await station(
      [ZEBRA],
      { box: "zebra", pallet: null, duplicate: null },
      {
        answers: [{ sent: false, code: "not_sent" }],
      },
    );
    const first = await reprint(at, BOX_SSCC, BOX_SOURCE);
    if (first.kind !== "printed") throw new Error("printed");
    expect(first.job).toMatchObject({ state: "failed", errorCode: "not_sent" });
    expect(text(at.sends[0]?.bytes)).toContain("^XA");
    await setUpPrinting(at.local, {
      printers: [{ ...GODEX_DRIVER, language: ZEBRA.language, dpi: ZEBRA.dpi }],
      assignments: { box: "godex", pallet: null, duplicate: null },
    });
    const after = await sendWarehouseJob(at.context, first.job, { kind: "retry" }, OPERATOR_ID);
    expect(after).toMatchObject({ state: "sent", attempts: 2 });
    expect(at.sends).toHaveLength(2);
    expect(at.sends[1]).toMatchObject({ mode: "windows_driver" });
    expect(decodeMonoRaster(at.sends[1]?.bytes ?? new Uint8Array()).dpi).toBe(203);
  });
});

describe("a warehouse reprint and a printer of A4 sheets (plan А4)", () => {
  const A4_PALLETS = { box: "zebra", pallet: "hp-a4", duplicate: null };

  it("prints a pallet's A4 sheet, the session's default one, on the printer of sheets, and freezes the sheet", async () => {
    const sheets = vi.fn(async () => hostSheets());
    const at = await station([ZEBRA, HP_A4], A4_PALLETS, { sheets, pallet: SHEET_AUTO });
    const outcome = await reprint(at, PALLET_SSCC, PALLET_SOURCE);
    expect(outcome).toMatchObject({
      kind: "printed",
      job: {
        state: "sent",
        errorCode: null,
        templateId: SHEET_ID,
        templateRev: 3,
        printer: { id: "hp-a4", paper: "a4" },
      },
    });
    // The default is asked of the host for the pallet's own product (its, its category's, the organization's).
    expect(sheets).toHaveBeenCalledWith(PALLET_SOURCE.product.id);
    // The page is the sheet at A4 and goes to the printer of sheets as a sheet, not as a label.
    expect(at.sends).toHaveLength(1);
    expect(at.sends[0]?.paper).toBe("a4");
    const page = decodeMonoRaster(at.sends[0]?.bytes ?? new Uint8Array());
    expect(page.widthMm).toBeCloseTo(210, 1);
    expect(page.heightMm).toBeCloseTo(297, 1);
    expect(LabelRender.renderLabel).not.toHaveBeenCalled();
    expect(
      rows(at.db, "SELECT payload FROM wh_outbox").map((row) => JSON.parse(String(row["payload"]))),
    ).toEqual([expect.objectContaining({ outcome: "sent", templateId: SHEET_ID, templateRev: 3 })]);
  });

  it("prints the sheet the session chose, not the product's default", async () => {
    const at = await station([ZEBRA, HP_A4], A4_PALLETS, {
      sheets: async () => hostSheets(),
      pallet: sheetChoiceOf(OTHER_SHEET_ID),
    });
    const outcome = await reprint(at, PALLET_SSCC, PALLET_SOURCE);
    expect(outcome).toMatchObject({
      kind: "printed",
      job: { state: "sent", templateId: OTHER_SHEET_ID, templateRev: 1 },
    });
  });

  it("refuses a pallet on a printer of sheets while the session holds a label template, a sheet that is gone, or no answer of the host", async () => {
    const at = await station([ZEBRA, HP_A4], A4_PALLETS, { sheets: async () => hostSheets() });
    const prepare = (station: Station) =>
      prepareWarehouseJob(station.context, {
        session: station.session,
        source: PALLET_SOURCE,
        repair: null,
        operatorId: OPERATOR_ID,
      });
    // The session chose a label template of the copies: no sheet.
    expect(await prepare(at)).toEqual({ kind: "refused", reason: "no_sheet" });
    const gone = await station([ZEBRA, HP_A4], A4_PALLETS, {
      sheets: async () => hostSheets(null),
      pallet: SHEET_AUTO,
    });
    // No default for the product, and none chosen: nothing to print.
    expect(await prepare(gone)).toEqual({ kind: "refused", reason: "template_unavailable" });
    const silent = await station([ZEBRA, HP_A4], A4_PALLETS, {
      sheets: async () => {
        throw new Error("offline");
      },
      pallet: SHEET_AUTO,
    });
    expect(await prepare(silent)).toEqual({ kind: "refused", reason: "sheets_unavailable" });
    const unaware = await station([ZEBRA, HP_A4], A4_PALLETS, { pallet: SHEET_AUTO });
    expect(await prepare(unaware)).toEqual({ kind: "refused", reason: "sheets_unavailable" });
    for (const each of [at, gone, silent, unaware]) expect(each.sends).toEqual([]);
    expect(rows(at.db, "SELECT count(*) AS n FROM wh_jobs")).toEqual([{ n: 0 }]);
  });

  it("does not take a session's sheet for a label printer: a pallet on a label printer needs a label template", async () => {
    const at = await station(
      [ZEBRA, HP_A4],
      { box: "zebra", pallet: "zebra", duplicate: null },
      {
        sheets: async () => hostSheets(),
        pallet: SHEET_AUTO,
      },
    );
    const outcome = await reprint(at, PALLET_SSCC, PALLET_SOURCE);
    expect(outcome).toMatchObject({ kind: "refused", reason: "template_unavailable" });
    expect(at.sends).toEqual([]);
  });

  it.each([
    ["a retry of a failed label", [{ sent: false, code: "not_sent" }], "retry"],
    ["a new attempt of a sent label", [], "again"],
  ] as const)(
    "refuses %s onto an A4 printer before anything is written",
    async (_name, answers, kind) => {
      const at = await station(
        [ZEBRA, HP_A4],
        { box: "zebra", pallet: "zebra", duplicate: null },
        {
          answers: [...answers],
        },
      );
      const first = await reprint(at, PALLET_SSCC, PALLET_SOURCE);
      if (first.kind !== "printed") throw new Error("printed");
      await setUpPrinting(at.local, { printers: [ZEBRA, HP_A4], assignments: A4_PALLETS });
      vi.mocked(LabelRender.renderLabel).mockClear();
      const intent = kind === "retry" ? { kind } : { kind, reason: "lost" as const };
      const refusal = await sendWarehouseJob(at.context, first.job, intent, OPERATOR_ID).catch(
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(WarehousePrinterError);
      expect((refusal as WarehousePrinterError).code).toBe("printer_a4");
      expect(at.sends).toHaveLength(1);
      expect(LabelRender.renderLabel).not.toHaveBeenCalled();
      expect(await readJob(at.local, PAIRING, first.job.id)).toMatchObject({
        state: first.job.state,
        attempts: 1,
      });
    },
  );

  it("never sends a box's or a unit's label that carries an A4 printer, whatever made it", async () => {
    const at = await station([ZEBRA, HP_A4], { box: "zebra", pallet: "zebra", duplicate: null });
    const made = await prepareWarehouseJob(at.context, {
      session: at.session,
      source: BOX_SOURCE,
      repair: null,
      operatorId: OPERATOR_ID,
    });
    if (made.kind !== "job") throw new Error("job");
    const refusal = await sendWarehouseJob(
      at.context,
      { ...made.job, printer: HP_A4 },
      { kind: "first" },
      OPERATOR_ID,
    ).catch((error: unknown) => error);
    expect((refusal as WarehousePrinterError).code).toBe("printer_a4");
    expect(at.sends).toEqual([]);
    expect(await readJob(at.local, PAIRING, made.job.id)).toMatchObject({
      state: "prepared",
      attempts: 0,
    });
  });

  it("refuses a pallet's sheet onto a label printer, and a label onto a printer of sheets, before anything is written", async () => {
    const at = await station([ZEBRA, HP_A4], A4_PALLETS, {
      sheets: async () => hostSheets(),
      pallet: SHEET_AUTO,
      answers: [{ sent: false, code: "not_sent" }],
    });
    const first = await reprint(at, PALLET_SSCC, PALLET_SOURCE);
    if (first.kind !== "printed") throw new Error("printed");
    expect(first.job.state).toBe("failed");
    // The pallet printer is a label printer now: the sheet's job cannot go there.
    await setUpPrinting(at.local, {
      printers: [ZEBRA, HP_A4],
      assignments: { box: "zebra", pallet: "zebra", duplicate: null },
    });
    const refusal = await sendWarehouseJob(
      at.context,
      first.job,
      { kind: "retry" },
      OPERATOR_ID,
    ).catch((error: unknown) => error);
    expect((refusal as WarehousePrinterError).code).toBe("printer_not_a4");
    expect(at.sends).toHaveLength(1);
    expect(await readJob(at.local, PAIRING, first.job.id)).toMatchObject({
      state: "failed",
      attempts: 1,
    });
  });

  it("gives a box no printer when the stored settings name an A4 printer for it", async () => {
    const at = await station([ZEBRA, HP_A4], { box: "zebra", pallet: null, duplicate: null });
    // Written past the setup, which never saves it: the read drops it, and the box has none.
    at.db.prepare("UPDATE workstation_settings SET value = ? WHERE key = 'printers'").run(
      JSON.stringify({
        printers: [ZEBRA, HP_A4],
        assignments: { box: "hp-a4", pallet: null, duplicate: null },
      }),
    );
    const outcome = await reprint(at, BOX_SSCC, BOX_SOURCE);
    expect(outcome).toMatchObject({
      kind: "printed",
      job: { state: "failed", errorCode: "printer_unconfigured" },
    });
    expect(at.sends).toEqual([]);
  });
});
