import { describe, expect, it } from "vitest";

import {
  renderDisaggregationReportHtml,
  type DisaggregationReportData,
} from "../src/modules/disaggregation/report";

/**
 * Characterisation lock for moving «Акт дезагрегации» into @markiro/domain
 * (docs/superpowers/plans/2026-10-13-standalone-dzg-o-disaggregation-office.md).
 * The files are written into the domain's print-forms fixtures, which are
 * kept out of Prettier and of git's whitespace checks; the move must not
 * change a byte of them. `apps/standalone/test/disaggregation-act.test.ts`
 * draws the host's rows of the same facts to the same bytes.
 */

const SNAPSHOTS = "../../../packages/domain/test/fixtures/print-forms";
/** GS (ASCII 0x1D), the real KM separator byte. */
const GS = String.fromCharCode(0x1d);
/** Check-digit-valid GTIN; `renderDataMatrixSvg` enforces the AI-01 mod-10. */
const GTIN = "04600682000013";

const km = (n: number) => ({
  gtin14: GTIN,
  serial: `S00000${n}`,
  rawKm: `01${GTIN}21S00000${n}${GS}93Tail${n}`,
});

/** One box (two codes) and one pallet (two boxes of 12), applied. */
export const ACT_FULL: DisaggregationReportData = {
  docNo: "DSG-26-0007",
  status: "applied",
  createdAt: new Date("2026-10-12T09:12:00.000Z"),
  // 21:30 UTC is already the next day in Moscow: the zone's snapshot shows it.
  appliedAt: new Date("2026-10-12T21:30:00.000Z"),
  org: { name: "ООО «Атолл»", inn: "7701234567", logo: null },
  createdByName: "Павел Орлов",
  appliedByName: "Ирина Смирнова",
  reasonName: "Повреждение упаковки",
  comment: "Короба намокли при разгрузке",
  includeContents: true,
  lines: [
    {
      n: 1,
      sscc: "00046007034967000017",
      productName: "Вода «Атолл» 0,5 л",
      codeCount: 2,
      codes: [km(1), km(2)],
      boxes: [],
    },
    {
      n: 2,
      sscc: "00146007034967100014",
      productName: "Вода «Атолл» 0,5 л",
      codeCount: 24,
      codes: [],
      boxes: [
        { sscc: "00046007034967000024", codeCount: 12 },
        { sscc: "00046007034967000031", codeCount: 12 },
      ],
    },
  ],
};

export const ACT_BOXES: DisaggregationReportData = {
  ...ACT_FULL,
  includeContents: false,
  lines: ACT_FULL.lines.map((line) => ({ ...line, codes: [], boxes: [] })),
};

/** A draft without an organization, a reason or a comment; a code that cannot be drawn. */
const ACT_DRAFT: DisaggregationReportData = {
  ...ACT_FULL,
  status: "draft",
  appliedAt: null,
  appliedByName: null,
  org: null,
  reasonName: null,
  comment: null,
  lines: [
    {
      n: 1,
      sscc: "00046007034967000017",
      productName: null,
      codeCount: 1,
      codes: [{ gtin14: GTIN, serial: "BROKEN", rawKm: "not-a-valid-km" }],
      boxes: [],
    },
    {
      n: 2,
      sscc: "00046007034967000048",
      productName: "Вода «Атолл» 0,5 л",
      codeCount: 0,
      codes: [],
      boxes: [],
    },
  ],
};

describe("disaggregation act characterisation lock", () => {
  it("boxes only", async () => {
    await expect(renderDisaggregationReportHtml(ACT_BOXES)).toMatchFileSnapshot(
      `${SNAPSHOTS}/disaggregation-act-boxes.html`,
    );
  });

  it("boxes and contents: a box's codes and a pallet's boxes", async () => {
    await expect(renderDisaggregationReportHtml(ACT_FULL)).toMatchFileSnapshot(
      `${SNAPSHOTS}/disaggregation-act-full.html`,
    );
  });

  it("a draft without an organization, with a broken code and an empty box", async () => {
    await expect(renderDisaggregationReportHtml(ACT_DRAFT)).toMatchFileSnapshot(
      `${SNAPSHOTS}/disaggregation-act-draft.html`,
    );
  });
});
