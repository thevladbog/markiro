import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  boxReportRowsSchema,
  palletReportRowsSchema,
  type BoxReportRows,
  type PalletReportRows,
} from "../src/host/protocol.js";
import {
  boxReportData,
  palletPlacardData,
  palletReportData,
  placardPallets,
  shiftPlacardsData,
  taskFormData,
} from "../src/office/forms/form-data.js";
import { renderForm } from "../src/office/forms/render-form.js";
import { ORG_PROFILE } from "./support/office.js";
import { ACTIVE, LINE_2, MILK, NORTH, PLANNED } from "./support/shifts.js";

/**
 * Rules of the forms' inputs that `forms-parity.test.ts` cannot see because
 * the cloud's twelve shared cases do not exercise them (or the HTML does not
 * show them): they bind the mapping itself, field by field, as the cloud's
 * loaders (`CodeSearchService`, `ShiftsService.taskFormData`) derive it.
 */

// Through a variable: Vite would take `new URL(…, import.meta.url)` for an asset.
const testModuleUrl = import.meta.url;
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}
const BOX: BoxReportRows = boxReportRowsSchema.parse(fixture("box-report-rows.json"));
const ROWS: PalletReportRows = palletReportRowsSchema.parse(fixture("pallet-report-rows.json"));
const PALLET = ((pallet) => {
  if (pallet === undefined) throw new Error("the fixture has a pallet");
  return pallet;
})(ROWS.pallets[0]);
const BOX_ON_PALLET = ((box) => {
  if (box === undefined) throw new Error("the fixture pallet has a box");
  return box;
})(PALLET.boxes[0]);

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

describe("a box's form data (plan О-Ф)", () => {
  const ORG_OF_BOX = { name: BOX.organization.name, inn: BOX.organization.inn, logo: null };

  it("maps every field of a closed box, the codes' text exactly and in the order the host sent", () => {
    expect(boxReportData(BOX)).toEqual({
      sscc: "00046006820000015000",
      status: "closed",
      productName: BOX.productName,
      org: ORG_OF_BOX,
      openedAt: new Date("2026-10-08T06:05:12.031Z"),
      closedAt: new Date("2026-10-08T06:06:01.118Z"),
      disassembledAt: null,
      codes: [
        {
          gtin14: "04600682000013",
          serial: "Kq8vT2mXc5Rz",
          rawKm: "010460068200001321Kq8vT2mXc5Rz\u001d93Ab1Z",
        },
        {
          gtin14: "04600682000013",
          serial: "Pw3nY7hLd9Fs",
          rawKm: "010460068200001321Pw3nY7hLd9Fs\u001d93Cd2Y",
        },
      ],
    });
    const reversed = { ...BOX, items: [...BOX.items].reverse() };
    expect(boxReportData(reversed).codes.map((code) => code.serial)).toEqual([
      "Pw3nY7hLd9Fs",
      "Kq8vT2mXc5Rz",
    ]);
  });

  it("keeps a code's text byte for byte: the group separator, spaces and the crypto tail", () => {
    const text = " 0104600682000013\u001d21a b&<\"'\u001d93Zz\u001d ";
    const rows = { ...BOX, items: [{ gtin14: "04600682000013", serial: "a b", canonical: text }] };
    expect(boxReportData(rows).codes[0]?.rawKm).toBe(text);
  });

  it("calls a box taken apart that, before closed, and an unclosed one open; none of them without a time", () => {
    const apart = boxReportData({ ...BOX, disassembledAt: "2026-10-08T07:10:00.250Z" });
    expect(apart.status).toBe("disassembled");
    expect(apart.disassembledAt).toEqual(new Date("2026-10-08T07:10:00.250Z"));
    expect(apart.closedAt).toEqual(new Date("2026-10-08T06:06:01.118Z"));
    const open = boxReportData({ ...BOX, sscc: null, closedAt: null, items: [] });
    expect(open).toMatchObject({
      status: "open",
      sscc: null,
      closedAt: null,
      disassembledAt: null,
    });
    expect(open.codes).toEqual([]);
  });

  it("does not touch the rows it is given", () => {
    expect(() => boxReportData(deepFreeze(structuredClone(BOX)))).not.toThrow();
  });
});

