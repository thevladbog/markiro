import { readFileSync } from "node:fs";

import {
  boxLabelFields,
  canonicalizeKm,
  DomainError,
  encodeMonoRaster,
  generateTspl,
  generateZpl,
  parseDuplicateKm,
  renderMonoLabel,
  withPrinterDpi,
  type LabelTemplateSpec,
  type MonoBitmap,
} from "@markiro/domain";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { latin1ToBytes, renderLabel } from "../src/floor/print/label-render.js";
import type { PrinterProfile } from "../src/floor/setup/workstation-settings.js";
import { readStoredWork } from "../src/floor/shifts/shift-copies.js";
import { checkShiftSnapshot } from "../src/floor/shifts/shift-snapshot.js";
import { unitLabelFields, unitLabelRender } from "../src/floor/unit-labels/unit-label-render.js";
import { enteredShiftSchema, type EnteredShift } from "../src/host/protocol.js";
import { enteredShift, GTIN, km, OTHER_GTIN, PAIRING } from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";
import { fakeRaster } from "./support/printing.js";

/*
 * The label of a unit of a validation shift that prints the Data Matrix duplicate (plan РЕЖ, B5):
 * its fields are the cloud station's `duplicateLabelFields` (`apps/station/src/lib/product-labels/
 * fields.ts`, read only as the model): the box label's fields of one unit (`qty = 1`, no SSCC) with
 * the full code, from the shift's snapshot and the moment the unit was accepted. Its bytes are the
 * domain's emitters' for the snapshot's duplicate layout at the printer's resolution, the code
 * drawn as the shared GS1 raster.
 */

// See test/protocol.test.ts: bind import.meta.url before building a URL from it.
const testModuleUrl = import.meta.url;
const PRINTING: EnteredShift = enteredShiftSchema.parse(
  JSON.parse(
    readFileSync(
      new URL("../proto/fixtures/device-shift-entered-validation-print.json", testModuleUrl),
      "utf8",
    ),
  ),
);
const ACCEPTED_AT = "2026-10-08T06:15:00.000Z";
const RAW = km("5Yq'Ct;");
const CANONICAL = canonicalizeKm(RAW).raw;

async function printingShift() {
  const { executor } = openLocalDb();
  return enteredShift(executor, PRINTING);
}

const RAW_PRINTERS: PrinterProfile[] = [
  {
    id: "z203",
    name: "Z",
    target: { kind: "tcp", host: "10.0.0.1", port: 9100 },
    language: "zpl",
    dpi: 203,
  },
  {
    id: "z300",
    name: "Z",
    target: { kind: "tcp", host: "10.0.0.1", port: 9100 },
    language: "zpl",
    dpi: 300,
  },
  {
    id: "t203",
    name: "T",
    target: { kind: "serial", port: "COM4", baud: 9600 },
    language: "tspl",
    dpi: 203,
  },
  {
    id: "t300",
    name: "T",
    target: { kind: "serial", port: "COM4", baud: 9600 },
    language: "tspl",
    dpi: 300,
  },
];

/** The shift's duplicate layout with an `organization_logo` box beside its code. */
function withLogoBox(spec: LabelTemplateSpec): LabelTemplateSpec {
  return {
    ...spec,
    elements: [
      ...spec.elements,
      {
        id: "logo",
        kind: "organization_logo",
        xMm: 19,
        yMm: 10,
        widthMm: 8,
        heightMm: 6,
        source: "organization",
        fallback: "markiro",
      },
    ],
  };
}

describe("the fields of a unit label", () => {
  it("are one unit's label with its full code, from the snapshot, the shift and the moment", async () => {
    const shift = await printingShift();
    expect(unitLabelFields(shift, RAW, ACCEPTED_AT, "Анна Кузнецова")).toEqual({
      "product.name": "Молоко 3,2% 0,9 л",
      "product.printName": "Молоко 3,2%",
      "product.gtin": GTIN,
      "product.egais": "",
      // The canonical code with its group separator and crypto tail, no AIM prefix.
      "km.code": CANONICAL,
      sscc: "",
      "shift.no": "OCT26-006",
      // The shift's production date, the last usable day inclusive (10 days).
      date: "08.10.2026",
      expiry: "17.10.2026",
      qty: "1",
      "qty.boxes": "",
      operator: "Анна Кузнецова",
      "counterparty.name": "ООО «Северный берег»",
    });
    expect(CANONICAL).toContain("\u001d93");
    // The EGAIS code the snapshot froze (plan ТОВ), as on the shift's box labels.
    expect(unitLabelFields(withEgais(shift), RAW, ACCEPTED_AT, null)["product.egais"]).toBe(EGAIS);
  });

  it("refuse a code without its crypto tail and a code of another product", async () => {
    const shift = await printingShift();
    expect(() => unitLabelFields(shift, `01${GTIN}21ABC`, ACCEPTED_AT, null)).toThrow(DomainError);
    expect(() => unitLabelFields(shift, km("X1", { gtin: OTHER_GTIN }), ACCEPTED_AT, null)).toThrow(
      DomainError,
    );
  });
});

