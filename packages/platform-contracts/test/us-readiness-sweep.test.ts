import { describe, expect, it } from "vitest";
import {
  usReadinessFindingSchema,
  usReadinessQuerySchema,
  usReadinessResultSchema,
  usReadinessScopeSchema,
} from "../src/index.js";

const lotId = "11111111-1111-4111-8111-111111111111";
const productId = "22222222-2222-4222-8222-222222222222";
const eventId = "33333333-3333-4333-8333-333333333333";
const rootId = "44444444-4444-4444-8444-444444444444";

const scope = {
  eventDateFrom: "2024-10-01",
  eventDateTo: "2026-09-28",
  productId: null,
  lotId: null,
  profileCode: "US_FSMA204_PROCESSOR",
  defaulted: true,
} as const;
const finding = {
  key: `origin_gap:${lotId}`,
  ruleVersion: "us-readiness-v1",
  code: "origin_gap",
  severity: "error",
  cte: null,
  field: "currentOrigin",
  message: { key: "readiness.origin_gap", params: {} },
  lotId,
  productId,
  eventId: null,
  rootId: null,
  eventNumber: null,
  revision: null,
  eventDate: null,
  lineSide: null,
  lineNo: null,
  relatedEventId: eventId,
  relatedEvent: { type: "transformation", eventNumber: "TRN-26-0001", revision: 2 },
  links: {
    lotHref: `/traceability/lots/${lotId}`,
    eventHref: null,
    relatedEventHref: `/traceability/transformation/${eventId}`,
  },
} as const;
const eventWideFinding = {
  ...finding,
  key: `required_reference:${eventId}:documents`,
  code: "required_reference",
  cte: "receiving",
  field: "documents",
  message: { key: "readiness.required_reference", params: {} },
  lotId: null,
  productId: null,
  eventId,
  rootId,
  eventNumber: "REC-1",
  revision: 1,
  eventDate: "2026-09-28",
  relatedEventId: null,
  relatedEvent: null,
  links: {
    lotHref: null,
    eventHref: `/traceability/receiving/${eventId}`,
    relatedEventHref: null,
  },
} as const;
const result = {
  scope,
  assessedAt: "2026-09-28T12:00:00.000Z",
  state: "assessed",
  recordsChecked: { events: 0, lots: 1 },
  dependenciesChecked: 0,
  counts: { error: 1, warning: 0, info: 0 },
  groups: {
    byCte: [{ cte: null, count: 1 }],
    byProduct: [{ productId, count: 1 }],
    bySeverity: [{ severity: "error", count: 1 }],
  },
  findings: [finding],
  draftWork: { total: 0, items: [], hasMore: false, eventsHref: "/traceability/events" },
} as const;