describe("a pallet's form data (plan О-Ф)", () => {
  const ORG_OF_ROWS = { name: ROWS.organization.name, inn: ROWS.organization.inn, logo: null };
  const second = {
    ...BOX_ON_PALLET,
    id: "b0000000-0000-4000-8000-000000000002",
    sscc: null,
    closedAt: "2026-10-08T06:08:00.000Z",
    units: 7,
  };
  const retired = {
    ...BOX_ON_PALLET,
    id: "b0000000-0000-4000-8000-000000000003",
    sscc: "046006820000015024",
    closedAt: "2026-10-08T06:07:00.000Z",
    disassembledAt: "2026-10-08T06:30:00.250Z",
    units: 0,
  };
  const rows: PalletReportRows = {
    ...ROWS,
    pallets: [
      {
        ...PALLET,
        // The host's order is the form's: a box that is not in closing order stays where it was sent.
        boxes: [second, BOX_ON_PALLET, retired],
      },
      {
        ...PALLET,
        id: "a0000000-0000-4000-8000-000000000002",
        sscc: null,
        closedAt: null,
        boxes: [],
      },
      {
        ...PALLET,
        id: "a0000000-0000-4000-8000-000000000003",
        sscc: "146006820000000416",
        disassembledAt: "2026-10-08T09:00:00.500Z",
      },
    ],
  };

  it("maps every field of a closed pallet, its boxes in the host's order, units and times as sent", () => {
    expect(palletReportData(rows, PALLET.id)).toEqual({
      sscc: "00146006820000000409",
      status: "closed",
      productName: ROWS.shift.productName,
      org: ORG_OF_ROWS,
      openedAt: new Date("2026-10-08T06:06:01.118Z"),
      closedAt: new Date("2026-10-08T06:20:44.650Z"),
      disassembledAt: null,
      boxes: [
        { sscc: null, codeCount: 7, disassembledAt: null },
        { sscc: "00046006820000015000", codeCount: 2, disassembledAt: null },
        {
          sscc: "00046006820000015024",
          codeCount: 0,
          disassembledAt: new Date("2026-10-08T06:30:00.250Z"),
        },
      ],
    });
  });

  it("calls an unclosed pallet open and a pallet taken apart that, with the boxes it still lists", () => {
    expect(palletReportData(rows, "a0000000-0000-4000-8000-000000000002")).toMatchObject({
      status: "open",
      sscc: null,
      closedAt: null,
      boxes: [],
    });
    const apart = palletReportData(rows, "a0000000-0000-4000-8000-000000000003");
    expect(apart).toMatchObject({
      status: "disassembled",
      disassembledAt: new Date("2026-10-08T09:00:00.500Z"),
      closedAt: new Date("2026-10-08T06:20:44.650Z"),
    });
    expect(apart?.boxes).toHaveLength(1);
  });

  it("maps every field of a placard, a box taken apart with its time and the shift's date on each box", () => {
    expect(palletPlacardData(rows, PALLET.id)).toEqual({
      sscc: "00146006820000000409",
      status: "closed",
      productName: ROWS.shift.productName,
      gtin14: "04600682000013",
      shelfLifeDays: 10,
      org: ORG_OF_ROWS,
      boxes: [
        { productionDate: "2026-10-08", codeCount: 7, disassembledAt: null },
        { productionDate: "2026-10-08", codeCount: 2, disassembledAt: null },
        {
          productionDate: "2026-10-08",
          codeCount: 0,
          disassembledAt: new Date("2026-10-08T06:30:00.250Z"),
        },
      ],
    });
    expect(palletPlacardData(rows, "a0000000-0000-4000-8000-000000000003")?.status).toBe(
      "disassembled",
    );
    // A night shift's pallet closes the day after the shift's date; the boxes keep the shift's date.
    const nightly = {
      ...rows,
      pallets: rows.pallets.map((each) => ({ ...each, closedAt: "2026-10-09T01:30:00.000Z" })),
    };
    expect(palletPlacardData(nightly, PALLET.id)?.boxes.map((box) => box.productionDate)).toEqual([
      "2026-10-08",
      "2026-10-08",
      "2026-10-08",
    ]);
    const noShelfLife = { ...rows, shift: { ...rows.shift, shelfLifeDays: null } };
    expect(palletPlacardData(noShelfLife, PALLET.id)?.shelfLifeDays).toBeNull();
  });

  it("does not touch the rows it is given", () => {
    const frozen = deepFreeze(structuredClone(rows));
    expect(() => palletReportData(frozen, PALLET.id)).not.toThrow();
    expect(() => palletPlacardData(frozen, PALLET.id)).not.toThrow();
    expect(() => shiftPlacardsData(frozen)).not.toThrow();
    expect(() => renderForm({ kind: "placards", rows: frozen, format: "a4" })).not.toThrow();
  });
});