describe("the bytes of a unit label", () => {
  it("are the domain's ZPL and TSPL at 203 and 300 dpi, the code as the GS1 raster", async () => {
    const shift = await printingShift();
    const template = shift.snapshot.validationPrint?.template;
    if (template === undefined) throw new Error("the shift froze no duplicate template");
    const fields = unitLabelFields(shift, RAW, ACCEPTED_AT, null);
    const render = unitLabelRender(shift, { rasterize: fakeRaster });
    const seen = new Set<string>();
    for (const printer of RAW_PRINTERS) {
      const deps = { rasterizeText: fakeRaster, logo: null, kmDataMatrix: "raster" as const };
      const spec = withPrinterDpi(template.spec, printer.dpi);
      const expected =
        printer.language === "zpl"
          ? await generateZpl(spec, fields, deps)
          : await generateTspl(spec, fields, deps);
      const bytes = await render(template.spec, fields, printer);
      expect(bytes, printer.id).toEqual(latin1ToBytes(expected));
      seen.add(new TextDecoder("latin1").decode(bytes));
    }
    // Four different labels: the language and the resolution each change the bytes.
    expect(seen.size).toBe(4);
    // The raster, not the printer's native Data Matrix command.
    const zpl = new TextDecoder("latin1").decode(
      await render(template.spec, fields, RAW_PRINTERS[0]!),
    );
    expect(zpl).not.toContain("^BX");
  });

  it("are the domain's driver page for a printer through the Windows driver", async () => {
    const shift = await printingShift();
    const template = shift.snapshot.validationPrint?.template;
    if (template === undefined) throw new Error("the shift froze no duplicate template");
    const fields = unitLabelFields(shift, RAW, ACCEPTED_AT, null);
    const driver: PrinterProfile = {
      id: "godex",
      name: "Godex",
      target: { kind: "usb", printer: "Godex G500" },
      language: "zpl",
      dpi: 300,
      mode: "windows_driver",
    };
    const bytes = await unitLabelRender(shift, { rasterize: fakeRaster })(
      template.spec,
      fields,
      driver,
    );
    const page = await renderMonoLabel(withPrinterDpi(template.spec, 300), fields, fakeRaster, {
      logo: null,
    });
    expect(bytes).toEqual(encodeMonoRaster(page));
  });
});

describe("the logo of a unit label", () => {
  const LOGO: MonoBitmap = {
    width: 16,
    height: 8,
    stride: 2,
    pixels: new Uint8Array(16).fill(0xff),
  };
  const MARKIRO: MonoBitmap = {
    width: 8,
    height: 2,
    stride: 1,
    pixels: new Uint8Array([0xf0, 0x0f]),
  };
  const ZPL_203: PrinterProfile = RAW_PRINTERS[0] ?? raise("no printer");

  // The duplicate prints a logo by the shift labels' own rule (#703), as the warehouse reprint of
  // a unit does (plan СКЛ × А4, `warehouseLabelRender`): the organization logo the shift froze,
  // else the bundled Markiro logo — never another logo than the station's other labels print.
  it("prints the organization logo the shift froze, in a layout with a logo box", async () => {
    const shift = await printingShift();
    const template = shift.snapshot.validationPrint?.template ?? raise("no duplicate template");
    const frozen = {
      ...shift,
      snapshot: {
        ...shift.snapshot,
        organization: { name: "ООО «Пример»", inn: null, logo: LOGO },
      },
    };
    const spec = withLogoBox(template.spec);
    const fields = unitLabelFields(frozen, RAW, ACCEPTED_AT, null);
    const fallbackLogo = vi.fn(async () => MARKIRO);
    const bytes = await unitLabelRender(frozen, { rasterize: fakeRaster, fallbackLogo })(
      spec,
      fields,
      ZPL_203,
    );
    expect(bytes).toEqual(
      await renderLabel(spec, fields, ZPL_203, fakeRaster, LOGO, { kmDataMatrix: "raster" }),
    );
    expect(bytes).not.toEqual(
      await renderLabel(spec, fields, ZPL_203, fakeRaster, null, { kmDataMatrix: "raster" }),
    );
    expect(fallbackLogo).not.toHaveBeenCalled();
  });

  it("prints the Markiro logo when the shift froze none, and loads none without a logo box", async () => {
    const shift = await printingShift();
    expect(shift.snapshot.organization).toBeNull();
    const template = shift.snapshot.validationPrint?.template ?? raise("no duplicate template");
    const spec = withLogoBox(template.spec);
    const fields = unitLabelFields(shift, RAW, ACCEPTED_AT, null);
    const fallbackLogo = vi.fn(async () => MARKIRO);
    const render = unitLabelRender(shift, { rasterize: fakeRaster, fallbackLogo });
    expect(await render(spec, fields, ZPL_203)).toEqual(
      await renderLabel(spec, fields, ZPL_203, fakeRaster, MARKIRO, { kmDataMatrix: "raster" }),
    );
    expect(fallbackLogo).toHaveBeenCalledTimes(1);
    fallbackLogo.mockClear();
    await render(template.spec, fields, ZPL_203);
    expect(fallbackLogo).not.toHaveBeenCalled();
  });
});

