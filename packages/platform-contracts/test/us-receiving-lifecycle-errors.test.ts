import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";
import { eventId, successorId, otherId } from "./support/us-receiving-lifecycle-fixture.js";

const conflict = {
  code: "receiving_lifecycle_conflict",
  rootId: eventId,
  lifecycleVersion: 3,
  currentEventId: eventId,
  pendingDraftId: successorId,
};
const identity = {
  code: "lot_identity_locked",
  lines: [{ lineNo: 1, fields: ["lotId", "productId", "tlc", "source"] }],
};
const issue = {
  severity: "error",
  group: "lines",
  line: 1,
  field: "exemption",
  code: "exemption_review_required",
  detail: null,
};
// Synthetic wire contract only: no persisted downstream consumers exist yet.
const downstream = {
  code: "receiving_downstream_dependencies",
  blockingEvents: [
    { eventId, eventNumber: "TRF-26-0001", revision: 2, kind: "transformation" },
    { eventId: successorId, eventNumber: "SHP-26-0001", revision: 1, kind: "shipping" },
  ],
  correctionOrder: [successorId, eventId],
  hasMore: false,
};

describe("Receiving lifecycle conflict responses", () => {
  it.each([
    { code: "receiving_draft_conflict" },
    { code: "receiving_operation_conflict" },
    { code: "receiving_already_finalized" },
    { code: "receiving_readiness_changed" },
    { code: "receiving_lot_conflict" },
    conflict,
    { ...conflict, currentEventId: null, pendingDraftId: null },
    { code: "receiving_pending_amendment", pendingDraftId: successorId },
    identity,
    { code: "event_incomplete", issues: [issue] },
    downstream,
    { ...downstream, hasMore: true },
  ])("preserves $code payload without rewriting IDs or context", (value) => {
    expect(contracts.receivingLifecycleErrorSchema.parse(value)).toEqual(value);
  });

  it.each([
    { code: "unknown_conflict" },
    { code: "receiving_draft_conflict", rootId: eventId },
    { ...conflict, tenantId: otherId },
    { ...conflict, rootId: "bad" },
    { ...conflict, lifecycleVersion: 0 },
    { ...conflict, lifecycleVersion: 2147483648 },
    { ...conflict, lifecycleVersion: "3" },
    { ...conflict, currentEventId: undefined },
    { ...conflict, pendingDraftId: undefined },
    { ...conflict, pendingDraftId: eventId.toLowerCase() },
    { code: "receiving_pending_amendment", pendingDraftId: null },
    { code: "receiving_pending_amendment" },
    { ...identity, lines: [] },
    { ...identity, lines: [{ lineNo: 0, fields: ["tlc"] }] },
    { ...identity, lines: [{ lineNo: 101, fields: ["tlc"] }] },
    { ...identity, lines: [{ lineNo: 1, fields: [] }] },
    { ...identity, lines: [{ lineNo: 1, fields: ["notes"] }] },
    { ...identity, lines: [{ lineNo: 1, fields: ["tlc", "tlc"] }] },
    { ...identity, lines: [{ lineNo: 1, fields: ["tlc", "lotId"] }] },
    { ...identity, lines: [{ lineNo: 1, fields: ["tlc"], lotId: otherId }] },
    {
      ...identity,
      lines: [
        { lineNo: 2, fields: ["tlc"] },
        { lineNo: 1, fields: ["tlc"] },
      ],
    },
    {
      ...identity,
      lines: [
        { lineNo: 1, fields: ["tlc"] },
        { lineNo: 1, fields: ["source"] },
      ],
    },
    { code: "event_incomplete", issues: [{ ...issue, tenantId: otherId }] },
    { code: "event_incomplete", issues: [{ ...issue, code: "unknown" }] },
    { code: "event_incomplete", issues: Array.from({ length: 5001 }, () => issue) },
    { ...downstream, blockingEvents: [] },
    { ...downstream, blockingEvents: [...downstream.blockingEvents].reverse() },
    { ...downstream, blockingEvents: [downstream.blockingEvents[0], downstream.blockingEvents[0]] },
    {
      ...downstream,
      blockingEvents: [
        { ...downstream.blockingEvents[0], kind: "receiving" },
        downstream.blockingEvents[1],
      ],
    },
    {
      ...downstream,
      blockingEvents: [
        { ...downstream.blockingEvents[0], tenantId: otherId },
        downstream.blockingEvents[1],
      ],
    },
    {
      ...downstream,
      blockingEvents: [
        { ...downstream.blockingEvents[0], eventNumber: " " },
        downstream.blockingEvents[1],
      ],
    },
    {
      ...downstream,
      blockingEvents: [
        { ...downstream.blockingEvents[0], revision: 0 },
        downstream.blockingEvents[1],
      ],
    },
    { ...downstream, correctionOrder: [] },
    { ...downstream, correctionOrder: [eventId] },
    { ...downstream, correctionOrder: [eventId, eventId.toLowerCase()] },
    { ...downstream, correctionOrder: [eventId, otherId] },
    { ...downstream, hasMore: undefined },
  ])("rejects malformed or ambiguous conflict %#", (value) => {
    expect(contracts.receivingLifecycleErrorSchema.safeParse(value).success).toBe(false);
  });

  it("bounds downstream response size without pretending to validate dependency order", () => {
    const blockingEvents = Array.from({ length: 100 }, (_, index) => ({
      eventId: `b0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      eventNumber: `SHP-26-${String(index).padStart(4, "0")}`,
      kind: "shipping",
      revision: 1,
    }));
    const value = {
      ...downstream,
      blockingEvents,
      correctionOrder: blockingEvents.map((event) => event.eventId).reverse(),
      hasMore: true,
    };
    expect(contracts.receivingLifecycleErrorSchema.parse(value)).toEqual(value);
    expect(
      contracts.receivingLifecycleErrorSchema.safeParse({
        ...value,
        blockingEvents: [
          ...blockingEvents,
          { ...blockingEvents[0], eventId: "b0000000-0000-4000-8000-000000000100" },
        ],
        correctionOrder: [...value.correctionOrder, "b0000000-0000-4000-8000-000000000100"],
      }).success,
    ).toBe(false);
  });
});