describe("the shift's placards (plan О-Ф)", () => {
  function pallet(
    n: number,
    closedAt: string,
    fields: Partial<PalletReportRows["pallets"][number]> = {},
  ): PalletReportRows["pallets"][number] {
    return {
      ...PALLET,
      id: `a0000000-0000-4000-8000-00000000000${n}`,
      sscc: `14600682000000041${n}`,
      closedAt,
      ...fields,
    };
  }
  const idsOf = (rows: PalletReportRows): string[] =>
    placardPallets(rows).map((each) => each.id.slice(-1));

  it("orders by the full instant, to the millisecond, before the id", () => {
    // Same second: id 9 closed at .100 and id 1 at .900, so 9 comes first though its id is greater.
    const rows: PalletReportRows = {
      ...ROWS,
      pallets: [
        pallet(1, "2026-10-08T07:00:00.900Z"),
        pallet(9, "2026-10-08T07:00:00.100Z"),
        pallet(5, "2026-10-08T06:59:59.999Z"),
      ],
    };
    expect(idsOf(rows)).toEqual(["5", "9", "1"]);
  });

  it("breaks a tie of instants by the id, whichever way the host sent them", () => {
    const at = "2026-10-08T07:00:00.000Z";
    const forward: PalletReportRows = {
      ...ROWS,
      pallets: [pallet(1, at), pallet(2, at), pallet(3, at)],
    };
    expect(idsOf(forward)).toEqual(["1", "2", "3"]);
    expect(idsOf({ ...forward, pallets: [...forward.pallets].reverse() })).toEqual(["1", "2", "3"]);
  });

  it("leaves out a pallet taken apart, one open and one without an SSCC, even when they are first", () => {
    const rows: PalletReportRows = {
      ...ROWS,
      pallets: [
        pallet(1, "2026-10-08T05:00:00.000Z", { disassembledAt: "2026-10-08T05:30:00.000Z" }),
        pallet(2, "2026-10-08T05:00:00.000Z", { closedAt: null }),
        pallet(3, "2026-10-08T05:00:00.000Z", { sscc: null }),
        pallet(4, "2026-10-08T08:00:00.000Z"),
        pallet(7, "2026-10-08T09:00:00.000Z", { boxes: [] }),
      ],
    };
    // A pallet closed with no box on it still has its placard, as in the cloud.
    expect(idsOf(rows)).toEqual(["4", "7"]);
  });

  it("draws each pallet exactly as its own placard and names the shift by its number", () => {
    const rows: PalletReportRows = {
      ...ROWS,
      pallets: [pallet(2, "2026-10-08T08:00:00.000Z"), pallet(1, "2026-10-08T07:00:00.000Z")],
    };
    const data = shiftPlacardsData(rows);
    expect(data?.shiftNumber).toBe(ROWS.shift.number);
    expect(data?.pallets).toEqual([
      palletPlacardData(rows, "a0000000-0000-4000-8000-000000000001"),
      palletPlacardData(rows, "a0000000-0000-4000-8000-000000000002"),
    ]);
    expect(shiftPlacardsData({ ...ROWS, pallets: [] })).toBeNull();
  });
});