/*
 * Parity with the cloud station (plan РЕЖ, B8). The cloud's duplicate
 * (`apps/station/src/lib/product-labels/fields.ts`: `duplicateLabelFields`, then
 * `renderLabelBytes` of `print-label.ts`) is not imported; it is restated below through the
 * shared domain, call for call: the box label's fields of one unit from the cloud's label
 * context, the canonical code in `km.code`, and the domain's emitters at the printer's
 * resolution with the code as the GS1 raster and no logo. The station's labels are compared
 * with it end to end (`unitLabelFields` + `unitLabelRender`), not emitter to emitter.
 *
 * One difference is deliberate (review of B5): in a layout with an `organization_logo` box
 * the station prints the logo the shift froze, else the Markiro logo, as its warehouse reprint
 * of a unit does; the cloud's duplicate passes the emitters no logo, so the box stays blank.
 * Without a logo box the bytes are the cloud's byte for byte. The EGAIS code is the one the
 * shift's snapshot froze (plan ТОВ), as the cloud takes it from its frozen grant and as the
 * station's box labels take it; a snapshot without one prints the field empty in both.
 * The state machine of a job is compared with the domain's in `unit-label-work.test.ts`
 * (`canApplyProductLabelEvent`/`applyProductLabelEvent`) and `unit-label-schema.test.ts`.
 */
interface CloudLabelContext {
  productName: string;
  productPrintName: string | null;
  gtin14: string;
  egaisCode: string | null;
  shelfLifeDays: number | null;
  operatorName: string | null;
  counterpartyName: string | null;
  productionDate: string | null;
  shiftNumber: string | null;
}

/** The cloud's `duplicateLabelFields`, restated through the domain. */
function cloudDuplicateFields(
  context: CloudLabelContext,
  canonicalRaw: string,
  acceptedAt: string,
): Record<string, string> {
  const code = parseDuplicateKm(canonicalRaw);
  if (code.gtin14 !== context.gtin14) throw new Error("another product's code");
  const base = boxLabelFields({ ...context, sscc: "", itemCount: 1, closedAt: acceptedAt });
  return { ...base, "km.code": code.raw, qty: "1", sscc: "" };
}

/** The cloud's `renderLabelBytes(spec, fields, language, rasterize, { kmDataMatrix: "raster", dpi })`. */
async function cloudDuplicateBytes(
  spec: LabelTemplateSpec,
  fields: Record<string, string>,
  printer: PrinterProfile,
): Promise<Uint8Array> {
  const printSpec = withPrinterDpi(spec, printer.dpi);
  const options = { rasterizeText: fakeRaster, kmDataMatrix: "raster" as const };
  return latin1ToBytes(
    printer.language === "tspl"
      ? await generateTspl(printSpec, fields, options)
      : await generateZpl(printSpec, fields, options),
  );
}

/** The cloud's label context of `shift`: what the cloud station passes from the same shift. */
function cloudContext(shift: EnteredWork, operatorName: string | null): CloudLabelContext {
  const { product, counterpartyName } = shift.snapshot;
  return {
    productName: product.name,
    productPrintName: product.printName,
    gtin14: product.gtin14,
    egaisCode: product.egaisCode ?? null,
    shelfLifeDays: product.shelfLifeDays,
    operatorName,
    counterpartyName,
    productionDate: shift.copy.productionDate,
    shiftNumber: shift.copy.number,
  };
}

