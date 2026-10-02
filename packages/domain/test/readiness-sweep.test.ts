import { describe, expect, it } from "vitest";
import {
  assessFrozenReadiness,
  DomainError,
  type ReadinessEventFact,
  type ReadinessLineFact,
  type ReadinessLotFact,
  type ReadinessRuleInput,
} from "../src/index.js";

const reviewedCoverage = {
  coverageStatus: "covered",
  coverageRationale: "Reviewed FTL",
  ftlCategory: "food",
  ftlSourceUrl: "https://www.fda.gov/food/food-traceability-list",
  ftlSourceVersion: "2026",
  reviewedBy: "qa",
  reviewedAt: "2026-09-25T12:00:00Z",
} as const;
const source = { kind: "location", locationId: "source-location" } as const;
const line: Extract<ReadinessLineFact, { kind: "lot" }> = {
  kind: "lot",
  id: "line-1",
  lineNo: 1,
  side: "items",
  lotId: "lot-1",
  productId: "product-1",
  productDescription: "Apples, cases",
  tlc: "TLC-1",
  source,
  sourceDescription: "Source facility",
  quantity: "12.500",
  unitOfMeasure: "case",
  coverage: reviewedCoverage,
  exemptionReview: "not_applicable",
};
const lot: ReadinessLotFact = {
  id: "lot-1",
  productId: "product-1",
  tlc: "TLC-1",
  source,
  currentOrigin: true,
  relatedEventId: "receiving-1",
};
const receiving: ReadinessEventFact = {
  id: "receiving-1",
  rootId: "receiving-root-1",
  eventNumber: "REC-1",
  type: "receiving",
  revision: 1,
  eventDate: "2026-09-27",
  frozenEventDate: "2026-09-27",
  header: {
    receivingLocation: "Receiving site",
    previousSourceLocation: "Supplier site",
    processorLocation: null,
    shipFromLocation: null,
    recipientLocation: null,
  },
  documents: [{ kind: "invoice", value: "INV-1" }],
  lines: [line],
};
const processor = (events: readonly ReadinessEventFact[], lots: readonly ReadinessLotFact[]) => ({
  profileCode: "US_FSMA204_PROCESSOR" as const,
  events,
  lots,
  dependencies: [],
});

