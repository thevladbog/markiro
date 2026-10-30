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

  it("prints the product's photo on the blank from its own bytes, and no photo box without one (plan ТОВ)", () => {
    const photo = {
      width: 2,
      height: 1,
      dataBase64: "/9j/4AAQSkZJRgABAQ==",
      mediaType: "image/jpeg" as const,
      checksum: "ae0e381fa858d6782d6859eb9337b80e670dc0021361fdd55d49299f1b4c26fd",
      updatedAt: "2026-10-13T09:00:00.000Z",
    };
    const inputs = {
      shift: PLANNED,
      product: { ...MILK, photoChecksum: photo.checksum },
      line: LINE_2,
      counterparty: NORTH,
      organization: ORG_PROFILE,
      photo,
    };
    const at = new Date("2026-10-09T09:00:00Z");
    expect(taskFormData(inputs, at)).toMatchObject({
      imageChecksum: photo.checksum,
      imageSrc: `data:image/jpeg;base64,${photo.dataBase64}`,
    });
    const html = renderForm({ kind: "task", inputs, generatedAt: at })?.html ?? "";
    expect(html).toContain(`src="data:image/jpeg;base64,${photo.dataBase64}"`);
    expect(html).not.toContain("../../products/");
    expect(html).not.toContain('class="product product--no-photo"');
    const bare = renderForm({
      kind: "task",
      inputs: { ...inputs, photo: null },
      generatedAt: at,
    })?.html;
    expect(bare).toContain('class="product product--no-photo"');
    expect(bare).not.toContain("<img");
  });

  it("draws the blank of a planned or an active shift, with its own date and its production date, and none of a closed one", () => {
    const inputs = {
      shift: PLANNED,
      product: MILK,
      line: LINE_2,
      counterparty: NORTH,
      organization: ORG_PROFILE,
      photo: null,
    };
    const at = new Date("2026-10-09T09:00:00Z");
    const blank = taskFormData(inputs, at);
    expect(blank).toMatchObject({
      status: "planned",
      plannedDate: PLANNED.plannedDate,
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
    ).toBe("Ярлык палета 146006820000000413 A5.html");
    expect(
      renderForm({
        kind: "placard",
        rows: MANY,
        palletId: MANY.pallets[1]?.id ?? "",
        format: "a4",
      }),
    ).toBeNull();
    expect(renderForm({ kind: "placards", rows: MANY, format: "a4" })?.fileName).toBe(
      "Ярлыки палетов смены A4.html",
    );
    expect(
      renderForm({
        kind: "pallet",
        rows: MANY,
        palletId: MANY.pallets[1]?.id ?? "",
        timeZone: "UTC",
      })?.fileName,
    ).toBe("Состав палета без SSCC.html");
    expect(
      renderForm({ kind: "pallet", rows: MANY, palletId: "missing", timeZone: "UTC" }),
    ).toBeNull();
  });

  it("writes times in the organization's zone", () => {
    expect(formTimeZone({ ...ORG_PROFILE, timeZone: "Asia/Vladivostok" })).toBe("Asia/Vladivostok");
  });

  // Node re-reads `TZ` at run time on POSIX only; on Windows the assignment below changes nothing.
  it.skipIf(process.platform === "win32")(
    "writes times in this PC's zone, not UTC, when the organization's is not known",
    () => {
      // A zone that is neither UTC nor the one a test machine is likely to be in.
      const zone = process.env.TZ;
      process.env.TZ = "Pacific/Kiritimati";
      try {
        expect(formTimeZone({ ...ORG_PROFILE, timeZone: "Mars/Olympus_Mons" })).toBe(
          "Pacific/Kiritimati",
        );
        expect(formTimeZone(undefined)).toBe("Pacific/Kiritimati");
      } finally {
        if (zone === undefined) delete process.env.TZ;
        else process.env.TZ = zone;
      }
    },
  );
});