describe("the blank's data (plan О-Ф)", () => {
  const at = new Date("2026-10-09T09:00:00Z");
  const inputs = {
    shift: PLANNED,
    product: MILK,
    line: LINE_2,
    counterparty: NORTH,
    organization: ORG_PROFILE,
    photo: null,
  };

  it("maps every field of a planned shift, with what the standalone has not as the cloud's neutral value", () => {
    expect(taskFormData(inputs, at)).toEqual({
      shiftId: PLANNED.id,
      shiftNumber: PLANNED.number,
      status: "planned",
      mode: "aggregation",
      organizationName: ORG_PROFILE.name,
      productId: MILK.id,
      productName: MILK.name,
      productPrintName: MILK.printName,
      gtin14: MILK.gtin14,
      imageChecksum: null,
      lineName: LINE_2.name,
      plannedDate: PLANNED.plannedDate,
      productionDate: PLANNED.productionDate,
      plannedQty: null,
      boxCapacity: PLANNED.boxCapacity,
      palletsEnabled: false,
      palletBoxCapacity: null,
      counterpartyName: NORTH.name,
      ssccIssuerName: null,
      validationPrintMode: "none",
      validationPrintVerification: "none",
      allowPreviouslyAcceptedCodes: false,
      closingRule: "each_part",
      generatedAt: at,
    });
  });

  it("carries the plan, the pallet rule, the mode and a missing print name as they are", () => {
    const shift = {
      ...ACTIVE,
      mode: "validation" as const,
      plannedQty: 1200,
      palletsEnabled: true,
      palletBoxCapacity: 40,
    };
    expect(
      taskFormData({ ...inputs, shift, product: { ...MILK, printName: null } }, at),
    ).toMatchObject({
      status: "active",
      mode: "validation",
      plannedQty: 1200,
      boxCapacity: ACTIVE.boxCapacity,
      palletsEnabled: true,
      palletBoxCapacity: 40,
      productPrintName: null,
      productId: MILK.id,
      shiftId: ACTIVE.id,
      shiftNumber: ACTIVE.number,
      validationPrintMode: "none",
      validationPrintVerification: "none",
      allowPreviouslyAcceptedCodes: false,
    });
  });

  it("heads a validation shift's blank «Проверка», as the cloud's, and an aggregation's «Агрегация» (plan РЕЖ)", () => {
    const html = (mode: "aggregation" | "validation") =>
      renderForm({
        kind: "task",
        inputs: { ...inputs, shift: { ...PLANNED, mode } },
        generatedAt: at,
      })?.html ?? "";
    expect(html("validation")).toContain(`<p class="subtitle">Проверка · `);
    expect(html("aggregation")).toContain(`<p class="subtitle">Агрегация · `);
  });

  it("passes a validation shift's duplicate print as it is, and prints its row as the cloud's blank (plan РЕЖ, B7)", () => {
    const printing = (verification: "none" | "required") => ({
      ...PLANNED,
      mode: "validation" as const,
      validationPrint: {
        mode: "duplicate_dm" as const,
        templateId: "b7c8d9e0-f1a2-4b3c-8d4e-5f6a7b8c9d0e",
        verification,
      },
    });
    expect(taskFormData({ ...inputs, shift: printing("required") }, at)).toMatchObject({
      validationPrintMode: "duplicate_dm",
      validationPrintVerification: "required",
    });
    expect(taskFormData({ ...inputs, shift: printing("none") }, at)).toMatchObject({
      validationPrintMode: "duplicate_dm",
      validationPrintVerification: "none",
    });
    // No policy (a host before protocol 5) and `none` print nothing.
    for (const shift of [
      { ...PLANNED, mode: "validation" as const },
      { ...PLANNED, mode: "validation" as const, validationPrint: { mode: "none" as const } },
    ]) {
      expect(taskFormData({ ...inputs, shift }, at)).toMatchObject({
        validationPrintMode: "none",
        validationPrintVerification: "none",
      });
    }
    const html = (shift: typeof PLANNED) =>
      renderForm({ kind: "task", inputs: { ...inputs, shift }, generatedAt: at })?.html ?? "";
    const row = (text: string) =>
      `<div class="parameter"><dt>ПЕЧАТЬ ЭТИКЕТКИ</dt><dd>${text}</dd></div>`;
    expect(html(printing("required"))).toContain(
      row("Дубликат Data Matrix · обязательная проверка"),
    );
    expect(html(printing("none"))).toContain(row("Дубликат Data Matrix"));
    expect(html(printing("none"))).toContain(
      "На внешнюю упаковку переносится полный код с продукции",
    );
    expect(html({ ...PLANNED, mode: "validation" })).toContain(row("Без печати"));
  });

  it("passes the pallet switch and the capacity as two facts: a capacity left behind a switch turned off stays", () => {
    const off = taskFormData(
      { ...inputs, shift: { ...ACTIVE, palletsEnabled: false, palletBoxCapacity: 40 } },
      at,
    );
    expect(off).toMatchObject({ palletsEnabled: false, palletBoxCapacity: 40 });
    const on = taskFormData(
      { ...inputs, shift: { ...ACTIVE, palletsEnabled: true, palletBoxCapacity: null } },
      at,
    );
    expect(on).toMatchObject({ palletsEnabled: true, palletBoxCapacity: null });
  });
});