type EnteredWork = Awaited<ReturnType<typeof printingShift>>;

/** An EGAIS code of 19 digits, as a product of ЧЗ group 15 has (plan ТОВ). */
const EGAIS = "0150320000003486925";

/** `shift` with its snapshot's product carrying an EGAIS code, as a host since plan ТОВ freezes it. */
function withEgais(shift: EnteredWork): EnteredWork {
  return {
    ...shift,
    snapshot: { ...shift.snapshot, product: { ...shift.snapshot.product, egaisCode: EGAIS } },
  };
}

describe("a unit label against the cloud station's duplicate", () => {
  const LOGO: MonoBitmap = {
    width: 16,
    height: 8,
    stride: 2,
    pixels: new Uint8Array(16).fill(0xff),
  };

  /** The fixture's shift, and the same shift with every optional value of the label left out. */
  async function shifts(): Promise<[string, EnteredWork][]> {
    const shift = await printingShift();
    const bare: EnteredWork = {
      ...shift,
      snapshot: {
        ...shift.snapshot,
        product: { ...shift.snapshot.product, printName: null, shelfLifeDays: null },
        counterpartyName: null,
      },
    };
    return [
      ["the fixture's shift", shift],
      ["a shift without a print name, a shelf life or a counterparty", bare],
      ["a shift whose product froze an EGAIS code", withEgais(shift)],
    ];
  }

  it("has the cloud's fields, for every optional value given or left out", async () => {
    for (const [label, shift] of await shifts()) {
      for (const operator of ["Анна Кузнецова", null]) {
        for (const at of [ACCEPTED_AT, "2026-10-08T23:59:59.000Z"]) {
          expect(unitLabelFields(shift, RAW, at, operator), `${label}, ${operator}, ${at}`).toEqual(
            cloudDuplicateFields(cloudContext(shift, operator), CANONICAL, at),
          );
        }
      }
    }
  });

  it("is the cloud's ZPL and TSPL at 203 and 300 dpi byte for byte, for a layout without a logo box", async () => {
    const shift = await printingShift();
    const template = shift.snapshot.validationPrint?.template;
    if (template === undefined) throw new Error("the shift froze no duplicate template");
    expect(template.spec.elements.some((each) => each.kind === "organization_logo")).toBe(false);
    // The organization logo the shift froze changes nothing without a box to print it in.
    const frozen: EnteredWork = {
      ...shift,
      snapshot: {
        ...shift.snapshot,
        organization: { name: "ООО «Пример»", inn: null, logo: LOGO },
      },
    };
    for (const work of [shift, frozen, withEgais(shift)]) {
      const fallbackLogo = vi.fn(async () => LOGO);
      const render = unitLabelRender(work, { rasterize: fakeRaster, fallbackLogo });
      const fields = unitLabelFields(work, RAW, ACCEPTED_AT, "Анна Кузнецова");
      const cloudFields = cloudDuplicateFields(
        cloudContext(work, "Анна Кузнецова"),
        CANONICAL,
        ACCEPTED_AT,
      );
      for (const printer of RAW_PRINTERS) {
        expect(await render(template.spec, fields, printer), printer.id).toEqual(
          await cloudDuplicateBytes(template.spec, cloudFields, printer),
        );
      }
      expect(fallbackLogo).not.toHaveBeenCalled();
    }
  });

  it("differs from the cloud's in a layout with a logo box only by the logo it prints there", async () => {
    const shift = await printingShift();
    const template = shift.snapshot.validationPrint?.template;
    if (template === undefined) throw new Error("the shift froze no duplicate template");
    const frozen: EnteredWork = {
      ...shift,
      snapshot: {
        ...shift.snapshot,
        organization: { name: "ООО «Пример»", inn: null, logo: LOGO },
      },
    };
    const spec = withLogoBox(template.spec);
    const fields = unitLabelFields(frozen, RAW, ACCEPTED_AT, null);
    const cloudFields = cloudDuplicateFields(cloudContext(frozen, null), CANONICAL, ACCEPTED_AT);
    const render = unitLabelRender(frozen, { rasterize: fakeRaster });
    for (const printer of RAW_PRINTERS) {
      const ours = await render(spec, fields, printer);
      const cloud = await cloudDuplicateBytes(spec, cloudFields, printer);
      expect(ours, printer.id).not.toEqual(cloud);
      // The cloud leaves the box blank: its bytes are the layout's without the box.
      expect(cloud, printer.id).toEqual(
        await cloudDuplicateBytes(template.spec, cloudFields, printer),
      );
      // The station's are the cloud's emitters' with the frozen logo in the box, nothing else.
      const deps = { rasterizeText: fakeRaster, kmDataMatrix: "raster" as const, logo: LOGO };
      const printSpec = withPrinterDpi(spec, printer.dpi);
      expect(ours, printer.id).toEqual(
        latin1ToBytes(
          printer.language === "tspl"
            ? await generateTspl(printSpec, cloudFields, deps)
            : await generateZpl(printSpec, cloudFields, deps),
        ),
      );
    }
    // In ZPL the difference is one graphic field at the box's origin.
    const zplOf = async (bytes: Promise<Uint8Array>) =>
      new TextDecoder("latin1").decode(await bytes).split("\n");
    const ours = await zplOf(render(spec, fields, RAW_PRINTERS[0] ?? raise("no printer")));
    const cloud = await zplOf(
      cloudDuplicateBytes(spec, cloudFields, RAW_PRINTERS[0] ?? raise("no printer")),
    );
    const extra = ours.filter((line) => !cloud.includes(line));
    expect(extra).toHaveLength(1);
    expect(extra[0]).toMatch(/^\^FO\d+,\d+\^GFA,/);
    expect(ours.filter((line) => !extra.includes(line))).toEqual(cloud);
  });
});

