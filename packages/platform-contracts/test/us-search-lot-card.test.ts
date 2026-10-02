import { describe, expect, it } from "vitest";
import {
  caseUnlinkCommandSchema,
  usLotCardEvidenceCursorSchema,
  usLotCardEvidencePageSchema,
  usLotCardEvidenceQuerySchema,
  usLotCardSchema,
  usTraceSearchCursorSchema,
  usTraceSearchPageSchema,
  usTraceSearchQuerySchema,
  usTraceSearchSsccLinkSchema,
} from "../src/index.js";

const lotId = "11111111-1111-4111-8111-111111111111";
const productId = "22222222-2222-4222-8222-222222222222";
const locationId = "33333333-3333-4333-8333-333333333333";
const eventId = "44444444-4444-4444-8444-444444444444";
const linkId = "55555555-5555-4555-8555-555555555555";
const boxId = "66666666-6666-4666-8666-666666666666";
const sscc = "000000000000000000";
const frozenOrigin = {
  kind: "receiving",
  productId,
  description: {
    snapshotVersion: 1,
    sourceProductId: productId,
    productName: "Frozen apples",
    brandName: null,
    commodity: null,
    variety: null,
    packagingSize: null,
    packagingStyle: null,
    gtin: null,
  },
};

describe("US search and lot card contracts", () => {
  it("preserves a saved multiline case unlink reason in historical search evidence", () => {
    const reason = "Damaged case\nRepacked on another pallet";
    const command = caseUnlinkCommandSchema.parse({ operationKey: linkId, reason });
    const link = {
      linkId,
      boxId,
      ssccAtLink: sscc,
      state: "historical",
      provenance: "synthetic_demo",
      linkedAt: "2026-09-27T10:00:00.000Z",
      unlinkedAt: "2026-09-27T11:00:00.000Z",
      unlinkReason: command.reason,
    };
    expect(usTraceSearchSsccLinkSchema.parse(link).unlinkReason).toBe(reason);
    expect(
      usTraceSearchSsccLinkSchema.safeParse({ ...link, unlinkReason: ` ${reason}` }).success,
    ).toBe(false);
    expect(
      usTraceSearchSsccLinkSchema.safeParse({ ...link, unlinkReason: "x".repeat(2001) }).success,
    ).toBe(false);
    expect(usTraceSearchSsccLinkSchema.safeParse({ ...link, extra: true }).success).toBe(false);
  });

  it("defaults and caps search and evidence pages using only canonical HTTP strings", () => {
    expect(usTraceSearchQuerySchema.parse({})).toMatchObject({ limit: 50, tlcList: null });
    expect(usTraceSearchQuerySchema.parse({ limit: "100" }).limit).toBe(100);
    expect(usLotCardEvidenceQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(usLotCardEvidenceQuerySchema.parse({ limit: "50" })).toEqual({ limit: 50 });
    for (const value of ["101", "0", "01", "1.0", "", 1, ["1", "2"]])
      expect(usTraceSearchQuerySchema.safeParse({ limit: value }).success).toBe(false);
    for (const value of ["51", "0", "01", 20, ["20", "30"]])
      expect(usLotCardEvidenceQuerySchema.safeParse({ limit: value }).success).toBe(false);
    expect(usTraceSearchQuerySchema.safeParse({ tenantId: lotId }).success).toBe(false);
    expect(usLotCardEvidenceQuerySchema.safeParse({ actorUserId: lotId }).success).toBe(false);
  });

  it("treats TLC values as opaque case-sensitive strings, including commas", () => {
    expect(usTraceSearchQuerySchema.parse({ tlcList: '["A,B","007"]' }).tlcList).toEqual([
      "A,B",
      "007",
    ]);
    expect(usTraceSearchQuerySchema.parse({ tlc: "MiX-007" }).tlc).toBe("MiX-007");
    for (const list of [
      "A,B",
      "[]",
      '["A","A"]',
      '["A",""]',
      JSON.stringify(Array.from({ length: 51 }, (_, index) => `TLC-${index}`)),
      "x".repeat(8193),
      JSON.stringify(
        Array.from(
          { length: 20 },
          (_, index) => `${String(index).padStart(2, "0")}${"😀".repeat(118)}`,
        ),
      ),
    ])
      expect(usTraceSearchQuerySchema.safeParse({ tlcList: list }).success).toBe(false);
    expect(usTraceSearchQuerySchema.safeParse({ tlcFrom: "Z", tlcTo: "A" }).success).toBe(false);
    expect(usTraceSearchQuerySchema.safeParse({ tlcFrom: "a", tlcTo: "A" }).success).toBe(false);
    expect(usTraceSearchQuerySchema.safeParse({ tlcFrom: "A", tlcTo: "a" }).success).toBe(true);
    expect(usTraceSearchQuerySchema.safeParse({ tlcFrom: "😀", tlcTo: "\uE000" }).success).toBe(
      false,
    );
  });

  it("requires valid dates, identities, and SSCC before a store can read", () => {
    for (const query of [
      { eventDateFrom: "2026-02-30" },
      { eventDateFrom: "2026-09-28", eventDateTo: "2026-09-27" },
      { lotId: "not-a-uuid" },
      { productId: "not-a-uuid" },
      { sourceLocationId: "not-a-uuid" },
      { locationId: "not-a-uuid" },
      { sscc: "123456789012345678" },
    ])
      expect(usTraceSearchQuerySchema.safeParse(query).success).toBe(false);
    expect(usTraceSearchQuerySchema.parse({ sscc }).sscc).toBe(sscc);
    expect(
      usTraceSearchCursorSchema.parse({ createdAt: "2026-09-27T10:00:00.000Z", lotId }),
    ).toEqual({
      createdAt: "2026-09-27T10:00:00.000Z",
      lotId,
    });
    expect(usTraceSearchCursorSchema.safeParse({ createdAt: "2026-09-27", lotId }).success).toBe(
      false,
    );
    expect(
      usTraceSearchCursorSchema.safeParse({
        createdAt: "2026-09-27T10:00:00.000Z",
        lotId,
        tenantId: lotId,
      }).success,
    ).toBe(false);
    expect(usLotCardEvidenceCursorSchema.parse({ eventDate: "2026-09-27", eventId })).toEqual({
      eventDate: "2026-09-27",
      eventId,
    });
  });

  it("retains source-qualified rows and refuses historical SSCC evidence as current", () => {
    const historical = {
      linkId,
      boxId,
      ssccAtLink: sscc,
      state: "historical",
      provenance: "synthetic_demo",
      linkedAt: "2026-09-27T10:00:00.000Z",
      unlinkedAt: "2026-09-27T11:00:00.000Z",
      unlinkReason: "Correction",
    };
    const hit = {
      lotId,
      tlc: "007",
      productId,
      source: { kind: "location", locationId },
      status: "active",
      matchedBy: ["tlc", "sscc_historical"],
      currentCteCount: 0,
      firstEventDate: null,
      lastEventDate: null,
      ssccLinks: [historical],
      moreCaseHistory: false,
    };
    const page = {
      items: [hit],
      nextCursor: null,
      appliedFilters: { limit: 50, tlcList: null },
      rangeOrder: "lexical_c",
    };
    expect(usTraceSearchPageSchema.parse(page).items[0]?.source).toEqual({
      kind: "location",
      locationId,
    });
    // DB link time and application unlink time may come from different clocks.
    // Preserve the recorded instants; historical truth comes from unlink evidence.
    const clockSkewed = { ...historical, unlinkedAt: "2026-09-27T09:59:59.900Z" };
    expect(
      usTraceSearchPageSchema.parse({ ...page, items: [{ ...hit, ssccLinks: [clockSkewed] }] })
        .items[0]?.ssccLinks[0],
    ).toEqual(clockSkewed);
    expect(
      usTraceSearchPageSchema.safeParse({ ...page, items: [{ ...hit, matchedBy: ["tlc", "tlc"] }] })
        .success,
    ).toBe(false);
    expect(
      usTraceSearchPageSchema.safeParse({
        ...page,
        items: [{ ...hit, matchedBy: ["sscc_current"] }],
      }).success,
    ).toBe(false);
    expect(
      usTraceSearchPageSchema.safeParse({
        ...page,
        appliedFilters: { limit: 50, tlcList: null, sscc },
        items: [
          {
            ...hit,
            matchedBy: ["sscc_historical"],
            ssccLinks: [{ ...historical, ssccAtLink: "000000000000000017" }],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      usTraceSearchPageSchema.safeParse({
        ...page,
        items: [{ ...hit, ssccLinks: [{ ...historical, state: "current" }] }],
      }).success,
    ).toBe(false);
    expect(
      usTraceSearchPageSchema.safeParse({ ...page, items: Array(101).fill(hit) }).success,
    ).toBe(false);
    expect(
      usTraceSearchPageSchema.safeParse({
        ...page,
        items: [{ ...hit, ssccLinks: Array(21).fill(historical) }],
      }).success,
    ).toBe(false);
  });

  it("keeps card origin, balance and frozen evidence explicit and bounded", () => {
    const card = {
      lot: {
        id: lotId,
        tlc: "007",
        productId,
        source: { kind: "location", locationId },
        status: "active",
      },
      currentMasterProduct: { id: productId, name: "Current name" },
      currentOriginProducts: [],
      currentOriginProductCount: 0,
      moreCurrentOriginProducts: false,
      originState: "gap",
      caseSummary: { activeCount: 1, historicalCount: 2 },
      balance: { state: "unknown", reason: "no_current_origin" },
      currentCteCount: 0,
      firstEventDate: null,
      lastEventDate: null,
      links: { cases: "cases", trace: "trace", history: "trace/history" },
    };
    expect(usLotCardSchema.parse(card).originState).toBe("gap");
    const row = {
      eventId,
      rootId: eventId,
      type: "receiving",
      eventNumber: "REC-007",
      revision: 1,
      eventDate: "2026-09-27",
      timeZone: "America/New_York",
      lines: [
        {
          kind: "receiving",
          lineNo: 1,
          quantity: "1.000",
          unitOfMeasure: "case",
          originProduct: frozenOrigin,
        },
      ],
      documents: [{ documentId: linkId, type: "bol", number: "BOL-1" }],
    };
    expect(
      usLotCardEvidencePageSchema.parse({ items: [row], nextCursor: null }).items,
    ).toHaveLength(1);
    expect(
      usLotCardEvidencePageSchema.safeParse({
        items: [{ ...row, lines: [{ ...row.lines[0], originProduct: null }] }],
        nextCursor: null,
      }).success,
    ).toBe(false);
    expect(
      usLotCardEvidencePageSchema.safeParse({ items: Array(51).fill(row), nextCursor: null })
        .success,
    ).toBe(false);
  });

  it("accepts an exact frozen custom document type for search and evidence", () => {
    expect(usTraceSearchQuerySchema.parse({ documentType: "Quality release" }).documentType).toBe(
      "Quality release",
    );
    const event = {
      eventId,
      rootId: eventId,
      type: "shipping",
      eventNumber: "SHP-007",
      revision: 1,
      eventDate: "2026-09-27",
      timeZone: "America/New_York",
      lines: [
        { kind: "shipping", lineNo: 1, quantity: "1", unitOfMeasure: "case", originProduct: null },
      ],
      documents: [{ documentId: linkId, type: "Quality release", number: "QR-007" }],
    };
    expect(
      usLotCardEvidencePageSchema.parse({ items: [event], nextCursor: null }).items[0]?.documents[0]
        ?.type,
    ).toBe("Quality release");
  });

  it("rejects zero finalized event-line quantity", () => {
    const event = {
      eventId,
      rootId: eventId,
      type: "receiving",
      eventNumber: "REC-007",
      revision: 1,
      eventDate: "2026-09-27",
      timeZone: "America/New_York",
      lines: [
        {
          kind: "receiving",
          lineNo: 1,
          quantity: "0",
          unitOfMeasure: "case",
          originProduct: frozenOrigin,
        },
      ],
      documents: [],
    };
    expect(
      usLotCardEvidencePageSchema.safeParse({ items: [event], nextCursor: null }).success,
    ).toBe(false);
    expect(
      usLotCardEvidencePageSchema.safeParse({
        items: [{ ...event, lines: [{ ...event.lines[0], quantity: "0.001" }] }],
        nextCursor: null,
      }).success,
    ).toBe(true);
  });

  it("keeps signed current balance when use exceeds supply", () => {
    const card = {
      lot: {
        id: lotId,
        tlc: "007",
        productId,
        source: { kind: "location", locationId },
        status: "active",
      },
      currentMasterProduct: { id: productId, name: "Current name" },
      currentOriginProducts: [
        {
          kind: "receiving",
          productId,
          description: {
            snapshotVersion: 1,
            sourceProductId: productId,
            productName: "Saved description",
            brandName: "Frozen brand",
            commodity: "Apples",
            variety: "Gala",
            packagingSize: { value: "10", uom: "lb" },
            packagingStyle: "Box",
            gtin: null,
          },
          eventId,
          rootId: eventId,
          revision: 1,
          eventDate: "2026-09-27",
          lineNo: 1,
        },
      ],
      currentOriginProductCount: 1,
      moreCurrentOriginProducts: false,
      originState: "current",
      caseSummary: { activeCount: 0, historicalCount: 0 },
      balance: { state: "known", unitOfMeasure: "case", supply: "1", used: "2", remaining: "-1" },
      currentCteCount: 1,
      firstEventDate: "2026-09-27",
      lastEventDate: "2026-09-27",
      links: { cases: "cases", trace: "trace", history: "trace/history" },
    };
    expect(usLotCardSchema.parse(card).balance).toEqual(card.balance);
    expect(usLotCardSchema.parse(card).currentOriginProducts).toEqual(card.currentOriginProducts);
    const alphaProduct = "abcdefab-abcd-4abc-8abc-abcdefabcdef";
    const savedSourceProduct = alphaProduct.toUpperCase();
    const preserved = usLotCardSchema.parse({
      ...card,
      lot: { ...card.lot, productId: alphaProduct },
      currentMasterProduct: { id: alphaProduct, name: "Current" },
      currentOriginProducts: [
        {
          ...card.currentOriginProducts[0],
          productId: alphaProduct,
          description: {
            ...card.currentOriginProducts[0]?.description,
            sourceProductId: savedSourceProduct,
          },
        },
      ],
    });
    expect(preserved.currentOriginProducts[0]?.description).toMatchObject({
      sourceProductId: savedSourceProduct,
    });
    expect(
      usLotCardSchema.safeParse({
        ...card,
        currentOriginProducts: [
          { ...card.currentOriginProducts[0], description: "Collapsed name" },
        ],
      }).success,
    ).toBe(false);
    expect(usLotCardSchema.safeParse({ ...card, currentOriginProductCount: 2 }).success).toBe(
      false,
    );
    const multiline = usLotCardSchema.parse({
      ...card,
      currentMasterProduct: { id: productId, name: "Current\nname" },
      currentOriginProducts: [
        {
          ...card.currentOriginProducts[0],
          kind: "transformation",
          description: "Saved\nbrand, Gala",
        },
      ],
    });
    expect(multiline.currentOriginProducts[0]?.description).toBe("Saved\nbrand, Gala");
    expect(multiline.currentMasterProduct?.name).toBe("Current\nname");
    expect(
      usLotCardSchema.safeParse({
        ...card,
        balance: { ...card.balance, used: "0", remaining: "1" },
      }).success,
    ).toBe(true);
  });
});
