import { describe, expect, it } from "vitest";

import { renderBoxReportHtml, type BoxReportData } from "../src/print-forms/box-report.js";
import {
  renderPalletPlacardHtml,
  renderShiftPlacardsHtml,
  type PalletPlacardData,
} from "../src/print-forms/pallet-placard.js";
import { renderPalletReportHtml, type PalletReportData } from "../src/print-forms/pallet-report.js";
import {
  renderShiftTaskFormHtml,
  type ShiftTaskFormData,
} from "../src/print-forms/shift-task-form.js";

/**
 * Byte-level contract of the printable forms. The fixtures were written before
 * the forms moved from apps/api into @markiro/domain
 * (docs/superpowers/plans/2026-09-26-standalone-00-print-forms-to-domain.md) and
 * remain the reference: every render is compared verbatim, and the files are
 * kept out of Prettier and of git's whitespace checks. To change a form on
 * purpose, run `pnpm --filter @markiro/domain exec vitest run -u
 * test/print-forms-snapshot.test.ts` and review the fixture diff like code.
 */

/** GS (ASCII 0x1D), the real KM separator byte. */
const GS = String.fromCharCode(0x1d);
/** Check-digit-valid GTIN; `renderDataMatrixSvg` enforces the AI-01 mod-10. */
const GTIN = "04600682000013";

const BOX: BoxReportData = {
  sscc: "00146007034967000010",
  status: "closed",
  productName: "Жигулёвское светлое 0,5 л",
  org: { name: "ООО «Пивзавод „Заря“»", inn: "5029087641", logo: null },
  openedAt: new Date("2026-09-09T21:58:00.000Z"),
  closedAt: new Date("2026-09-09T22:08:00.000Z"),
  disassembledAt: null,
  codes: [1, 2, 3].map((n) => ({
    gtin14: GTIN,
    serial: `SER${n}`,
    rawKm: `01${GTIN}21SER${n}${GS}93Abcd`,
  })),
};

const EMPTY_BOX: BoxReportData = {
  ...BOX,
  sscc: null,
  status: "disassembled",
  disassembledAt: new Date("2026-09-09T23:08:00.000Z"),
  codes: [],
};

const PALLET: PalletReportData = {
  sscc: "00146007034967100001",
  status: "closed",
  productName: "Жигулёвское светлое 0,5 л",
  org: { name: "ООО «Пивзавод „Заря“»", inn: "5029087641", logo: null },
  openedAt: new Date("2026-09-11T06:00:00.000Z"),
  closedAt: new Date("2026-09-11T09:30:00.000Z"),
  disassembledAt: null,
  boxes: [
    { sscc: "00146007034967000001", codeCount: 12, disassembledAt: null },
    {
      sscc: "00146007034967000002",
      codeCount: 12,
      disassembledAt: new Date("2026-09-11T08:00:00.000Z"),
    },
    { sscc: null, codeCount: 7, disassembledAt: null },
  ],
};

const PLACARD: PalletPlacardData = {
  sscc: "00104600682000000019",
  status: "closed",
  productName: "Вода питьевая негазированная «Атолл» 0,5 л, ПЭТ",
  gtin14: GTIN,
  shelfLifeDays: 180,
  org: { name: "ООО «Атолл»", inn: "7701234567", logo: null },
  boxes: [
    { productionDate: "2026-09-10", codeCount: 20, disassembledAt: null },
    { productionDate: "2026-09-14", codeCount: 20, disassembledAt: null },
    { productionDate: "2026-09-10", codeCount: 20, disassembledAt: null },
    { productionDate: null, codeCount: 18, disassembledAt: null },
  ],
};

const SECOND_PLACARD: PalletPlacardData = {
  ...PLACARD,
  sscc: null,
  status: "open",
  boxes: [{ productionDate: "2026-09-14", codeCount: 20, disassembledAt: null }],
};

const TASK: ShiftTaskFormData = {
  shiftId: "22222222-2222-4222-8222-222222222222",
  shiftNumber: "SEP26-014",
  status: "planned",
  mode: "aggregation",
  organizationName: "ООО «Атолл»",
  productId: "33333333-3333-4333-8333-333333333333",
  productName: "Вода питьевая «Атолл» негазированная, ПЭТ 0,5 л",
  productPrintName: "Атолл 0,5 л н/г",
  gtin14: "04607091380019",
  imageChecksum: "a".repeat(64),
  lineName: "Линия розлива №2",
  plannedDate: "2026-09-21",
  productionDate: "2026-09-21",
  plannedQty: 12_000,
  boxCapacity: 24,
  palletsEnabled: true,
  palletBoxCapacity: 40,
  counterpartyName: "ООО «Торговый дом Ромашка»",
  ssccIssuerName: null,
  validationPrintMode: "none",
  validationPrintVerification: "none",
  allowPreviouslyAcceptedCodes: false,
  generatedAt: new Date("2026-09-19T11:20:00.000Z"),
};

const VALIDATION_TASK: ShiftTaskFormData = {
  ...TASK,
  status: "active",
  mode: "validation",
  imageChecksum: null,
  boxCapacity: null,
  palletsEnabled: false,
  palletBoxCapacity: null,
  validationPrintMode: "duplicate_dm",
  validationPrintVerification: "required",
  allowPreviouslyAcceptedCodes: true,
};

describe("printable forms characterisation lock", () => {
  it("box contents report", async () => {
    await expect(renderBoxReportHtml(BOX, "Europe/Moscow")).toMatchFileSnapshot(
      "fixtures/print-forms/box-report.html",
    );
  });

  it("empty disassembled box without an SSCC", async () => {
    await expect(renderBoxReportHtml(EMPTY_BOX)).toMatchFileSnapshot(
      "fixtures/print-forms/box-report-empty.html",
    );
  });

  it("pallet contents report", async () => {
    await expect(renderPalletReportHtml(PALLET, "Asia/Vladivostok")).toMatchFileSnapshot(
      "fixtures/print-forms/pallet-report.html",
    );
  });

  it("pallet placard, A4", async () => {
    await expect(renderPalletPlacardHtml(PLACARD, "a4")).toMatchFileSnapshot(
      "fixtures/print-forms/pallet-placard-a4.html",
    );
  });

  it("pallet placard, A5", async () => {
    await expect(renderPalletPlacardHtml(PLACARD, "a5")).toMatchFileSnapshot(
      "fixtures/print-forms/pallet-placard-a5.html",
    );
  });

  it("all placards of a shift, A5", async () => {
    await expect(
      renderShiftPlacardsHtml([PLACARD, SECOND_PLACARD], "a5", "SEP26-014"),
    ).toMatchFileSnapshot("fixtures/print-forms/shift-placards-a5.html");
  });

  it("aggregation shift task form", async () => {
    await expect(renderShiftTaskFormHtml(TASK)).toMatchFileSnapshot(
      "fixtures/print-forms/shift-task-form-aggregation.html",
    );
  });

  it("validation shift task form with a duplicate Data Matrix", async () => {
    await expect(renderShiftTaskFormHtml(VALIDATION_TASK)).toMatchFileSnapshot(
      "fixtures/print-forms/shift-task-form-validation.html",
    );
  });
});
