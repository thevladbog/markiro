import {
  usCurrentTraceResultSchema,
  usLotCardEvidencePageSchema,
  usLotCardSchema,
  usTraceHistoryPageSchema,
  usTraceSearchPageSchema,
} from "@markiro/platform-contracts";
import { describe, expect, it, vi } from "vitest";
import { createUsBrowserClient } from "../src/us/client.js";

const lotId = "11111111-1111-4111-8111-111111111111";
const otherLotId = "22222222-2222-4222-8222-222222222222";
const productId = "33333333-3333-4333-8333-333333333333";
const locationId = "44444444-4444-4444-8444-444444444444";
const root = `/api/us/traceability/lots/${lotId}`;
const validSearch = usTraceSearchPageSchema.parse({
  items: [],
  nextCursor: null,
  appliedFilters: { q: "BOL-0916-H", tlcList: null, limit: 50 },
  rangeOrder: "lexical_c",
});
const validCard = usLotCardSchema.parse({
  lot: {
    id: lotId,
    tlc: "007",
    productId,
    source: { kind: "location", locationId },
    status: "active",
  },
  currentMasterProduct: null,
  currentOriginProducts: [],
  currentOriginProductCount: 0,
  moreCurrentOriginProducts: false,
  originState: "gap",
  caseSummary: { activeCount: 0, historicalCount: 0 },
  balance: { state: "unknown", reason: "no_current_origin" },
  currentCteCount: 0,
  firstEventDate: null,
  lastEventDate: null,
  links: { cases: "cases", trace: "trace", history: "trace/history" },
});
const validEvidence = usLotCardEvidencePageSchema.parse({ items: [], nextCursor: null });
const validTrace = usCurrentTraceResultSchema.parse({
  rootLotId: lotId,
  direction: "both",
  nodes: [{ id: `lot:${lotId}`, kind: "lot", lotId, tlc: "007" }],
  edges: [],
  currentEvents: [],
  excludedSummary: { count: 0 },
  findings: [],
  completion: { state: "complete", returnedNodes: 1, returnedEdges: 0 },
});
const validHistory = usTraceHistoryPageSchema.parse({ items: [], nextCursor: null });

