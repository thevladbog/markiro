import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { shiftExportRowsSchema, type ShiftExportRows } from "../src/host/protocol.js";
import {
  palletExportSnapshot,
  shiftExportSnapshot,
  type ShiftExportSnapshot,
} from "../src/office/exports/export-source.js";
import { runExport } from "../src/office/exports/run-export.js";

/**
 * The source rules of the cloud that the shared parity cases do not bind on
 * their own (plan ЧЗ, task 5): each test below pins one rule of the port with
 * rows where a one-line change of the port gives another answer. Several
 * states are ones the host's CHECKs never let into its tables (an open pallet
 * with an SSCC, a closed box without one); the cloud's schema allows them and
 * the port answers them as the cloud does, so they are pinned with synthetic
 * rows through the same schema the host's answer passes.
 */

const testModuleUrl = import.meta.url;
const FORMED_AT = "2026-10-08T15:30:00.123Z";
const DOCUMENT = "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f";
const FLAT_TXT = { boxMode: "flat", extension: "txt" } as const;
const BOXES_TXT = { boxMode: "boxes", extension: "txt" } as const;
const BOXES_XML = { boxMode: "boxes", extension: "xml" } as const;
const PALLETS_TXT = { boxMode: "pallets", extension: "txt" } as const;

/** `shift-export-rows.json`: a closed shift with pallet 1 (box 1), box 2 on no pallet, box 3 open and empty. */
function fixtureRows(): ShiftExportRows {
  return shiftExportRowsSchema.parse(
    JSON.parse(
      readFileSync(new URL("../proto/fixtures/shift-export-rows.json", testModuleUrl), "utf8"),
    ),
  );
}