describe("the forms' files (plan О-Ф)", () => {
  it("names the box's and the blank's file, a box without an SSCC by that", () => {
    expect(renderForm({ kind: "box", rows: BOX, timeZone: "UTC" })?.fileName).toBe(
      "Состав короба 046006820000015000.html",
    );
    expect(
      renderForm({ kind: "box", rows: { ...BOX, sscc: null }, timeZone: "UTC" })?.fileName,
    ).toBe("Состав короба без SSCC.html");
    expect(
      renderForm({
        kind: "task",
        inputs: {
          shift: PLANNED,
          product: MILK,
          line: LINE_2,
          counterparty: null,
          organization: ORG_PROFILE,
          photo: null,
        },
        generatedAt: new Date("2026-10-09T09:00:00Z"),
      })?.fileName,
    ).toBe("Бланк смены.html");
  });

  it("names a placard by its pallet's SSCC and paper, and the pallet's own form by it too", () => {
    expect(
      renderForm({ kind: "placard", rows: ROWS, palletId: PALLET.id, format: "a4" })?.fileName,
    ).toBe("Ярлык паллеты 146006820000000409 A4.html");
    expect(
      renderForm({ kind: "pallet", rows: ROWS, palletId: PALLET.id, timeZone: "UTC" })?.fileName,
    ).toBe("Состав паллеты 146006820000000409.html");
  });

  it("writes the box's and the pallet's times in the zone it is given", () => {
    const utc = renderForm({ kind: "box", rows: BOX, timeZone: "UTC" })?.html ?? "";
    const vladivostok =
      renderForm({ kind: "box", rows: BOX, timeZone: "Asia/Vladivostok" })?.html ?? "";
    expect(utc).not.toBe(vladivostok);
    expect(utc).toContain("08.10.2026 06:05");
    expect(vladivostok).toContain("08.10.2026 16:05");
    const palletUtc =
      renderForm({ kind: "pallet", rows: ROWS, palletId: PALLET.id, timeZone: "UTC" })?.html ?? "";
    const palletVladivostok =
      renderForm({
        kind: "pallet",
        rows: ROWS,
        palletId: PALLET.id,
        timeZone: "Asia/Vladivostok",
      })?.html ?? "";
    expect(palletUtc).toContain("06:06");
    expect(palletVladivostok).toContain("16:06");
  });

  it("refuses with nothing, not with an exception, what the cloud refuses", () => {
    expect(
      renderForm({ kind: "placard", rows: ROWS, palletId: "missing", format: "a5" }),
    ).toBeNull();
    expect(
      renderForm({ kind: "placards", rows: { ...ROWS, pallets: [] }, format: "a5" }),
    ).toBeNull();
  });
});
