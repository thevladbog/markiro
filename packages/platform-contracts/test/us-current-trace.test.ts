import { describe, expect, it } from "vitest";
import {
  usCurrentTraceQuerySchema,
  usCurrentTraceResultSchema,
  usTraceHistoryCursorSchema,
  usTraceHistoryPageSchema,
  usTraceHistoryQuerySchema,
} from "../src/index.js";

const lotA = "11111111-1111-4111-8111-111111111111";
const lotB = "22222222-2222-4222-8222-222222222222";
const eventId = "33333333-3333-4333-8333-333333333333";
const otherEventId = "55555555-5555-4555-8555-555555555555";
const locationId = "44444444-4444-4444-8444-444444444444";

describe("US current trace contracts", () => {
  it("retains event-qualified location names and rejects unproven node displays", () => {
    const events = [eventId, otherEventId].map((id, index) => ({
      id,
      rootId: id,
      type: index === 0 ? "receiving" : "shipping",
      eventNumber: `EV-${index}`,
      revision: 1,
      eventDate: "2026-09-27",
      timeZone: "America/New_York",
    }));
    const result = {
      rootLotId: lotA,
      direction: "both",
      nodes: [
        { id: `lot:${lotA}`, kind: "lot", lotId: lotA, tlc: "A" },
        {
          id: `location:${locationId}`,
          kind: "location",
          locationId,
          display: "First saved name",
          displayEdgeId: `${eventId}:receiving:1`,
        },
      ],
      edges: events.map((event, index) => ({
        id: `${event.id}:${event.type}:${index + 1}`,
        kind: event.type,
        from: index === 0 ? `location:${locationId}` : `lot:${lotA}`,
        to: index === 0 ? `lot:${lotA}` : `location:${locationId}`,
        eventId: event.id,
        eventNumber: event.eventNumber,
        revision: 1,
        lineNo: index + 1,
        eventDate: event.eventDate,
        timeZone: event.timeZone,
        locationDisplay: index === 0 ? "First saved name" : "Second saved name",
      })),
      currentEvents: events,
      excludedSummary: { count: 0 },
      findings: [],
      completion: { state: "complete", returnedNodes: 2, returnedEdges: 2 },
    };
    const parsed = usCurrentTraceResultSchema.parse(result);
    expect(parsed.edges.map((edge) => [edge.eventId, edge.lineNo, edge.locationDisplay])).toEqual([
      [eventId, 1, "First saved name"],
      [otherEventId, 2, "Second saved name"],
    ]);
    for (const change of [
      { displayEdgeId: `${otherEventId}:shipping:2` },
      { displayEdgeId: `${eventId}:receiving:2` },
      { display: "Mutable master name" },
      { displayEdgeId: undefined },
    ])
      expect(
        usCurrentTraceResultSchema.safeParse({
          ...result,
          nodes: [result.nodes[0], { ...result.nodes[1], ...change }],
        }).success,
      ).toBe(false);
    expect(
      usCurrentTraceResultSchema.safeParse({
        ...result,
        edges: [{ ...result.edges[0], locationDisplay: undefined }, result.edges[1]],
      }).success,
    ).toBe(false);
  });
  it("requires typed origin gaps referring only to visible lots", () => {
    const result = {
      rootLotId: lotA,
      direction: "both",
      nodes: [{ id: `lot:${lotA}`, kind: "lot", lotId: lotA, tlc: "A" }],
      edges: [],
      currentEvents: [],
      excludedSummary: { count: 0 },
      findings: [{ code: "origin_gap", lotId: lotA }],
      completion: { state: "complete", returnedNodes: 1, returnedEdges: 0 },
    };
    expect(usCurrentTraceResultSchema.safeParse(result).success).toBe(true);
    expect(
      usCurrentTraceResultSchema.safeParse({
        ...result,
        findings: [{ code: "origin_gap", lotId: lotB }],
      }).success,
    ).toBe(false);
    expect(
      usCurrentTraceResultSchema.safeParse({
        ...result,
        findings: [{ code: "limit", lotId: lotA }],
      }).success,
    ).toBe(false);
    expect(
      usCurrentTraceResultSchema.safeParse({
        ...result,
        findings: [result.findings[0], result.findings[0]],
      }).success,
    ).toBe(false);
  });
  it("defaults and bounds canonical HTTP query strings", () => {
    expect(usCurrentTraceQuerySchema.parse({})).toEqual({
      direction: "both",
      maxDepth: 16,
      maxNodes: 500,
    });
    expect(
      usCurrentTraceQuerySchema.parse({ direction: "forward", maxDepth: "0", maxNodes: "1" }),
    ).toEqual({
      direction: "forward",
      maxDepth: 0,
      maxNodes: 1,
    });
    for (const value of ["21", "01", "1.0", "-1", "", 1, ["1", "2"]]) {
      expect(usCurrentTraceQuerySchema.safeParse({ maxDepth: value }).success).toBe(false);
    }
    for (const value of ["501", "0", "01", ["1", "2"]]) {
      expect(usCurrentTraceQuerySchema.safeParse({ maxNodes: value }).success).toBe(false);
    }
    expect(usCurrentTraceQuerySchema.safeParse({ tenantId: "other" }).success).toBe(false);
    expect(usCurrentTraceQuerySchema.safeParse({ actorUserId: lotA }).success).toBe(false);
  });

  it("keeps history query bounded and cursor content strict", () => {
    expect(usTraceHistoryQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(usTraceHistoryQuerySchema.parse({ limit: "100", cursor: "abc_-" })).toEqual({
      limit: 100,
      cursor: "abc_-",
    });
    for (const value of ["101", "0", "01", 10, ["10", "20"]]) {
      expect(usTraceHistoryQuerySchema.safeParse({ limit: value }).success).toBe(false);
    }
    expect(usTraceHistoryQuerySchema.safeParse({ tenantId: "other" }).success).toBe(false);
    expect(usTraceHistoryQuerySchema.safeParse({ cursor: "not+base64" }).success).toBe(false);
    expect(
      usTraceHistoryCursorSchema.parse({ createdAt: "2026-09-27T10:00:00.000Z", eventId }),
    ).toEqual({
      createdAt: "2026-09-27T10:00:00.000Z",
      eventId,
    });
    expect(usTraceHistoryCursorSchema.safeParse({ createdAt: "2026-09-27", eventId }).success).toBe(
      false,
    );
    expect(
      usTraceHistoryCursorSchema.safeParse({
        createdAt: "2026-09-27T10:00:00Z",
        eventId,
        tenantId: "other",
      }).success,
    ).toBe(false);
  });

  it("accepts frozen line provenance without inventing lot-to-lot allocation", () => {
    const result = {
      rootLotId: lotA,
      direction: "both",
      nodes: [
        { id: `lot:${lotA}`, kind: "lot", lotId: lotA, tlc: "A" },
        { id: `lot:${lotB}`, kind: "lot", lotId: lotB, tlc: "B" },
        { id: `lot:${locationId}`, kind: "lot", lotId: locationId, tlc: "C" },
        {
          id: `transformation:${eventId}`,
          kind: "transformation",
          eventId,
          display: "Saved product",
        },
      ],
      edges: [
        {
          id: `${eventId}:input:1`,
          kind: "transformation_input",
          from: `lot:${lotA}`,
          to: `transformation:${eventId}`,
          eventId,
          eventNumber: "TR-1",
          revision: 1,
          lineNo: 1,
          eventDate: "2026-09-27",
          timeZone: "America/New_York",
          quantity: "2.000",
          unitOfMeasure: "kg",
        },
        {
          id: `${eventId}:output:1`,
          kind: "transformation_output",
          from: `transformation:${eventId}`,
          to: `lot:${lotB}`,
          eventId,
          eventNumber: "TR-1",
          revision: 1,
          lineNo: 1,
          eventDate: "2026-09-27",
          timeZone: "America/New_York",
          quantity: "1.000",
          unitOfMeasure: "kg",
        },
      ],
      currentEvents: [
        {
          id: eventId,
          rootId: eventId,
          type: "transformation",
          eventNumber: "TR-1",
          revision: 1,
          eventDate: "2026-09-27",
          timeZone: "America/New_York",
        },
      ],
      excludedSummary: { count: 0 },
      findings: [],
      completion: { state: "complete", returnedNodes: 4, returnedEdges: 2 },
    };
    expect(usCurrentTraceResultSchema.safeParse(result).success).toBe(true);
    expect(
      usCurrentTraceResultSchema.safeParse({
        ...result,
        completion: { ...result.completion, limit: "edges" },
      }).success,
    ).toBe(false);
    expect(
      usCurrentTraceResultSchema.safeParse({
        ...result,
        edges: [{ ...result.edges[0], to: `lot:${locationId}` }],
      }).success,
    ).toBe(false);
    expect(
      usCurrentTraceResultSchema.safeParse({
        ...result,
        edges: [
          { ...result.edges[0], kind: "transformation", from: `lot:${lotA}`, to: `lot:${lotB}` },
        ],
      }).success,
    ).toBe(false);
    expect(
      usCurrentTraceResultSchema.safeParse({
        ...result,
        nodes: [{ ...result.nodes[0], id: `lot:${lotB}` }, ...result.nodes.slice(1)],
      }).success,
    ).toBe(false);
    expect(
      usCurrentTraceResultSchema.safeParse({
        ...result,
        edges: [{ ...result.edges[0], eventId: locationId }, result.edges[1]],
      }).success,
    ).toBe(false);
    expect(
      usCurrentTraceResultSchema.safeParse({
        ...result,
        nodes: [
          ...result.nodes,
          {
            id: `transformation:${otherEventId}`,
            kind: "transformation",
            eventId: otherEventId,
            display: "Other saved product",
          },
        ],
        currentEvents: [
          ...result.currentEvents,
          { ...result.currentEvents[0], id: otherEventId, rootId: otherEventId },
        ],
        edges: [{ ...result.edges[0], to: `transformation:${otherEventId}` }, result.edges[1]],
        completion: { state: "complete", returnedNodes: 5, returnedEdges: 2 },
      }).success,
    ).toBe(false);
    expect(
      usCurrentTraceResultSchema.safeParse({
        ...result,
        nodes: [
          ...result.nodes,
          {
            id: `material:${eventId}:2`,
            kind: "material",
            eventId,
            lineNo: 2,
            display: "Saved co-input",
          },
        ],
        edges: [{ ...result.edges[0], from: `material:${eventId}:2` }, result.edges[1]],
        completion: { state: "complete", returnedNodes: 5, returnedEdges: 2 },
      }).success,
    ).toBe(false);
  });

  it("permits more than 500 current events when nodes and edges stay within their caps", () => {
    const events = Array.from({ length: 501 }, (_, index) => {
      const id = `${(index + 1).toString(16).padStart(8, "0")}-3333-4333-8333-333333333333`;
      return {
        id,
        rootId: id,
        type: "receiving",
        eventNumber: `REC-${index + 1}`,
        revision: 1,
        eventDate: "2026-09-27",
        timeZone: "America/New_York",
      };
    });
    const result = {
      rootLotId: lotA,
      direction: "both",
      nodes: [
        { id: `lot:${lotA}`, kind: "lot", lotId: lotA, tlc: "A" },
        {
          id: `location:${locationId}`,
          kind: "location",
          locationId,
          display: "Saved source",
          displayEdgeId: `${events[0]?.id}:receiving:1`,
        },
      ],
      edges: events.map((event) => ({
        id: `${event.id}:receiving:1`,
        kind: "receiving",
        from: `location:${locationId}`,
        to: `lot:${lotA}`,
        eventId: event.id,
        eventNumber: event.eventNumber,
        revision: 1,
        lineNo: 1,
        eventDate: event.eventDate,
        timeZone: event.timeZone,
        quantity: "1",
        unitOfMeasure: "kg",
        locationDisplay: "Saved source",
      })),
      currentEvents: events,
      excludedSummary: { count: 0 },
      findings: [],
      completion: { state: "complete", returnedNodes: 2, returnedEdges: 501 },
    };
    expect(usCurrentTraceResultSchema.safeParse(result).success).toBe(true);
  });

  it("returns exact excluded revision links in a bounded history page", () => {
    const page = {
      items: [
        {
          eventId,
          rootId: eventId,
          type: "transformation",
          eventNumber: "TR-1",
          revision: 2,
          status: "draft",
          reason: "Correction in progress",
          previousRevisionId: lotA,
          nextRevisionId: null,
          eventDate: null,
          createdAt: "2026-09-27T10:00:00.000Z",
        },
      ],
      nextCursor: null,
    };
    expect(usTraceHistoryPageSchema.safeParse(page).success).toBe(true);
    expect(
      usTraceHistoryPageSchema.safeParse({
        ...page,
        items: [{ ...page.items[0], status: "finalized" }],
      }).success,
    ).toBe(false);
    expect(
      usTraceHistoryPageSchema.safeParse({
        ...page,
        items: [{ ...page.items[0], tenantId: "other" }],
      }).success,
    ).toBe(false);
  });
});