const SHIFT_ID = "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b";
const day = (time: string): string => `2026-10-08T${time}Z`;
const hash = (n: number): string => n.toString(16).padStart(64, "0");
const sscc = (n: number): string => `04600682000001${String(n).padStart(4, "0")}`;
const palletSscc = (n: number): string => `14600682000000${String(n).padStart(4, "0")}`;
const boxId = (n: number): string => `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const palletId = (n: number): string => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

interface CodeSpec {
  n: number;
  scannedAt?: string;
  /** The code's text; `canonical(n)` when absent. The hash stays `hash(n)`. */
  text?: string;
}
interface BoxSpec {
  n: number;
  /** `undefined`: closed at 06:30; `null`: still open. */
  closedAt?: string | null;
  /** `undefined`: the box's SSCC; `null`: none. */
  sscc?: string | null;
  disassembledAt?: string | null;
  palletId?: string | null;
  /** The codes the box holds (live items). */
  codes: number[];
}
interface PalletSpec {
  n: number;
  closedAt?: string | null;
  sscc?: string | null;
  disassembledAt?: string | null;
}

/** The text of code `n` in the rows: what `canonical` gives, to read orders off. */
const canonical = (n: number): string => `KM-${n}`;

function build(parts: {
  shift?: Partial<ShiftExportRows["shift"]>;
  organization?: ShiftExportRows["organization"];
  codes: CodeSpec[];
  boxes: BoxSpec[];
  pallets?: PalletSpec[];
}): ShiftExportRows {
  return shiftExportRowsSchema.parse({
    shift: {
      id: SHIFT_ID,
      number: "OCT26-004",
      status: "closed",
      productionDate: "2026-10-08",
      productName: "Молоко",
      palletsEnabled: true,
      closedAt: day("14:00:07"),
      stationClosedAt: null,
      lateDataAt: null,
      ...parts.shift,
    },
    organization: parts.organization ?? { name: "ООО «Атолл»", inn: "7701234567" },
    codes: parts.codes.map((spec) => ({
      codeHash: hash(spec.n),
      scannedAt: spec.scannedAt ?? day("06:00:00.000"),
      canonical: spec.text ?? canonical(spec.n),
    })),
    boxes: parts.boxes.map((spec) => ({
      id: boxId(spec.n),
      sscc: spec.sscc === undefined ? sscc(spec.n) : spec.sscc,
      openedAt: day("06:00:00.000"),
      closedAt: spec.closedAt === undefined ? day("06:30:00.000") : spec.closedAt,
      disassembledAt: spec.disassembledAt ?? null,
      palletId: spec.palletId === undefined || spec.palletId === null ? null : spec.palletId,
    })),
    items: parts.boxes.flatMap((spec) =>
      spec.codes.map((n) => ({ boxId: boxId(spec.n), codeHash: hash(n) })),
    ),
    pallets: (parts.pallets ?? []).map((spec) => ({
      id: palletId(spec.n),
      sscc: spec.sscc === undefined ? palletSscc(spec.n) : spec.sscc,
      openedAt: day("06:00:00.000"),
      closedAt: spec.closedAt === undefined ? day("07:00:00.000") : spec.closedAt,
      disassembledAt: spec.disassembledAt ?? null,
    })),
  });
}

function snapshotOf(
  rows: ShiftExportRows,
  format: { boxMode: "flat" | "boxes" | "pallets"; extension: "txt" | "xml" },
): ShiftExportSnapshot {
  const snapshot = shiftExportSnapshot(rows, format, FORMED_AT);
  if (!snapshot.ok) throw new Error(snapshot.refusal);
  return snapshot.value;
}

function refusalOf(
  rows: ShiftExportRows,
  format: { boxMode: "flat" | "boxes" | "pallets"; extension: "txt" | "xml" },
): string | null {
  const snapshot = shiftExportSnapshot(rows, format, FORMED_AT);
  return snapshot.ok ? null : snapshot.refusal;
}

describe("the order of a shift's codes (plan ЧЗ)", () => {
  it("is the scan instant to the millisecond, then the hash", () => {
    const rows = build({
      codes: [
        { n: 2, scannedAt: day("06:05:12.500") },
        { n: 1, scannedAt: day("06:05:12.031") },
        { n: 3, scannedAt: day("06:05:12.031") },
      ],
      boxes: [{ n: 1, codes: [1, 2, 3] }],
    });
    expect(snapshotOf(rows, FLAT_TXT).source).toEqual({
      mode: "flat",
      codes: [canonical(1), canonical(3), canonical(2)],
    });
  });

  it.each([
    ["flat", FLAT_TXT],
    ["boxes", BOXES_TXT],
  ] as const)(
    "breaks a tie of instants by the hash, not by the text of the code (%s)",
    (_, format) => {
      // Hash 10 (…0a) comes before hash 11 (…0b); the texts run the other way.
      const rows = build({
        codes: [
          { n: 11, text: "KM-A" },
          { n: 10, text: "KM-Z" },
        ],
        boxes: [{ n: 1, codes: [11, 10] }],
      });
      const source = snapshotOf(rows, format).source;
      expect(source).toEqual(
        format.boxMode === "flat"
          ? { mode: "flat", codes: ["KM-Z", "KM-A"] }
          : { mode: "boxes", boxes: [{ sscc: sscc(1), codes: ["KM-Z", "KM-A"] }] },
      );
    },
  );

  it("orders a box's codes the same way, not by hash alone", () => {
    const rows = build({
      codes: [
        { n: 9, scannedAt: day("06:00:01.000") },
        { n: 1, scannedAt: day("06:00:02.000") },
        { n: 2, scannedAt: day("06:00:02.000") },
      ],
      boxes: [{ n: 1, codes: [2, 1, 9] }],
    });
    expect(snapshotOf(rows, BOXES_TXT).source).toEqual({
      mode: "boxes",
      boxes: [{ sscc: sscc(1), codes: [canonical(9), canonical(1), canonical(2)] }],
    });
  });
});

describe("the boxes a box format lists (plan ЧЗ)", () => {
  it("needs every code in a closed box that has an SSCC", () => {
    const rows = build({
      codes: [{ n: 1 }, { n: 2 }],
      boxes: [
        { n: 1, codes: [1] },
        { n: 2, sscc: null, codes: [2] },
      ],
    });
    expect(refusalOf(rows, BOXES_TXT)).toBe("BOX_COVERAGE_INCOMPLETE");
  });

  it("refuses a box that holds a code the shift does not own", () => {
    const rows = build({
      codes: [{ n: 1 }],
      boxes: [{ n: 1, codes: [1, 2] }],
    });
    expect(refusalOf(rows, BOXES_TXT)).toBe("BOX_COVERAGE_INCOMPLETE");
  });

  it("ignores an item whose box is not in the rows", () => {
    const rows = build({
      codes: [{ n: 1 }],
      boxes: [{ n: 1, codes: [1] }],
    });
    rows.items.push({ boxId: boxId(9), codeHash: hash(1) });
    expect(snapshotOf(rows, BOXES_TXT).source).toEqual({
      mode: "boxes",
      boxes: [{ sscc: sscc(1), codes: [canonical(1)] }],
    });
  });

  it("leaves out a box that is still open, whatever its SSCC", () => {
    const rows = build({
      codes: [{ n: 1 }, { n: 2 }],
      boxes: [
        { n: 1, codes: [1] },
        { n: 2, closedAt: null, codes: [2] },
      ],
    });
    expect(refusalOf(rows, BOXES_TXT)).toBe("BOX_COVERAGE_INCOMPLETE");
  });
});

describe("the groups of a pallets format (plan ЧЗ)", () => {
  it("puts pallets in the order of their close, whatever their SSCCs say", () => {
    const rows = build({
      codes: [{ n: 1 }, { n: 2 }],
      boxes: [
        { n: 1, palletId: palletId(1), codes: [1] },
        { n: 2, palletId: palletId(2), codes: [2] },
      ],
      pallets: [
        { n: 1, sscc: palletSscc(9), closedAt: day("07:00:00.000") },
        { n: 2, sscc: palletSscc(1), closedAt: day("08:00:00.000") },
      ],
    });
    const source = snapshotOf(rows, PALLETS_TXT).source;
    expect(source.mode === "pallets" && source.pallets.map((pallet) => pallet.sscc)).toEqual([
      palletSscc(9),
      palletSscc(1),
    ]);
  });

  it("compares the close as an instant, not as the text of one", () => {
    const rows = build({
      codes: [{ n: 1 }, { n: 2 }],
      boxes: [
        { n: 1, palletId: palletId(1), codes: [1] },
        { n: 2, palletId: palletId(2), codes: [2] },
      ],
      pallets: [
        { n: 1, sscc: palletSscc(9), closedAt: "2026-10-08T07:00:00Z" },
        { n: 2, sscc: palletSscc(1), closedAt: "2026-10-08T07:00:00.500Z" },
      ],
    });
    const source = snapshotOf(rows, PALLETS_TXT).source;
    expect(source.mode === "pallets" && source.pallets.map((pallet) => pallet.sscc)).toEqual([
      palletSscc(9),
      palletSscc(1),
    ]);
  });

  it("puts a pallet without a close first, as the cloud's comparison does", () => {
    const rows = build({
      codes: [{ n: 1 }, { n: 2 }],
      boxes: [
        { n: 1, palletId: palletId(1), codes: [1] },
        { n: 2, palletId: palletId(2), codes: [2] },
      ],
      pallets: [
        { n: 1, sscc: palletSscc(1), closedAt: day("07:00:00.000") },
        { n: 2, sscc: palletSscc(9), closedAt: null },
      ],
    });
    const source = snapshotOf(rows, PALLETS_TXT).source;
    expect(source.mode === "pallets" && source.pallets.map((pallet) => pallet.sscc)).toEqual([
      palletSscc(9),
      palletSscc(1),
    ]);
  });

  it("lists the loose boxes by SSCC after the pallets", () => {
    const rows = build({
      codes: [{ n: 1 }, { n: 2 }, { n: 3 }],
      boxes: [
        { n: 7, codes: [1] },
        { n: 3, codes: [2] },
        { n: 5, palletId: palletId(1), codes: [3] },
      ],
      pallets: [{ n: 1 }],
    });
    const source = snapshotOf(rows, PALLETS_TXT).source;
    expect(source).toEqual({
      mode: "pallets",
      pallets: [{ sscc: palletSscc(1), boxes: [{ sscc: sscc(5), codes: [canonical(3)] }] }],
      looseBoxes: [
        { sscc: sscc(3), codes: [canonical(2)] },
        { sscc: sscc(7), codes: [canonical(1)] },
      ],
    });
  });

  it("counts as suppressed only a box of a pallet that exists and has no SSCC yet", () => {
    const rows = build({
      codes: [{ n: 1 }, { n: 2 }, { n: 3 }],
      boxes: [
        { n: 1, palletId: palletId(1), codes: [1] },
        { n: 2, palletId: palletId(2), codes: [2] },
        { n: 3, palletId: palletId(3), codes: [3] },
      ],
      // Pallet 2 is open (no SSCC, no close); pallet 3 is not in the rows at all.
      pallets: [{ n: 1 }, { n: 2, sscc: null, closedAt: null }],
    });
    const snapshot = snapshotOf(rows, PALLETS_TXT);
    expect(snapshot.openPalletSuppressedBoxCount).toBe(1);
    expect(snapshot.source).toMatchObject({
      looseBoxes: [{ sscc: sscc(2) }, { sscc: sscc(3) }],
    });
  });

  it("counts a taken-apart pallet once, however many boxes it has", () => {
    const rows = build({
      codes: [{ n: 1 }, { n: 2 }, { n: 3 }],
      boxes: [
        { n: 1, palletId: palletId(1), codes: [1] },
        { n: 2, palletId: palletId(1), codes: [2] },
        { n: 3, palletId: palletId(2), codes: [3] },
      ],
      pallets: [{ n: 1, disassembledAt: day("09:00:00.000") }, { n: 2 }],
    });
    expect(snapshotOf(rows, PALLETS_TXT).disassembledPalletCount).toBe(1);
  });

  it("carries the counts into an export run's result", () => {
    const rows = fixtureRows();
    const [pallet] = rows.pallets;
    if (pallet === undefined) throw new Error("the fixture has a pallet");
    pallet.disassembledAt = day("07:00:00.000");
    const result = runExport(rows, {
      formatId: "shift_txt_pallets",
      formatVersion: 1,
      maxLines: null,
      palletId: null,
      documentId: DOCUMENT,
      formedAt: FORMED_AT,
    });
    if (!result.ok) throw new Error(result.failure);
    expect(result.disassembledPalletCount).toBe(1);
    expect(result.openPalletSuppressedBoxCount).toBe(0);
  });

  it("carries the number of boxes held back by an open pallet into the run's result", () => {
    const rows = build({
      codes: [{ n: 1 }, { n: 2 }],
      boxes: [
        { n: 1, palletId: palletId(1), codes: [1] },
        { n: 2, palletId: palletId(2), codes: [2] },
      ],
      pallets: [{ n: 1 }, { n: 2, sscc: null, closedAt: null }],
    });
    const result = runExport(rows, {
      formatId: "shift_txt_pallets",
      formatVersion: 1,
      maxLines: null,
      palletId: null,
      documentId: DOCUMENT,
      formedAt: FORMED_AT,
    });
    if (!result.ok) throw new Error(result.failure);
    expect(result.openPalletSuppressedBoxCount).toBe(1);
  });
});

describe("what a shift's export needs to start (plan ЧЗ)", () => {
  it.each(["planned", "active"] as const)("refuses a shift that is %s", (status) => {
    const rows = build({
      shift: { status },
      codes: [{ n: 1 }],
      boxes: [{ n: 1, codes: [1] }],
    });
    expect(refusalOf(rows, FLAT_TXT)).toBe("SHIFT_NOT_CLOSED");
  });

  it("names the INN first when the INN and the name are both missing", () => {
    const rows = build({
      organization: { name: " ", inn: null },
      codes: [{ n: 1 }],
      boxes: [{ n: 1, codes: [1] }],
    });
    expect(refusalOf(rows, BOXES_XML)).toBe("ORG_INN_MISSING");
  });

  it("names the name when only the name is blank", () => {
    const rows = build({
      organization: { name: "  ", inn: "7701234567" },
      codes: [{ n: 1 }],
      boxes: [{ n: 1, codes: [1] }],
    });
    expect(refusalOf(rows, BOXES_XML)).toBe("ORG_NAME_MISSING");
  });

  it("takes a blank INN for a missing one", () => {
    const rows = build({
      organization: { name: "ООО «Атолл»", inn: "   " },
      codes: [{ n: 1 }],
      boxes: [{ n: 1, codes: [1] }],
    });
    expect(refusalOf(rows, BOXES_XML)).toBe("ORG_INN_MISSING");
  });

  it("asks a text format nothing of the organization", () => {
    const rows = build({
      organization: { name: "", inn: null },
      codes: [{ n: 1 }],
      boxes: [{ n: 1, codes: [1] }],
    });
    expect(refusalOf(rows, BOXES_TXT)).toBeNull();
  });

  it("trims the INN and the name it hands over", () => {
    const rows = build({
      organization: { name: "  ООО «Атолл» ", inn: " 7701234567  " },
      codes: [{ n: 1 }],
      boxes: [{ n: 1, codes: [1] }],
    });
    const snapshot = snapshotOf(rows, BOXES_XML);
    expect([snapshot.organizationInn, snapshot.organizationName]).toEqual([
      "7701234567",
      "ООО «Атолл»",
    ]);
  });

  it("takes the date of the document from the production date, not from the close", () => {
    const rows = build({
      shift: {
        productionDate: "2026-10-08",
        closedAt: "2026-10-09T01:00:00Z",
        stationClosedAt: "2026-10-09T01:00:00.000Z",
      },
      codes: [{ n: 1 }],
      boxes: [{ n: 1, codes: [1] }],
    });
    expect(snapshotOf(rows, FLAT_TXT).shiftDate).toBe("2026-10-08");
  });

  it("gives the XML the same bytes for an organization with padded text", () => {
    const padded = fixtureRows();
    padded.organization = { name: "  ООО «Атолл»  ", inn: " 7701234567 " };
    for (const [formatId, pallet] of [
      ["shift_xml_gismt_aggregation", null],
      ["pallet_xml_gismt_aggregation", "a0000000-0000-4000-8000-000000000001"],
    ] as const) {
      const run = {
        formatId,
        formatVersion: 1,
        maxLines: null,
        palletId: pallet,
        documentId: DOCUMENT,
        formedAt: FORMED_AT,
      };
      const clean = runExport(fixtureRows(), run);
      expect(clean.ok).toBe(true);
      expect(runExport(padded, run)).toEqual(clean);
    }
  });
});

describe("one pallet's document (plan ЧЗ)", () => {
  afterEach(() => vi.unstubAllEnvs());

  function pallets(spec: PalletSpec, boxes: BoxSpec[] = []): ShiftExportRows {
    return build({
      codes: [{ n: 1 }],
      boxes: [{ n: 99, codes: [1] }, ...boxes],
      pallets: [spec],
    });
  }

  it("lists a pallet's boxes by their close, then by id, not by SSCC", () => {
    const rows = build({
      codes: [{ n: 1 }, { n: 2 }],
      boxes: [
        // Same close: the ids (4 before 5) run against the SSCCs (9 after 1).
        { n: 5, sscc: sscc(1), palletId: palletId(1), codes: [1] },
        { n: 4, sscc: sscc(9), palletId: palletId(1), codes: [2] },
      ],
      pallets: [{ n: 1 }],
    });
    const snapshot = palletExportSnapshot(rows, palletId(1));
    if (!snapshot.ok) throw new Error(snapshot.refusal);
    expect(snapshot.value.pallet.boxSsccs).toEqual([sscc(9), sscc(1)]);
  });

  it("lists a pallet's boxes by the millisecond of their close, not by the second", () => {
    const rows = build({
      codes: [{ n: 1 }, { n: 2 }],
      boxes: [
        // The same second: box 1 closes at .900 (id before box 2's), box 2 at .100.
        { n: 1, closedAt: day("06:30:00.900"), palletId: palletId(1), codes: [1] },
        { n: 2, closedAt: day("06:30:00.100"), palletId: palletId(1), codes: [2] },
      ],
      pallets: [{ n: 1 }],
    });
    const snapshot = palletExportSnapshot(rows, palletId(1));
    if (!snapshot.ok) throw new Error(snapshot.refusal);
    expect(snapshot.value.pallet.boxSsccs).toEqual([sscc(2), sscc(1)]);
  });

  it("leaves out a closed box that has no SSCC", () => {
    const rows = build({
      codes: [{ n: 1 }, { n: 2 }],
      boxes: [
        { n: 1, palletId: palletId(1), codes: [1] },
        { n: 2, sscc: null, palletId: palletId(1), codes: [2] },
      ],
      pallets: [{ n: 1 }],
    });
    const snapshot = palletExportSnapshot(rows, palletId(1));
    if (!snapshot.ok) throw new Error(snapshot.refusal);
    expect(snapshot.value.pallet.boxSsccs).toEqual([sscc(1)]);
  });

  it("trims the organization it hands over and passes a blank one on as missing", () => {
    const padded = pallets({ n: 1 });
    padded.organization = { name: "  ООО «Атолл» ", inn: " 7701234567  " };
    const trimmed = palletExportSnapshot(padded, palletId(1));
    if (!trimmed.ok) throw new Error(trimmed.refusal);
    expect([trimmed.value.organizationInn, trimmed.value.organizationName]).toEqual([
      "7701234567",
      "ООО «Атолл»",
    ]);
    const blank = pallets({ n: 1 });
    blank.organization = { name: " ", inn: "  " };
    const missing = palletExportSnapshot(blank, palletId(1));
    if (!missing.ok) throw new Error(missing.refusal);
    expect([missing.value.organizationInn, missing.value.organizationName]).toEqual([null, null]);
  });

  it.each([
    ["is not in the rows", () => build({ codes: [{ n: 1 }], boxes: [{ n: 1, codes: [1] }] })],
    ["has an SSCC but no close", () => pallets({ n: 1, closedAt: null })],
    ["has a close but no SSCC", () => pallets({ n: 1, sscc: null })],
  ])("refuses a pallet that %s as not closed", (_name, rowsOf) => {
    const snapshot = palletExportSnapshot(rowsOf(), palletId(1));
    expect(snapshot).toEqual({ ok: false, refusal: "PALLET_NOT_CLOSED" });
  });

  it("takes the date of the file from the UTC day of the close, in any time zone", () => {
    vi.stubEnv("TZ", "Europe/Moscow");
    const rows = pallets({ n: 1, closedAt: "2026-10-08T22:30:00.000Z" });
    const snapshot = palletExportSnapshot(rows, palletId(1));
    if (!snapshot.ok) throw new Error(snapshot.refusal);
    expect(snapshot.value.closedDate).toBe("2026-10-08");
    expect(snapshot.value.operationDateTime).toBe("2026-10-08T22:30:00.000Z");
  });
});

describe("what the domain refuses in an export run (plan ЧЗ)", () => {
  const run = {
    formatVersion: 1,
    palletId: null,
    documentId: DOCUMENT,
    formedAt: FORMED_AT,
  };

  it.each([0, 1, 1_000_001, 2.5])("refuses the line limit %s as it is", (maxLines) => {
    expect(runExport(fixtureRows(), { ...run, formatId: "shift_txt_flat", maxLines })).toEqual({
      ok: false,
      failure: "INVALID_LINE_LIMIT",
    });
  });

  it("refuses a box SSCC that is not eighteen digits as it is", () => {
    const rows = fixtureRows();
    const box = rows.boxes[1];
    if (box === undefined) throw new Error("the fixture has a second box");
    box.sscc = "0460068200001501";
    expect(
      runExport(rows, { ...run, formatId: "shift_xml_gismt_aggregation", maxLines: null }),
    ).toEqual({ ok: false, failure: "INVALID_BOX_SSCC" });
  });

  it.each([
    ["ORG_INN_MISSING", { name: "ООО «Атолл»", inn: " " }],
    ["ORG_NAME_MISSING", { name: " ", inn: "7701234567" }],
    ["INVALID_ORG_INN", { name: "ООО «Атолл»", inn: "770123456789" }],
  ])("refuses a pallet's document with %s as it is, where the domain finds it", (failure, org) => {
    const rows = fixtureRows();
    rows.organization = org;
    expect(
      runExport(rows, {
        ...run,
        formatId: "pallet_xml_gismt_aggregation",
        maxLines: null,
        palletId: "a0000000-0000-4000-8000-000000000001",
      }),
    ).toEqual({ ok: false, failure });
  });

  it("looks a pallet's format up before its pallet", () => {
    expect(
      runExport(fixtureRows(), {
        ...run,
        formatId: "pallet_xml_gismt_aggregation",
        formatVersion: 7,
        maxLines: null,
        palletId: "a0000000-0000-4000-8000-0000000000ff",
      }),
    ).toEqual({ ok: false, failure: "FORMAT_NOT_FOUND" });
  });
});