describe("frozen readiness rules", () => {
  it("stops during emission at the 10001st distinct finding before visiting remaining facts", () => {
    let visited = 0;
    const lots: ReadinessLotFact[] = Array.from({ length: 10002 }, (_, index) => ({
      ...lot,
      id: `orphan-${index}`,
      get currentOrigin() {
        visited++;
        if (index === 10001) throw new Error("Evaluator traversed beyond its finding budget");
        return false;
      },
    }));
    expect(() => assessFrozenReadiness(processor([], lots), { maxFindings: 10000 })).toThrowError(
      expect.objectContaining({ code: "readiness_finding_limit_exceeded" }),
    );
    expect(visited).toBe(10001);
  });

  it("returns exactly 10000 distinct findings at budget and preserves unlimited callers", () => {
    const lots = Array.from({ length: 10001 }, (_, index) => ({
      ...lot,
      id: `orphan-${index}`,
      currentOrigin: false,
    }));
    expect(
      assessFrozenReadiness(processor([], lots.slice(0, 10000)), { maxFindings: 10000 }),
    ).toHaveLength(10000);
    expect(assessFrozenReadiness(processor([], lots))).toHaveLength(10001);
  });

  it("does not charge duplicate keys or provenance replacements against the finding budget", () => {
    const facts = processor(
      [],
      [
        { ...lot, currentOrigin: false, relatedEventId: null },
        { ...lot, currentOrigin: false, relatedEventId: "void-revision" },
        { ...lot, currentOrigin: false, relatedEventId: null },
      ],
    );
    expect(assessFrozenReadiness(facts, { maxFindings: 1 })).toEqual([
      expect.objectContaining({ code: "origin_gap", relatedEventId: "void-revision" }),
    ]);
    expect(assessFrozenReadiness(processor([], []), { maxFindings: 0 })).toEqual([]);
    expect(() => assessFrozenReadiness(facts, { maxFindings: 0 })).toThrowError(
      expect.objectContaining({ code: "readiness_finding_limit_exceeded" }),
    );
  });

  it("preserves the exact excluded origin revision on a retained lot gap", () => {
    const findings = assessFrozenReadiness(
      processor(
        [],
        [
          {
            ...lot,
            currentOrigin: false,
            relatedEventId: "void-revision",
            relatedEvent: { type: "transformation", eventNumber: "TRN-26-0007", revision: 3 },
          },
        ],
      ),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        code: "origin_gap",
        relatedEventId: "void-revision",
        relatedEvent: { type: "transformation", eventNumber: "TRN-26-0007", revision: 3 },
      }),
    );
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid finding budget %s without an overflow signal",
    (maxFindings) => {
      expect(() => assessFrozenReadiness(processor([], []), { maxFindings })).toThrowError(
        new DomainError(
          "invalid_readiness_finding_limit",
          "Finding limit must be a nonnegative safe integer.",
        ),
      );
    },
  );

  it("requires processor Receiving documents without inventing a header reference", () => {
    const findings = assessFrozenReadiness(processor([{ ...receiving, documents: [] }], [lot]));
    expect(findings).toEqual([
      expect.objectContaining({
        code: "required_reference",
        severity: "error",
        field: "documents",
        eventId: receiving.id,
        lotId: null,
        productId: null,
        lineId: null,
        lineSide: null,
      }),
    ]);
  });

  it("warns on zero generic Receiving documents and keeps event attribution separate", () => {
    const findings = assessFrozenReadiness({
      profileCode: "US_GENERIC_LOT_TRACEABILITY",
      events: [{ ...receiving, documents: [] }],
      lots: [lot],
      dependencies: [],
    });
    expect(findings).toEqual([
      expect.objectContaining({
        code: "required_reference",
        severity: "warning",
        field: "documents",
        lotId: null,
        productId: null,
        lineId: null,
      }),
    ]);
  });

  it("reports individual frozen document fields at their saved position", () => {
    const findings = assessFrozenReadiness(
      processor([{ ...receiving, documents: [{ kind: "invoice", value: "" }] }], [lot]),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        code: "required_reference",
        field: "documents[0].value",
        lineId: null,
      }),
    );
  });

  it("reports a missing frozen CTE date while preserving authoritative event-date provenance", () => {
    const findings = assessFrozenReadiness(
      processor([{ ...receiving, frozenEventDate: null }], [lot]),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        code: "required_kde",
        field: "frozenEventDate",
        eventId: receiving.id,
        eventDate: "2026-09-27",
      }),
    );
  });

  it("assesses generic Receiving without an FTL coverage verdict", () => {
    const findings = assessFrozenReadiness({
      profileCode: "US_GENERIC_LOT_TRACEABILITY",
      events: [{ ...receiving, lines: [{ ...line, coverage: null, exemptionReview: "unknown" }] }],
      lots: [lot],
      dependencies: [],
    });
    expect(findings).toEqual([]);
  });

  it("preserves all four exact 2-to-2 Transformation lines without allocation", () => {
    const input1 = { ...line, id: "in-1", side: "inputs" as const, quantity: "1.125" };
    const input2 = {
      ...line,
      id: "in-2",
      lineNo: 2,
      side: "inputs" as const,
      lotId: "lot-2",
      tlc: "TLC-2",
      quantity: "2.250",
    };
    const output1 = {
      ...line,
      id: "out-1",
      side: "outputs" as const,
      lotId: "lot-3",
      tlc: "TLC-3",
      quantity: "3.375",
    };
    const output2 = {
      ...line,
      id: "out-2",
      lineNo: 2,
      side: "outputs" as const,
      lotId: "lot-4",
      tlc: "TLC-4",
      quantity: "4.500",
    };
    const lots = [
      lot,
      { ...lot, id: "lot-2", tlc: "TLC-2" },
      { ...lot, id: "lot-3", tlc: "TLC-3" },
      { ...lot, id: "lot-4", tlc: "TLC-4" },
    ];
    const event: ReadinessEventFact = {
      ...receiving,
      id: "transformation-1",
      rootId: "transformation-root-1",
      type: "transformation",
      header: { ...receiving.header, processorLocation: "Processor site" },
      lines: [input1, input2, output1, output2],
    };
    const findings = assessFrozenReadiness(processor([event], lots));
    expect(findings).toEqual([]);
    const broken = [input1, input2, output1, output2].map((value) => ({ ...value, quantity: "0" }));
    const lineFindings = assessFrozenReadiness(processor([{ ...event, lines: broken }], lots));
    expect(
      lineFindings
        .filter(({ code }) => code === "invalid_quantity")
        .map(({ lineId, lineNo }) => [lineId, lineNo]),
    ).toEqual([
      ["in-1", 1],
      ["in-2", 2],
      ["out-1", 1],
      ["out-2", 2],
    ]);
  });

  it("anchors invalid Shipping quantity, UOM and source identity to its exact line", () => {
    const shipping: ReadinessEventFact = {
      ...receiving,
      id: "shipping-1",
      rootId: "shipping-root-1",
      type: "shipping",
      header: { ...receiving.header, shipFromLocation: "Warehouse", recipientLocation: "Buyer" },
      lines: [
        {
          ...line,
          quantity: "1.0001",
          unitOfMeasure: "bogus",
          source: { kind: "location", locationId: "wrong" },
        },
      ],
    };
    const findings = assessFrozenReadiness(processor([shipping], [lot]));
    expect(findings.map(({ code, field, lineId }) => [code, field, lineId])).toEqual(
      expect.arrayContaining([
        ["invalid_quantity", "lines.items[1].quantity", "line-1"],
        ["invalid_uom", "lines.items[1].unitOfMeasure", "line-1"],
        ["tlc_source_mismatch", "lines.items[1].source", "line-1"],
      ]),
    );
  });

  it("reports a retained void-output lot with no current origin as an error", () => {
    const findings = assessFrozenReadiness(
      processor([], [{ ...lot, currentOrigin: false, relatedEventId: "void-revision" }]),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        code: "origin_gap",
        severity: "error",
        lotId: lot.id,
        eventId: null,
        relatedEventId: "void-revision",
      }),
    );
  });

  it("checks unconsumed selected lot identity without a current event", () => {
    const findings = assessFrozenReadiness(
      processor([], [{ ...lot, productId: null, tlc: null, source: null }]),
    );
    expect(
      findings.map(({ code, field, eventId, lotId, lineSide }) => [
        code,
        field,
        eventId,
        lotId,
        lineSide,
      ]),
    ).toEqual([
      ["required_kde", "lot.productId", null, lot.id, null],
      ["required_kde", "lot.source", null, lot.id, null],
      ["required_kde", "lot.tlc", null, lot.id, null],
    ]);
  });

  it("checks a non-FTL input without inventing lot or TLC provenance", () => {
    const nonFtl = {
      kind: "non_ftl" as const,
      id: "non-ftl-line",
      lineNo: 1,
      side: "inputs" as const,
      lotId: null,
      productId: "product-2",
      productDescription: null,
      source: { kind: "location" as const, locationId: "supplier" },
      sourceDescription: null,
      reference: null,
      quantity: "0",
      unitOfMeasure: "bogus",
      coverage: null,
      exemptionReview: "not_applicable" as const,
    };
    const transformation = {
      ...receiving,
      id: "transformation-1",
      rootId: "transformation-root-1",
      type: "transformation" as const,
      header: { ...receiving.header, processorLocation: "Processor site" },
      lines: [nonFtl],
    };
    const findings = assessFrozenReadiness({
      profileCode: "US_GENERIC_LOT_TRACEABILITY",
      events: [transformation],
      lots: [],
      dependencies: [],
    });
    expect(
      findings.map(({ code, field, lotId, productId, lineId, lineSide }) => [
        code,
        field,
        lotId,
        productId,
        lineId,
        lineSide,
      ]),
    ).toEqual(
      expect.arrayContaining([
        [
          "required_reference",
          "lines.inputs[1].reference",
          null,
          "product-2",
          "non-ftl-line",
          "inputs",
        ],
        [
          "invalid_quantity",
          "lines.inputs[1].quantity",
          null,
          "product-2",
          "non-ftl-line",
          "inputs",
        ],
        [
          "invalid_uom",
          "lines.inputs[1].unitOfMeasure",
          null,
          "product-2",
          "non-ftl-line",
          "inputs",
        ],
        [
          "required_kde",
          "lines.inputs[1].productDescription",
          null,
          "product-2",
          "non-ftl-line",
          "inputs",
        ],
        [
          "required_kde",
          "lines.inputs[1].sourceDescription",
          null,
          "product-2",
          "non-ftl-line",
          "inputs",
        ],
      ]),
    );
    expect(findings.some(({ field }) => field.endsWith(".tlc") || field.endsWith(".origin"))).toBe(
      false,
    );
  });

  it("reports absent frozen product and source descriptions on a lot line", () => {
    const findings = assessFrozenReadiness(
      processor(
        [{ ...receiving, lines: [{ ...line, productDescription: null, sourceDescription: null }] }],
        [lot],
      ),
    );
    expect(findings.map(({ code, field, lineId }) => [code, field, lineId])).toEqual(
      expect.arrayContaining([
        ["required_kde", "lines.items[1].productDescription", line.id],
        ["required_kde", "lines.items[1].sourceDescription", line.id],
      ]),
    );
    expect(findings.map(({ lineSide, lineNo }) => [lineSide, lineNo])).toEqual([
      ["items", 1],
      ["items", 1],
    ]);
  });

  it("pinpoints missing fields inside detailed frozen descriptions", () => {
    const shipping: ReadinessEventFact = {
      ...receiving,
      id: "shipping-1",
      rootId: "shipping-root-1",
      type: "shipping",
      header: {
        ...receiving.header,
        shipFromLocation: {
          businessName: "Warehouse",
          phoneNumber: null,
          addressKind: "street",
          streetAddress: "1 Main St",
          latitude: null,
          longitude: null,
          city: null,
          stateOrRegion: "CA",
          zipOrPostalCode: "90001",
          countryCode: "US",
        },
        recipientLocation: "Buyer",
      },
      lines: [
        {
          ...line,
          productDescription: {
            productName: "",
            brandName: null,
            commodity: null,
            variety: null,
            packagingSizeValue: null,
            packagingSizeUom: null,
            packagingStyle: null,
            defaultQuantityUom: null,
          },
        },
      ],
    };
    const findings = assessFrozenReadiness(processor([shipping], [lot]));
    expect(findings.map(({ code, field, lineId, lotId }) => [code, field, lineId, lotId])).toEqual(
      expect.arrayContaining([
        ["required_kde", "header.shipFromLocation.phoneNumber", null, null],
        ["required_kde", "header.shipFromLocation.city", null, null],
        ["required_kde", "lines.items[1].productDescription.productName", line.id, lot.id],
      ]),
    );
  });

  it("deduplicates retained-lot and origin-dependency source mismatch on the consuming line", () => {
    const shipping = {
      ...receiving,
      id: "shipping-1",
      rootId: "shipping-root-1",
      type: "shipping" as const,
      header: { ...receiving.header, shipFromLocation: "Warehouse", recipientLocation: "Buyer" },
      lines: [{ ...line, source: { kind: "location" as const, locationId: "wrong" } }],
    };
    const findings = assessFrozenReadiness({
      ...processor([shipping], [lot]),
      dependencies: [
        {
          consumingEventId: shipping.id,
          consumingLineId: line.id,
          lotId: lot.id,
          currentOrigin: true,
          tlc: lot.tlc,
          productId: lot.productId,
          source,
          relatedEventId: "older-origin",
        },
      ],
    });
    expect(findings.filter(({ code }) => code === "tlc_source_mismatch")).toEqual([
      expect.objectContaining({
        field: "lines.items[1].source",
        eventId: shipping.id,
        relatedEventId: "older-origin",
      }),
    ]);
  });

  it.each(["US_FSMA204_PROCESSOR", "US_GENERIC_LOT_TRACEABILITY"] as const)(
    "anchors older-origin TLC and product contradictions on the selected Shipping line for %s",
    (profileCode) => {
      const shipping: ReadinessEventFact = {
        ...receiving,
        id: "shipping-older-origin",
        rootId: "shipping-older-origin-root",
        type: "shipping",
        header: { ...receiving.header, shipFromLocation: "Warehouse", recipientLocation: "Buyer" },
      };
      const olderOriginId = "older-origin";
      const findings = assessFrozenReadiness({
        profileCode,
        events: [shipping],
        lots: [lot],
        dependencies: [
          {
            consumingEventId: shipping.id,
            consumingLineId: line.id,
            lotId: lot.id,
            currentOrigin: true,
            tlc: "OLDER-TLC",
            productId: "older-product",
            source,
            relatedEventId: olderOriginId,
          },
        ],
      });
      expect(
        findings.map(({ code, severity, field, eventId, lineId, relatedEventId }) => [
          code,
          severity,
          field,
          eventId,
          lineId,
          relatedEventId,
        ]),
      ).toEqual([
        [
          "event_lot_mismatch",
          "error",
          "lines.items[1].productId",
          shipping.id,
          line.id,
          olderOriginId,
        ],
        ["tlc_source_mismatch", "error", "lines.items[1].tlc", shipping.id, line.id, olderOriginId],
      ]);
      expect(findings.some(({ eventId }) => eventId === olderOriginId)).toBe(false);
    },
  );

  it("deduplicates retained-lot and older-origin TLC/product contradictions per field", () => {
    const shipping: ReadinessEventFact = {
      ...receiving,
      id: "shipping-conflict",
      rootId: "shipping-conflict-root",
      type: "shipping",
      header: { ...receiving.header, shipFromLocation: "Warehouse", recipientLocation: "Buyer" },
      lines: [{ ...line, tlc: "LINE-TLC", productId: "line-product" }],
    };
    const findings = assessFrozenReadiness({
      ...processor([shipping], [lot]),
      dependencies: [
        {
          consumingEventId: shipping.id,
          consumingLineId: line.id,
          lotId: lot.id,
          currentOrigin: true,
          tlc: "ORIGIN-TLC",
          productId: "origin-product",
          source,
          relatedEventId: "older-origin",
        },
      ],
    });
    expect(
      findings.filter(
        ({ code, field }) => code === "tlc_source_mismatch" && field.endsWith(".tlc"),
      ),
    ).toEqual([
      expect.objectContaining({
        eventId: shipping.id,
        lineId: line.id,
        relatedEventId: "older-origin",
      }),
    ]);
    expect(
      findings.filter(
        ({ code, field }) => code === "event_lot_mismatch" && field.endsWith(".productId"),
      ),
    ).toEqual([
      expect.objectContaining({
        eventId: shipping.id,
        lineId: line.id,
        relatedEventId: "older-origin",
      }),
    ]);
  });

  it("anchors a current output with no current origin to its Transformation line", () => {
    const transformation: ReadinessEventFact = {
      ...receiving,
      id: "transformation-1",
      rootId: "transformation-root-1",
      type: "transformation",
      header: { ...receiving.header, processorLocation: "Processor site" },
      lines: [{ ...line, side: "outputs" }],
    };
    const findings = assessFrozenReadiness(
      processor(
        [transformation],
        [{ ...lot, currentOrigin: false, relatedEventId: "void-revision" }],
      ),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        code: "origin_gap",
        eventId: transformation.id,
        lineId: line.id,
        lineNo: 1,
        severity: "error",
      }),
    );
  });

  it("anchors an older origin dependency gap to the selected Shipping line", () => {
    const shipping: ReadinessEventFact = {
      ...receiving,
      id: "shipping-1",
      rootId: "shipping-root-1",
      type: "shipping",
      header: { ...receiving.header, shipFromLocation: "Warehouse", recipientLocation: "Buyer" },
    };
    const olderOriginId = "older-receiving-1";
    const findings = assessFrozenReadiness({
      ...processor([shipping], [lot]),
      dependencies: [
        {
          consumingEventId: shipping.id,
          consumingLineId: line.id,
          lotId: lot.id,
          currentOrigin: false,
          tlc: null,
          productId: null,
          source,
          relatedEventId: olderOriginId,
        },
      ],
    });
    expect(findings).toContainEqual(
      expect.objectContaining({
        code: "origin_gap",
        severity: "error",
        eventId: shipping.id,
        lineNo: 1,
        relatedEventId: olderOriginId,
      }),
    );
    expect(findings.some((finding) => finding.eventId === olderOriginId)).toBe(false);
  });

  it("reports one line origin gap when retained lot and dependency both show a missing origin", () => {
    const shipping: ReadinessEventFact = {
      ...receiving,
      id: "shipping-1",
      rootId: "shipping-root-1",
      type: "shipping",
      header: { ...receiving.header, shipFromLocation: "Warehouse", recipientLocation: "Buyer" },
    };
    const findings = assessFrozenReadiness({
      ...processor([shipping], [{ ...lot, currentOrigin: false, relatedEventId: "void-revision" }]),
      dependencies: [
        {
          consumingEventId: shipping.id,
          consumingLineId: line.id,
          lotId: lot.id,
          currentOrigin: false,
          tlc: null,
          productId: null,
          source,
          relatedEventId: "older-origin",
        },
      ],
    });
    expect(findings.filter(({ code }) => code === "origin_gap")).toEqual([
      expect.objectContaining({
        eventId: shipping.id,
        lineId: line.id,
        relatedEventId: "older-origin",
      }),
    ]);
  });

  it("blocks pending exemption and unknown frozen coverage only for the processor", () => {
    const uncertain = {
      ...line,
      coverage: { ...reviewedCoverage, coverageStatus: "unknown" as const },
      exemptionReview: "pending" as const,
    };
    const processorFindings = assessFrozenReadiness(
      processor([{ ...receiving, lines: [uncertain] }], [lot]),
    );
    expect(processorFindings.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["coverage_unresolved", "exemption_review_required"]),
    );
    expect(processorFindings.every(({ severity }) => severity === "error")).toBe(true);
    expect(
      assessFrozenReadiness({
        profileCode: "US_GENERIC_LOT_TRACEABILITY",
        events: [{ ...receiving, lines: [uncertain] }],
        lots: [lot],
        dependencies: [],
      }),
    ).toEqual([]);
  });

  it("does not downgrade a current TLC mismatch on revision two", () => {
    const findings = assessFrozenReadiness(
      processor([{ ...receiving, revision: 2, lines: [{ ...line, tlc: "UNRESOLVED" }] }], [lot]),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "tlc_source_mismatch", severity: "error", revision: 2 }),
    );
  });

  it("blocks a retained lot whose current TLC is absent despite a frozen line TLC", () => {
    const findings = assessFrozenReadiness(
      processor([{ ...receiving, revision: 2 }], [{ ...lot, tlc: null }]),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        code: "tlc_source_mismatch",
        severity: "error",
        field: "lines.items[1].tlc",
        lineId: line.id,
        revision: 2,
      }),
    );
  });

  it("produces a stable single finding per rule and source when inputs repeat", () => {
    const event = {
      ...receiving,
      lines: [
        { ...line, quantity: null },
        { ...line, quantity: null },
      ],
    };
    const facts = processor([event, event], [lot, lot]);
    const findings = assessFrozenReadiness(facts);
    expect(
      findings.filter(
        (finding) => finding.code === "required_kde" && finding.field.endsWith("quantity"),
      ),
    ).toHaveLength(1);
    expect(findings.map((finding) => finding.key)).toEqual(
      [...findings.map((finding) => finding.key)].sort((a, b) => a.localeCompare(b, "en")),
    );
    expect(assessFrozenReadiness({ ...facts, events: [...facts.events].reverse() })).toEqual(
      findings,
    );
  });
});

const frozenInput: ReadinessRuleInput = processor([receiving], [lot]);
void frozenInput;
const mutableMasterInput: ReadinessRuleInput = {
  ...frozenInput,
  // @ts-expect-error mutable master state must never enter the frozen rule boundary
  products: [{ id: "product-1", archived: true }],
};
void mutableMasterInput;