function raise(message: string): never {
  throw new Error(message);
}

describe("a snapshot that prints the duplicate", () => {
  it("is read with its duplicate layout and check", async () => {
    const checked = checkShiftSnapshot(PRINTING.snapshot);
    if (!checked.ok) throw new Error(checked.reason);
    expect(checked.snapshot.validationPrint).toMatchObject({
      verification: "none",
      template: { id: "b7c8d9e0-f1a2-4b3c-8d4e-5f6a7b8c9d0e", rev: 64 },
    });
    expect(checked.snapshot.validationPrint?.template.spec.widthMm).toBe(30);
  });

  it("without a duplicate is read with none", () => {
    const { validationPrint: _dropped, ...rest } = PRINTING.snapshot;
    void _dropped;
    const checked = checkShiftSnapshot(rest);
    expect(checked.ok && checked.snapshot.validationPrint).toBeNull();
  });

  it("is refused as a layout when the duplicate layout is no duplicate the domain prints", () => {
    const template = PRINTING.snapshot.validationPrint?.template;
    if (template === undefined) throw new Error("no template");
    const spec = z.looseObject({ elements: z.array(z.unknown()) }).parse(template.spec);
    const broken = (elements: unknown[]) => ({
      ...PRINTING.snapshot,
      validationPrint: {
        ...PRINTING.snapshot.validationPrint,
        template: { ...template, spec: { ...spec, elements } },
      },
    });
    // Not a layout at all.
    expect(
      checkShiftSnapshot({
        ...PRINTING.snapshot,
        validationPrint: {
          ...PRINTING.snapshot.validationPrint,
          template: { ...template, spec: {} },
        },
      }),
    ).toEqual({ ok: false, reason: "layout" });
    // A layout, but without the code's Data Matrix (`assertDuplicateTemplate`).
    expect(checkShiftSnapshot(broken(spec.elements.slice(1)))).toEqual({
      ok: false,
      reason: "layout",
    });
    // A layout with an SSCC on a unit's label.
    expect(
      checkShiftSnapshot(
        broken([
          ...spec.elements,
          { kind: "field", id: "sscc", xMm: 19, yMm: 10, field: "sscc", fontSizePt: 6 },
        ]),
      ),
    ).toEqual({ ok: false, reason: "layout" });
  });

  it("a stored shift whose duplicate layout the domain refuses is unreadable", async () => {
    const { db, executor } = openLocalDb();
    await enteredShift(executor, PRINTING);
    const template = PRINTING.snapshot.validationPrint?.template;
    if (template === undefined) throw new Error("no template");
    db.prepare("UPDATE floor_shifts SET snapshot = ? WHERE id = ?").run(
      JSON.stringify({
        ...PRINTING.snapshot,
        validationPrint: { verification: "none", template: { ...template, spec: { widthMm: 1 } } },
      }),
      PRINTING.id,
    );
    await expect(readStoredWork(executor, PAIRING, PRINTING.id)).resolves.toEqual({
      kind: "unreadable",
      reason: "layout",
    });
  });
});