function expectRead(send: ReturnType<typeof vi.fn<typeof fetch>>, path: string) {
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0]?.[0]).toBe(path);
  expect(send.mock.calls[0]?.[1]).toMatchObject({
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
  expect(send.mock.calls[0]?.[1]).not.toHaveProperty("body");
}

describe("US search, lot card and trace browser reads", () => {
  it("serializes validated search fields, JSON TLC list, dates and opaque cursor exactly once", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json(validSearch));
    const client = createUsBrowserClient(send);
    await expect(
      client.searchTraceLots({
        q: "BOL-0916-H",
        tlcList: '["A,B","007"]',
        eventDateFrom: "2026-09-01",
        eventDateTo: "2026-09-28",
        cursor: "abc_09-Z",
        limit: "50",
      }),
    ).resolves.toEqual(validSearch);
    expectRead(
      send,
      "/api/us/traceability/search?limit=50&q=BOL-0916-H&eventDateFrom=2026-09-01&eventDateTo=2026-09-28&cursor=abc_09-Z&tlcList=%5B%22A%2CB%22%2C%22007%22%5D",
    );
  });

  it("reads the fixed card, evidence, current trace and history routes with server defaults", async () => {
    const cases = [
      {
        result: validCard,
        call: (client: ReturnType<typeof createUsBrowserClient>) => client.getLotCard(lotId),
        path: `${root}/card`,
      },
      {
        result: validEvidence,
        call: (client: ReturnType<typeof createUsBrowserClient>) =>
          client.listLotCardEvidence(lotId),
        path: `${root}/card/evidence?limit=20`,
      },
      {
        result: validTrace,
        call: (client: ReturnType<typeof createUsBrowserClient>) => client.readCurrentTrace(lotId),
        path: `${root}/trace?direction=both&maxDepth=16&maxNodes=500`,
      },
      {
        result: validHistory,
        call: (client: ReturnType<typeof createUsBrowserClient>) => client.listTraceHistory(lotId),
        path: `${root}/trace/history?limit=50`,
      },
    ];
    for (const item of cases) {
      const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json(item.result));
      await expect(item.call(createUsBrowserClient(send))).resolves.toEqual(item.result);
      expectRead(send, item.path);
    }
  });

  it("serializes bounded evidence and trace options on fixed routes", async () => {
    const evidenceSend = vi.fn<typeof fetch>().mockResolvedValue(Response.json(validEvidence));
    await createUsBrowserClient(evidenceSend).listLotCardEvidence(lotId, {
      limit: "10",
      cursor: "abc_09-Z",
    });
    expectRead(evidenceSend, `${root}/card/evidence?limit=10&cursor=abc_09-Z`);
    const traceSend = vi.fn<typeof fetch>().mockResolvedValue(Response.json(validTrace));
    await createUsBrowserClient(traceSend).readCurrentTrace(lotId, {
      direction: "forward",
      maxDepth: "4",
      maxNodes: "100",
    });
    expectRead(traceSend, `${root}/trace?direction=forward&maxDepth=4&maxNodes=100`);
    const historySend = vi.fn<typeof fetch>().mockResolvedValue(Response.json(validHistory));
    await createUsBrowserClient(historySend).listTraceHistory(lotId, {
      limit: "25",
      cursor: "abc_09-Z",
    });
    expectRead(historySend, `${root}/trace/history?limit=25&cursor=abc_09-Z`);
  });

  it("rejects invalid IDs and queries before fetch", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json(validSearch));
    const client = createUsBrowserClient(send);
    for (const read of [
      () => client.getLotCard("not-a-uuid"),
      () => client.listLotCardEvidence("not-a-uuid"),
      () => client.readCurrentTrace("not-a-uuid"),
      () => client.listTraceHistory("not-a-uuid"),
      () => client.searchTraceLots({ lotId: "not-a-uuid" }),
      () => client.searchTraceLots({ eventDateFrom: "2026-09-28", eventDateTo: "2026-09-01" }),
      () => client.searchTraceLots({ cursor: "bad/cursor" }),
      () => client.listLotCardEvidence(lotId, { limit: "51" }),
      () => client.readCurrentTrace(lotId, { maxDepth: "21" }),
      () => client.listTraceHistory(lotId, { cursor: "bad/cursor" }),
    ])
      await expect(read()).rejects.toMatchObject({ code: "invalid_input" });
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects malformed responses and a different requested lot identity", async () => {
    for (const [call, response] of [
      [
        (client: ReturnType<typeof createUsBrowserClient>) => client.searchTraceLots(),
        { ...validSearch, rangeOrder: "other" },
      ],
      [
        (client: ReturnType<typeof createUsBrowserClient>) => client.getLotCard(lotId),
        { ...validCard, lot: { ...validCard.lot, id: otherLotId } },
      ],
      [
        (client: ReturnType<typeof createUsBrowserClient>) => client.listLotCardEvidence(lotId),
        { items: null, nextCursor: null },
      ],
      [
        (client: ReturnType<typeof createUsBrowserClient>) => client.readCurrentTrace(lotId),
        { ...validTrace, rootLotId: otherLotId },
      ],
      [
        (client: ReturnType<typeof createUsBrowserClient>) => client.listTraceHistory(lotId),
        { items: null, nextCursor: null },
      ],
    ] as const) {
      const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response));
      await expect(call(createUsBrowserClient(send))).rejects.toMatchObject({
        code: "invalid_response",
      });
      expect(send).toHaveBeenCalledOnce();
    }
  });

  it("maps read errors by exact route while preserving auth and availability distinctions", async () => {
    const reads = [
      (client: ReturnType<typeof createUsBrowserClient>) => client.searchTraceLots(),
      (client: ReturnType<typeof createUsBrowserClient>) => client.getLotCard(lotId),
      (client: ReturnType<typeof createUsBrowserClient>) => client.listLotCardEvidence(lotId),
      (client: ReturnType<typeof createUsBrowserClient>) => client.readCurrentTrace(lotId),
      (client: ReturnType<typeof createUsBrowserClient>) => client.listTraceHistory(lotId),
    ];
    for (const [index, read] of reads.entries()) {
      for (const [status, code] of [
        [400, "invalid_input"],
        [401, "session_required"],
        [403, "forbidden"],
        [503, "unavailable"],
        [404, index === 0 ? "request_rejected" : "trace_lot_not_found"],
      ] as const) {
        const send = vi
          .fn<typeof fetch>()
          .mockResolvedValue(Response.json({ code: "untrusted" }, { status }));
        await expect(read(createUsBrowserClient(send))).rejects.toMatchObject({ code });
        expect(send).toHaveBeenCalledOnce();
      }
    }
  });
});