describe("US readiness sweep contract", () => {
  it("accepts only paired civil dates and tenant-scoped UUID filter syntax", () => {
    expect(usReadinessQuerySchema.parse({})).toEqual({});
    expect(
      usReadinessQuerySchema.parse({
        eventDateFrom: "2024-02-29",
        eventDateTo: "2024-02-29",
        productId,
        lotId,
      }),
    ).toEqual({ eventDateFrom: "2024-02-29", eventDateTo: "2024-02-29", productId, lotId });
    for (const query of [
      { eventDateFrom: "2026-01-01" },
      { eventDateTo: "2026-01-01" },
      { eventDateFrom: "2026-02-29", eventDateTo: "2026-03-01" },
      { eventDateFrom: "2026-10-01", eventDateTo: "2026-09-30" },
      { productId: "not-a-uuid" },
      { lotId: "not-a-uuid" },
      { tenantId: lotId },
    ])
      expect(usReadinessQuerySchema.safeParse(query).success).toBe(false);
  });

  it("accepts source-linked origin gaps and rejects verdict, score, and warning demotion", () => {
    expect(usReadinessScopeSchema.parse(scope)).toEqual(scope);
    expect(usReadinessResultSchema.parse(result)).toEqual(result);
    expect(usReadinessResultSchema.safeParse({ ...result, score: 100 }).success).toBe(false);
    expect(
      usReadinessResultSchema.safeParse({ ...result, legalVerdict: "compliant" }).success,
    ).toBe(false);
    expect(
      usReadinessResultSchema.safeParse({
        ...result,
        findings: [{ ...finding, severity: "warning" }],
      }).success,
    ).toBe(false);
  });

  it("requires exact typed revision provenance whenever a related origin is linked", () => {
    expect(usReadinessFindingSchema.parse(finding).relatedEvent).toEqual({
      type: "transformation",
      eventNumber: "TRN-26-0001",
      revision: 2,
    });
    for (const relatedEvent of [
      null,
      { type: "transformation", eventNumber: "", revision: 2 },
      { type: "transformation", eventNumber: "TRN-26-0001", revision: 0 },
    ])
      expect(usReadinessFindingSchema.safeParse({ ...finding, relatedEvent }).success).toBe(false);
    expect(
      usReadinessFindingSchema.safeParse({
        ...eventWideFinding,
        relatedEvent: finding.relatedEvent,
      }).success,
    ).toBe(false);
  });

  it("accepts event-wide and non-FTL line gaps without inventing a lot or line UUID", () => {
    expect(usReadinessFindingSchema.parse(eventWideFinding)).toEqual(eventWideFinding);
    const nonFtlLine = {
      ...eventWideFinding,
      key: `required_reference:${eventId}:inputs:1`,
      cte: "transformation",
      field: "lines.inputs[1].reference",
      productId,
      lineSide: "inputs",
      lineNo: 1,
      links: { ...eventWideFinding.links, eventHref: `/traceability/transformation/${eventId}` },
    };
    expect(usReadinessFindingSchema.parse(nonFtlLine)).toEqual(nonFtlLine);
    expect(usReadinessFindingSchema.parse(finding)).toEqual(finding);
  });

  it("rejects mismatched lot/link and event/line provenance or obsolete public lineId", () => {
    expect(usReadinessFindingSchema.parse(eventWideFinding)).toEqual(eventWideFinding);
    for (const invalid of [
      {
        ...eventWideFinding,
        links: { ...eventWideFinding.links, lotHref: `/traceability/lots/${lotId}` },
      },
      { ...eventWideFinding, lotId },
      {
        ...eventWideFinding,
        eventId: null,
        rootId: null,
        eventNumber: null,
        revision: null,
        eventDate: null,
        cte: null,
        links: { ...eventWideFinding.links, eventHref: null },
      },
      { ...eventWideFinding, lineSide: "inputs" },
      { ...eventWideFinding, lineNo: 1 },
      { ...eventWideFinding, links: { ...eventWideFinding.links, eventHref: null } },
      {
        ...eventWideFinding,
        lineSide: "inputs",
        lineNo: 1,
        links: { ...eventWideFinding.links, eventHref: null },
      },
      { ...eventWideFinding, lineId: "transformation-line-1" },
    ])
      expect(usReadinessFindingSchema.safeParse(invalid).success).toBe(false);
  });

  it("distinguishes no checked records from an assessed scope with zero findings", () => {
    const zero = {
      ...result,
      counts: { error: 0, warning: 0, info: 0 },
      groups: { byCte: [], byProduct: [], bySeverity: [] },
      findings: [],
    };
    expect(
      usReadinessResultSchema.safeParse({
        ...zero,
        state: "empty",
        recordsChecked: { events: 0, lots: 0 },
      }).success,
    ).toBe(true);
    expect(usReadinessResultSchema.safeParse({ ...zero, state: "assessed" }).success).toBe(true);
    expect(
      usReadinessResultSchema.safeParse({
        ...zero,
        state: "empty",
        recordsChecked: { events: 1, lots: 0 },
      }).success,
    ).toBe(false);
    expect(
      usReadinessResultSchema.safeParse({
        ...zero,
        state: "assessed",
        recordsChecked: { events: 0, lots: 0 },
      }).success,
    ).toBe(false);
  });

  it("caps successful results and draft previews without truncating findings", () => {
    expect(
      usReadinessResultSchema.safeParse({
        ...result,
        recordsChecked: { events: 10001, lots: 1 },
      }).success,
    ).toBe(false);
    const errorFindings = Array.from({ length: 10000 }, (_, index) => {
      const distinctLotId = `11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`;
      return {
        ...finding,
        key: `origin_gap:${distinctLotId}`,
        lotId: distinctLotId,
        links: { ...finding.links, lotHref: `/traceability/lots/${distinctLotId}` },
      };
    });
    const warningFinding = {
      ...finding,
      key: `data_quality:${eventId}:items:1`,
      code: "data_quality",
      severity: "warning",
      cte: "receiving",
      field: "line.source",
      message: { key: "readiness.data_quality", params: {} },
      productId: null,
      eventId,
      rootId,
      eventNumber: "R-1",
      revision: 1,
      eventDate: "2026-09-28",
      lineSide: "items",
      lineNo: 1,
      links: { ...finding.links, eventHref: `/traceability/receiving/${eventId}` },
    };
    const overFindingLimit = usReadinessResultSchema.safeParse({
      ...result,
      recordsChecked: { events: 1, lots: 10000 },
      counts: { error: 10000, warning: 1, info: 0 },
      groups: {
        byCte: [
          { cte: null, count: 10000 },
          { cte: "receiving", count: 1 },
        ],
        byProduct: [
          { productId, count: 10000 },
          { productId: null, count: 1 },
        ],
        bySeverity: [
          { severity: "error", count: 10000 },
          { severity: "warning", count: 1 },
        ],
      },
      findings: [...errorFindings, warningFinding],
    });
    expect(overFindingLimit.success).toBe(false);
    if (!overFindingLimit.success)
      expect(overFindingLimit.error.issues.map((issue) => issue.path.join("."))).toEqual([
        "findings",
      ]);

    const draftItems = Array.from({ length: 101 }, (_, index) => {
      const distinctEventId = `33333333-3333-4333-8333-${String(index + 1).padStart(12, "0")}`;
      return {
        eventId: distinctEventId,
        rootId,
        cte: "receiving",
        eventNumber: `R-${index + 1}`,
        revision: 1,
        eventDate: null,
        eventHref: `/traceability/receiving/${distinctEventId}`,
        readinessHref: `/traceability/receiving/${distinctEventId}/readiness`,
      };
    });
    const overDraftLimit = usReadinessResultSchema.safeParse({
      ...result,
      draftWork: {
        total: 101,
        items: draftItems,
        hasMore: false,
        eventsHref: "/traceability/events",
      },
    });
    expect(overDraftLimit.success).toBe(false);
    if (!overDraftLimit.success)
      expect(overDraftLimit.error.issues.map((issue) => issue.path.join("."))).toEqual([
        "draftWork.items",
      ]);
  });

  it("requires exact provenance and a continuation link for bounded draft work", () => {
    expect(
      usReadinessResultSchema.safeParse({ ...result, findings: [{ ...finding, key: "" }] }).success,
    ).toBe(false);
    expect(
      usReadinessResultSchema.safeParse({
        ...result,
        findings: [
          {
            ...finding,
            eventId,
            rootId,
            revision: 1,
            lineSide: "items",
            lineNo: 1,
            links: { ...finding.links, eventHref: null },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      usReadinessResultSchema.safeParse({
        ...result,
        draftWork: { total: 2, items: [], hasMore: true, eventsHref: "" },
      }).success,
    ).toBe(false);
  });

  it("keeps severity counts, groups, and finding order tied to one finding set", () => {
    const warning = {
      ...finding,
      key: `data_quality:${lotId}`,
      code: "data_quality",
      severity: "warning",
    };
    const twoFindings = {
      ...result,
      counts: { error: 1, warning: 1, info: 0 },
      groups: {
        byCte: [{ cte: null, count: 2 }],
        byProduct: [{ productId, count: 2 }],
        bySeverity: [
          { severity: "error", count: 1 },
          { severity: "warning", count: 1 },
        ],
      },
      findings: [finding, warning],
    };
    expect(usReadinessResultSchema.safeParse(twoFindings).success).toBe(true);
    expect(
      usReadinessResultSchema.safeParse({ ...twoFindings, findings: [warning, finding] }).success,
    ).toBe(false);
    expect(
      usReadinessResultSchema.safeParse({
        ...twoFindings,
        counts: { error: 0, warning: 2, info: 0 },
      }).success,
    ).toBe(false);
    expect(
      usReadinessResultSchema.safeParse({
        ...twoFindings,
        groups: { ...twoFindings.groups, byProduct: [{ productId, count: 1 }] },
      }).success,
    ).toBe(false);
  });
});
