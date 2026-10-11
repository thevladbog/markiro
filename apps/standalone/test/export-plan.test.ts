import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ShiftExportRows } from "../src/host/protocol.js";

import {
  exportCounts,
  exportWarnings,
  formatCheck,
  formatOffers,
  offeredFormats,
  palletOffers,
  palletWarnings,
} from "../src/office/exports/export-checks.js";
import { planExport, useExportPlan, type PlanProgress } from "../src/office/exports/export-plan.js";
import { runExport } from "../src/office/exports/run-export.js";
import {
  exportRows as rows,
  PALLET_1,
  PALLET_2,
  PALLET_3,
  warnedExportRows as warned,
} from "./support/export-rows.js";

const FORMED_AT = "2026-10-08T15:30:00.123Z";
const DOCUMENT = "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f";

describe("a format's check (plan ЧЗ, the dialog's one pass)", () => {
  it("is the offer and the warnings of one snapshot, for every format the shift is offered", () => {
    const shift = warned();
    const offers = formatOffers(shift, FORMED_AT);
    expect(offeredFormats(shift)).toEqual(offers.map((offer) => offer.format));
    const checks = offeredFormats(shift).map((format) => formatCheck(shift, format, FORMED_AT));
    expect(checks.map(({ format, refusal }) => ({ format, refusal }))).toEqual(offers);
    for (const check of checks) {
      expect(check.warnings).toEqual(exportWarnings(shift, check.format, FORMED_AT));
    }
    // The case really has every warning, so the equality above binds each kind.
    const palletsCheck = checks.find((check) => check.format.id === "shift_txt_pallets");
    expect(palletsCheck?.warnings.map((warning) => warning.kind)).toEqual([
      "late_data",
      "open_pallets",
      "disassembled_pallets",
      "late_boxes",
    ]);
    expect(checks.find((check) => check.format.id === "shift_txt_flat")?.warnings).toEqual([
      { kind: "late_data", at: "2026-10-08T16:00:00Z" },
    ]);
  });

  it("offers a shift without pallets the five formats that need none", () => {
    const shift = rows();
    shift.shift.palletsEnabled = false;
    expect(offeredFormats(shift).map((format) => format.id)).toEqual([
      "shift_txt_flat",
      "shift_txt_boxes",
      "shift_csv_flat",
      "shift_csv_boxes",
      "shift_xml_gismt_aggregation",
    ]);
  });
});

describe("the dialog's plan (plan ЧЗ), made in turns", () => {
  function deps(live: () => boolean = () => true) {
    const progress: PlanProgress[] = [];
    return {
      pause: vi.fn(async () => undefined),
      live,
      progress: (step: PlanProgress) => progress.push(step),
      steps: progress,
    };
  }

  it("is the counts, a check of each format and every pallet with its late boxes, one turn each", async () => {
    const shift = warned();
    const made = deps();
    const plan = await planExport(shift, FORMED_AT, made);
    expect(plan).toEqual({
      counts: exportCounts(shift),
      checks: offeredFormats(shift).map((format) => formatCheck(shift, format, FORMED_AT)),
      pallets: palletOffers(shift).map((pallet) => ({
        ...pallet,
        warnings: palletWarnings(shift, pallet.palletId),
      })),
    });
    // Counts, ten formats, the pallets: twelve turns, a pause before each, progress after each.
    expect(made.pause).toHaveBeenCalledTimes(12);
    expect(made.steps).toEqual(
      Array.from({ length: 12 }, (_, index) => ({ done: index + 1, total: 12 })),
    );
    // Pallet 1 takes the late box into its own document; the one taken apart and the open one have none.
    expect(plan?.pallets.map((pallet) => [pallet.palletId, pallet.warnings])).toEqual([
      [PALLET_1, [{ kind: "late_boxes", boxes: 1 }]],
      [PALLET_3, []],
      [PALLET_2, []],
    ]);
  });

  it("leaves a shift without pallets a plan with five formats and no pallets", async () => {
    const shift = rows();
    shift.shift.palletsEnabled = false;
    const made = deps();
    const plan = await planExport(shift, FORMED_AT, made);
    expect(plan?.checks).toHaveLength(5);
    expect(plan?.pallets).toEqual([]);
    expect(made.pause).toHaveBeenCalledTimes(7);
  });

  it("stops at the first turn its caller no longer wants, and says so", async () => {
    let turns = 0;
    const made = deps(() => {
      turns += 1;
      return turns <= 3;
    });
    expect(await planExport(warned(), FORMED_AT, made)).toBeNull();
    // Three turns were wanted (counts and two formats), the fourth was not.
    expect(made.steps).toEqual([
      { done: 1, total: 12 },
      { done: 2, total: 12 },
      { done: 3, total: 12 },
    ]);
    expect(made.pause).toHaveBeenCalledTimes(4);
  });
});

describe("a failure that is no domain refusal (plan ЧЗ, minors of task 5)", () => {
  const run = {
    formatId: "shift_txt_flat",
    formatVersion: 1,
    maxLines: null,
    palletId: null,
    documentId: DOCUMENT,
    formedAt: FORMED_AT,
  };

  it("keeps the error's kind, never its message, which may hold a code", () => {
    const shift = rows();
    shift.shift.stationClosedAt = null;
    shift.shift.closedAt = "not an instant";
    expect(runExport(shift, run)).toEqual({
      ok: false,
      failure: "GENERATION_FAILED",
      reason: "RangeError",
    });
  });

  it("names the domain's own code when the domain refuses with one the cloud does not record", () => {
    // A document that carries a moment nobody can read: the domain's metadata check refuses it.
    expect(
      runExport(rows(), {
        ...run,
        formatId: "shift_xml_gismt_aggregation",
        formedAt: "no instant",
      }),
    ).toEqual({ ok: false, failure: "GENERATION_FAILED", reason: "INVALID_DOCUMENT_METADATA" });
  });

  it("gives a domain refusal no reason: its code is the whole answer", () => {
    expect(runExport(rows(), { ...run, formatVersion: 9 })).toEqual({
      ok: false,
      failure: "FORMAT_NOT_FOUND",
    });
  });
});

describe("the plan of the rows on screen (plan ЧЗ)", () => {
  it("waits for rows, is made after they arrive, and starts over for others rather than show the first's", async () => {
    const { result, rerender } = renderHook(
      ({ shift }: { shift: ShiftExportRows | undefined }) => useExportPlan(shift),
      { initialProps: { shift: undefined as ShiftExportRows | undefined } },
    );
    expect(result.current).toEqual({ status: "working", done: 0, total: 0 });
    rerender({ shift: rows() });
    expect(result.current).toEqual({ status: "working", done: 0, total: 12 });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    rerender({ shift: warned() });
    // At once, before any turn: the plan of the first rows is not the second's.
    expect(result.current).toEqual({ status: "working", done: 0, total: 12 });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.status === "ready" && result.current.plan.counts.codes).toBe(5);
  });

  it("keeps the kind of a failure of the check, and no more", async () => {
    const broken = rows();
    broken.shift.stationClosedAt = null;
    broken.shift.closedAt = "not an instant";
    const { result } = renderHook(() => useExportPlan(broken));
    await waitFor(() => expect(result.current).toEqual({ status: "failed", reason: "RangeError" }));
  });
});
