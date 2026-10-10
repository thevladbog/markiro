import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { palletReportRowsSchema, type PalletReportRows } from "../src/host/protocol.js";
import {
  hasPlacard,
  machineSscc,
  palletPlacardData,
  palletReportData,
  placardPallets,
  shiftPlacardsData,
  taskFormData,
} from "../src/office/forms/form-data.js";
import { formTimeZone, renderForm } from "../src/office/forms/render-form.js";
import { ORG_PROFILE } from "./support/office.js";
import { ACTIVE, CLOSED, LINE_2, MILK, NORTH, PLANNED } from "./support/shifts.js";

// Through a variable: Vite would take `new URL(…, import.meta.url)` for an asset.
const testModuleUrl = import.meta.url;
const ROWS = palletReportRowsSchema.parse(
  JSON.parse(
    readFileSync(new URL("../proto/fixtures/pallet-report-rows.json", testModuleUrl), "utf8"),
  ),
);
/** The fixture's one pallet, closed. */
const CLOSED_PALLET = ((pallet) => {
  if (pallet === undefined) throw new Error("the fixture has a pallet");
  return pallet;
})(ROWS.pallets[0]);

function pallet(
  n: number,
  fields: Partial<PalletReportRows["pallets"][number]>,
): PalletReportRows["pallets"][number] {
  return {
    ...CLOSED_PALLET,
    id: `a0000000-0000-4000-8000-00000000000${n}`,
    sscc: `14600682000000041${n}`,
    ...fields,
  };
}

/** Rows with pallets 1–6: closed at 07:00 (twice, 3 before 1 by id), open, without SSCC, taken apart. */
const MANY: PalletReportRows = {
  ...ROWS,
  pallets: [
    pallet(3, { closedAt: "2026-10-08T07:00:00.000Z" }),
    pallet(2, { closedAt: null, sscc: null }),
    pallet(1, { closedAt: "2026-10-08T07:00:00.000Z" }),
    pallet(4, { closedAt: "2026-10-08T06:00:00.000Z", disassembledAt: "2026-10-08T06:30:00.000Z" }),
    pallet(5, { closedAt: "2026-10-08T06:59:59.999Z" }),
    pallet(6, { closedAt: "2026-10-08T05:00:00.000Z", sscc: null }),
  ],
};

describe("the forms' inputs from the host's rows (plan О-Ф)", () => {
  it("writes an SSCC in the machine form the forms take, and none as none", () => {
    expect(machineSscc("046006820000015000")).toBe("00046006820000015000");
    expect(machineSscc(null)).toBeNull();
  });

  it("has a placard only for a pallet closed with an SSCC, one taken apart too", () => {
    expect(hasPlacard({ closedAt: "2026-10-08T07:00:00.000Z", sscc: "146006820000000409" })).toBe(
      true,
    );
    expect(hasPlacard({ closedAt: null, sscc: null })).toBe(false);
    expect(hasPlacard({ closedAt: "2026-10-08T07:00:00.000Z", sscc: null })).toBe(false);
    expect(palletPlacardData(MANY, MANY.pallets[1]?.id ?? "")).toBeNull();
    expect(palletPlacardData(MANY, MANY.pallets[5]?.id ?? "")).toBeNull();
    expect(palletPlacardData(MANY, MANY.pallets[3]?.id ?? "")?.status).toBe("disassembled");
    expect(palletPlacardData(MANY, MANY.pallets[0]?.id ?? "")?.status).toBe("closed");
  });

  it("knows no pallet the rows lack", () => {
    expect(palletReportData(ROWS, "a0000000-0000-4000-8000-000000000009")).toBeNull();
    expect(palletPlacardData(ROWS, "a0000000-0000-4000-8000-000000000009")).toBeNull();
  });

  it("prints the shift's placards of the pallets closed, standing and numbered, closed first first, then by id", () => {
    expect(placardPallets(MANY).map((each) => each.id.slice(-1))).toEqual(["5", "1", "3"]);
    expect(shiftPlacardsData(MANY)?.pallets.map((each) => each.sscc)).toEqual([
      "00146006820000000415",
      "00146006820000000411",
      "00146006820000000413",
    ]);
    expect(shiftPlacardsData(MANY)?.shiftNumber).toBe("OCT26-004");
    expect(
      shiftPlacardsData({ ...MANY, pallets: MANY.pallets.filter((each) => !hasPlacard(each)) }),
    ).toBeNull();
  });

  it("dates every box of a placard by the shift's production date", () => {
    expect(palletPlacardData(ROWS, CLOSED_PALLET.id)?.boxes).toEqual([
      { productionDate: "2026-10-08", codeCount: 2, disassembledAt: null },
    ]);
  });

  it("draws the blank of a planned or an active shift, with its one date as both dates, and none of a closed one", () => {
    const inputs = {
      shift: PLANNED,
      product: MILK,
      line: LINE_2,
      counterparty: NORTH,
      organization: ORG_PROFILE,
    };
    const at = new Date("2026-10-09T09:00:00Z");
    const blank = taskFormData(inputs, at);
    expect(blank).toMatchObject({
      status: "planned",
      plannedDate: PLANNED.productionDate,
      productionDate: PLANNED.productionDate,
      lineName: LINE_2.name,
      counterpartyName: NORTH.name,
      organizationName: ORG_PROFILE.name,
      imageChecksum: null,
      ssccIssuerName: null,
      generatedAt: at,
    });
    expect(taskFormData({ ...inputs, shift: ACTIVE, counterparty: null }, at)).toMatchObject({
      status: "active",
      counterpartyName: null,
    });
    expect(taskFormData({ ...inputs, shift: CLOSED }, at)).toBeNull();
    expect(
      renderForm({ kind: "task", inputs: { ...inputs, shift: CLOSED }, generatedAt: at }),
    ).toBe(null);
  });

  it("names each form's file, and refuses what the cloud refuses", () => {
    expect(
      renderForm({ kind: "placard", rows: MANY, palletId: MANY.pallets[0]?.id ?? "", format: "a5" })
        ?.fileName,
    ).toBe("Ярлык паллеты 146006820000000413 A5.html");
    expect(
      renderForm({
        kind: "placard",
        rows: MANY,
        palletId: MANY.pallets[1]?.id ?? "",
        format: "a4",
      }),
    ).toBeNull();
    expect(renderForm({ kind: "placards", rows: MANY, format: "a4" })?.fileName).toBe(
      "Ярлыки паллет смены A4.html",
    );
    expect(
      renderForm({
        kind: "pallet",
        rows: MANY,
        palletId: MANY.pallets[1]?.id ?? "",
        timeZone: "UTC",
      })?.fileName,
    ).toBe("Состав паллеты без SSCC.html");
    expect(
      renderForm({ kind: "pallet", rows: MANY, palletId: "missing", timeZone: "UTC" }),
    ).toBeNull();
  });

  it("writes times in the organization's zone, or this PC's when it is not known", () => {
    const here = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(formTimeZone({ ...ORG_PROFILE, timeZone: "Asia/Vladivostok" })).toBe("Asia/Vladivostok");
    expect(formTimeZone({ ...ORG_PROFILE, timeZone: "Mars/Olympus_Mons" })).toBe(here);
    expect(formTimeZone(undefined)).toBe(here);
  });
});
