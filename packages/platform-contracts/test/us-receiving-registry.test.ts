import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";
import {
  header,
  lifecycle,
  eventId,
  successorId,
} from "./support/us-receiving-lifecycle-fixture.js";

const current = {
  ...header,
  recordVersion: 2,
  status: "finalized",
  lifecycle: { ...lifecycle, lifecycleVersion: 3, pendingDraftId: successorId },
  dateReceived: "2026-09-07",
  locationId: null,
  previousSourceLocationId: null,
  lineCount: 2,
  documentCount: 1,
};
const pending = {
  ...current,
  id: successorId,
  revision: 2,
  status: "draft",
  lifecycle: {
    ...current.lifecycle,
    previousRevisionId: eventId,
    amendmentReason: "Quantity corrected",
  },
};
const page = { items: [pending, current], limit: 50, offset: 0 };

describe("Receiving live registry contracts", () => {
  it("defaults to current history and bounded pagination without a status filter", () => {
    expect(contracts.listReceivingLiveRecordsQuerySchema.parse({})).toEqual({
      history: "current",
      limit: 50,
      offset: 0,
    });
  });
  it.each(["draft", "finalized", "amended", "void"])(
    "accepts %s without silently expanding the selected history",
    (status) => {
      expect(contracts.listReceivingLiveRecordsQuerySchema.parse({ status })).toEqual({
        status,
        history: "current",
        limit: 50,
        offset: 0,
      });
      expect(
        contracts.listReceivingLiveRecordsQuerySchema.parse({ history: "all", status }),
      ).toEqual({
        status,
        history: "all",
        limit: 50,
        offset: 0,
      });
    },
  );
  it("preserves literal search syntax and accepts canonical page bounds", () => {
    expect(
      contracts.listReceivingLiveRecordsQuerySchema.parse({
        history: "all",
        search: "  ReC_%\\001  ",
        limit: "100",
        offset: "100000",
      }),
    ).toEqual({ history: "all", search: "ReC_%\\001", limit: 100, offset: 100000 });
  });
  it.each([
    { history: "latest" },
    { history: ["current", "all"] },
    { status: ["draft", "void"] },
    { status: "all" },
    { status: "DRAFT" },
    { limit: "01" },
    { limit: "1e2" },
    { limit: "100.0" },
    { limit: 0 },
    { limit: 101 },
    { limit: ["1", "2"] },
    { offset: "-1" },
    { offset: "01" },
    { offset: 100001 },
    { search: ["one", "two"] },
    { search: "x".repeat(201) },
    { search: "bad\u0000text" },
    { search: "bad\ud800text" },
    { archived: "all" },
    { tenantId: eventId },
    { current: "true" },
  ])("rejects malformed or unrecognized query %j", (query) => {
    expect(contracts.listReceivingLiveRecordsQuerySchema.safeParse(query).success).toBe(false);
  });
  it("preserves lifecycle summaries without adding frozen content or rewriting stored labels", () => {
    expect(contracts.receivingLiveRecordListSchema.parse(page)).toEqual(page);
    expect(
      contracts.receivingLiveRecordListSchema.parse({ items: [], limit: 1, offset: 100000 }),
    ).toEqual({ items: [], limit: 1, offset: 100000 });
  });
  it.each([
    { ...page, limit: 1 },
    { ...page, items: [current, current] },
    { ...page, items: [current, { ...current, id: eventId.toLowerCase() }] },
    { ...page, items: [{ ...current, content: { kind: "draft" } }] },
    { ...page, items: [{ ...current, lineCount: 101 }] },
    { ...page, items: [{ ...current, status: "amended" }] },
    { ...page, items: [pending, { ...current, eventNumber: "REC-26-9999" }] },
    { ...page, items: [pending, { ...current, timeZone: "America/New_York" }] },
    {
      ...page,
      items: [pending, { ...current, lifecycle: { ...current.lifecycle, lifecycleVersion: 4 } }],
    },
    {
      ...page,
      items: [pending, { ...current, lifecycle: { ...current.lifecycle, pendingDraftId: null } }],
    },
    { ...page, total: 2 },
  ])("rejects incoherent or non-summary response %j", (response) => {
    expect(contracts.receivingLiveRecordListSchema.safeParse(response).success).toBe(false);
  });
});
