import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const requestSchema = Reflect.get(contracts, "transformationGenealogyRequestSchema") as
  { safeParse(value: unknown): { success: boolean } } | undefined;
const resultSchema = Reflect.get(contracts, "transformationGenealogyResultSchema") as
  { safeParse(value: unknown): { success: boolean }; parse(value: unknown): unknown } | undefined;

describe("Transformation genealogy read contract", () => {
  it("exports strict read schemas", () => {
    expect(requestSchema).toBeDefined();
    expect(resultSchema).toBeDefined();
  });

  it("accepts the zero-depth current view and an explicitly empty pinned selection", () => {
    const common = { startLotId: id(1), direction: "upstream", maxDepth: 0, maxNodes: 1 };
    expect(requestSchema?.safeParse({ ...common, mode: "current" }).success).toBe(true);
    expect(
      requestSchema?.safeParse({ ...common, mode: "pinned", pinnedRevisionIds: [] }).success,
    ).toBe(true);
  });

  it("rejects tenant fields, hidden pinned selection, duplicates and out-of-range limits", () => {
    const base = { startLotId: id(1), direction: "downstream", maxDepth: 20, maxNodes: 500 };
    const invalid = [
      { ...base, mode: "current", tenantId: id(2) },
      { ...base, mode: "current", pinnedRevisionIds: [] },
      { ...base, mode: "pinned" },
      { ...base, mode: "pinned", pinnedRevisionIds: [id(2), id(2)] },
      {
        ...base,
        mode: "pinned",
        pinnedRevisionIds: Array.from({ length: 101 }, (_, i) => id(i + 1)),
      },
      { ...base, mode: "current", maxDepth: -1 },
      { ...base, mode: "current", maxDepth: 21 },
      { ...base, mode: "current", maxNodes: 0 },
      { ...base, mode: "current", maxNodes: 501 },
      { ...base, mode: "current", extra: true },
    ];
    for (const value of invalid) expect(requestSchema?.safeParse(value).success).toBe(false);
  });

  const snapshot = {
    snapshotVersion: 1,
    eventId: id(3),
    eventNumber: "TRN-26-0001",
    revision: 1,
    eventDate: "2026-09-26",
    timeZone: "America/Chicago",
    processor: { id: id(4), description: "Processor" },
    reason: "repacking",
    reasonNote: null,
    notes: null,
    inputs: [
      {
        kind: "non_ftl",
        lineNo: 1,
        product: {
          id: id(5),
          description: "Ingredient",
          coverage: {
            coverageStatus: "not_covered",
            coverageRationale: "Reviewed",
            ftlCategory: null,
            ftlSourceUrl: null,
            ftlSourceVersion: null,
            reviewedBy: "reviewer",
            reviewedAt: "2026-09-25T13:14:15.123Z",
          },
        },
        source: { kind: "location", id: id(4), description: "Processor" },
        reference: "Invoice 1",
        quantity: "0.250",
        unitOfMeasure: "lb",
      },
    ],
    outputs: [
      {
        lineNo: 1,
        lotId: id(1),
        product: {
          id: id(6),
          description: "Output",
          coverage: {
            coverageStatus: "covered",
            coverageRationale: "Reviewed",
            ftlCategory: "Fresh-cut fruits",
            ftlSourceUrl: "https://www.fda.gov/food/food-traceability-list",
            ftlSourceVersion: "2026",
            reviewedBy: "reviewer",
            reviewedAt: "2026-09-25T13:14:15.123Z",
          },
        },
        tlc: "OUT",
        source: { kind: "location", id: id(4), description: "Processor" },
        quantity: "1.000",
        unitOfMeasure: "case",
      },
    ],
    documents: [{ id: id(7), type: "bol", number: "1" }],
    finalizedBy: "actor",
    finalizedAt: "2026-09-26T13:00:00.000Z",
  };
  const result = {
    startLotId: id(1),
    direction: "upstream",
    mode: "pinned",
    selectedRevisionIds: [id(3)],
    lots: [{ id: id(1), currentOrigin: false }],
    events: [{ id: id(3), rootId: id(3), revision: 1, status: "void", snapshot }],
    links: [],
    complete: false,
    diagnostics: [{ code: "origin_gap", lotId: id(1) }],
    balance: {
      state: "unknown",
      values: [
        { side: "input", quantity: "0.250", unitOfMeasure: "lb" },
        { side: "output", quantity: "1.000", unitOfMeasure: "case" },
      ],
    },
  };
  it("accepts frozen line quantities once and link provenance without quantity", () => {
    expect(resultSchema?.parse(result)).toEqual(result);
    expect(
      resultSchema?.safeParse({
        ...result,
        links: [{ eventId: id(3), inputLotId: id(8), outputLotId: id(1), quantity: "0.250" }],
      }).success,
    ).toBe(false);
    expect(resultSchema?.safeParse({ ...result, tenantId: id(9) }).success).toBe(false);
    expect(
      resultSchema?.safeParse({
        ...result,
        events: [
          {
            ...result.events[0],
            snapshot: { ...snapshot, inputs: [{ ...snapshot.inputs[0], quantity: -1 }] },
          },
        ],
      }).success,
    ).toBe(false);
    expect(resultSchema?.safeParse({ ...result, complete: true }).success).toBe(false);
    expect(resultSchema?.safeParse({ ...result, diagnostics: [] }).success).toBe(false);
    expect(resultSchema?.safeParse({ ...result, selectedRevisionIds: [] }).success).toBe(false);
  });

  it("represents a selected voided draft with an absent snapshot and no edges", () => {
    const draftVoid = {
      ...result,
      events: [{ ...result.events[0], snapshot: null }],
      lots: [{ id: id(1), currentOrigin: true }],
      balance: { state: "unknown", values: [] },
    };
    expect(resultSchema?.safeParse(draftVoid).success).toBe(true);
    expect(
      resultSchema?.safeParse({
        ...draftVoid,
        events: [{ ...draftVoid.events[0], status: "finalized" }],
      }).success,
    ).toBe(false);
    expect(
      resultSchema?.safeParse({
        ...draftVoid,
        links: [{ eventId: id(3), inputLotId: id(8), outputLotId: id(1) }],
      }).success,
    ).toBe(false);
  });

  it("rejects sourced balance values when no selected event has a frozen snapshot", () => {
    const voidOnly = {
      ...result,
      events: [{ ...result.events[0], snapshot: null }],
      lots: [{ id: id(1), currentOrigin: true }],
      balance: { state: "unknown", values: [] },
    };
    expect(resultSchema?.safeParse(voidOnly).success).toBe(true);
    expect(resultSchema?.safeParse({ ...voidOnly, balance: result.balance }).success).toBe(false);
    expect(
      resultSchema?.safeParse({
        ...voidOnly,
        balance: {
          state: "arithmetic",
          unitOfMeasure: "lb",
          inputQuantity: "1",
          outputQuantity: "1",
          deltaQuantity: "0",
        },
      }).success,
    ).toBe(false);
  });

  it("requires the start lot and accepts an explicitly empty pinned result", () => {
    expect(
      resultSchema?.safeParse({ ...result, lots: [], complete: true, diagnostics: [] }).success,
    ).toBe(false);
    const empty = {
      ...result,
      selectedRevisionIds: [],
      events: [],
      links: [],
      complete: true,
      diagnostics: [],
      balance: { state: "unknown", values: [] },
    };
    expect(resultSchema?.safeParse(empty).success).toBe(true);
  });

  it("rejects links without returned endpoints or matching frozen FTL lines", () => {
    const link = { eventId: id(3), inputLotId: id(8), outputLotId: id(1) };
    const ftlSnapshot = {
      ...snapshot,
      inputs: [
        {
          kind: "ftl_lot",
          lineNo: 1,
          lotId: id(8),
          product: snapshot.outputs[0]!.product,
          tlc: "IN",
          source: snapshot.outputs[0]!.source,
          quantity: "0.250",
          unitOfMeasure: "lb",
        },
      ],
    };
    const linked = {
      ...result,
      lots: [
        { id: id(1), currentOrigin: true },
        { id: id(8), currentOrigin: false },
      ],
      events: [{ ...result.events[0], status: "finalized", snapshot: ftlSnapshot }],
      links: [link],
      complete: true,
      diagnostics: [],
    };
    expect(resultSchema?.safeParse(linked).success).toBe(true);
    expect(resultSchema?.safeParse({ ...linked, lots: linked.lots.slice(0, 1) }).success).toBe(
      false,
    );
    expect(
      resultSchema?.safeParse({ ...linked, links: [{ ...link, eventId: id(9) }] }).success,
    ).toBe(false);
    expect(resultSchema?.safeParse({ ...linked, events: result.events }).success).toBe(false);
    expect(
      resultSchema?.safeParse({
        ...linked,
        lots: [...linked.lots, { id: id(9), currentOrigin: false }],
        links: [{ ...link, outputLotId: id(9) }],
      }).success,
    ).toBe(false);
  });
});
