import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  transformationHttpErrorSchema,
  transformationHttpRecordSchema,
  transformationRevisionListQuerySchema,
  transformationRevisionListSchema,
} from "../src/index.js";

const id = randomUUID();
const now = "2026-09-27T00:00:00.000Z";
const draft = {
  id,
  eventNumber: "TRN-26-0001",
  revision: 1,
  draftVersion: 1,
  timeZone: "America/Chicago",
  createdBy: "qa",
  updatedBy: "qa",
  createdAt: now,
  updatedAt: now,
  status: "draft" as const,
  draft: {
    eventDate: null,
    processorLocationId: null,
    reason: null,
    reasonNote: null,
    notes: null,
    inputs: [],
    outputs: [],
    documentIds: [],
  },
};
const summary = {
  id,
  rootId: id,
  eventNumber: "TRN-26-0001",
  revision: 1,
  status: "draft" as const,
  timeZone: "America/Chicago",
  lifecycleVersion: 1,
  currentEventId: null,
  pendingDraftId: id,
  previousRevisionId: null,
  amendmentReason: null,
  voidReason: null,
};

it("accepts existing draft wire shape and rejects unknown record keys", () => {
  expect(transformationHttpRecordSchema.safeParse(draft).success).toBe(true);
  expect(transformationHttpRecordSchema.safeParse({ ...draft, tenantId: id }).success).toBe(false);
});

it("enforces canonical bounded revision query and coherent strict history", () => {
  expect(transformationRevisionListQuerySchema.parse({})).toEqual({ limit: 50, offset: 0 });
  for (const query of [{ limit: "01" }, { limit: "101" }, { offset: "-1" }, { history: "all" }])
    expect(transformationRevisionListQuerySchema.safeParse(query).success).toBe(false);
  expect(transformationRevisionListQuerySchema.parse({ limit: "2" }).limit).toBe(2);
  const currentId = randomUUID();
  const first = {
    ...summary,
    status: "amended" as const,
    currentEventId: currentId,
    pendingDraftId: null,
  };
  const second = {
    ...summary,
    id: currentId,
    revision: 2,
    status: "finalized" as const,
    previousRevisionId: id,
    amendmentReason: "Correction",
    currentEventId: currentId,
    pendingDraftId: null,
  };
  expect(
    transformationRevisionListSchema.safeParse({
      items: [first, second],
      limit: 2,
      offset: 0,
      lifecycleVersion: 1,
    }).success,
  ).toBe(true);
  for (const items of [
    [first, first],
    [first, { ...second, lifecycleVersion: 2 }],
    [first, { ...second, rootId: randomUUID() }],
  ])
    expect(
      transformationRevisionListSchema.safeParse({
        items,
        limit: 2,
        offset: 0,
        lifecycleVersion: 1,
      }).success,
    ).toBe(false);
  expect(
    transformationRevisionListSchema.safeParse({
      items: [first, second],
      limit: 1,
      offset: 0,
      lifecycleVersion: 1,
    }).success,
  ).toBe(false);
  expect(
    transformationRevisionListSchema.safeParse({
      items: [{ ...summary, unexpected: true }],
      limit: 1,
      offset: 0,
      lifecycleVersion: 1,
    }).success,
  ).toBe(false);
});

it("rejects impossible identity, predecessor and status pointers on one revision summary", () => {
  const valid = (row: unknown) =>
    transformationRevisionListSchema.safeParse({
      items: [row],
      limit: 1,
      offset: 0,
      lifecycleVersion: 1,
    }).success;
  expect(valid(summary)).toBe(true);
  expect(valid({ ...summary, rootId: randomUUID() })).toBe(false);
  expect(valid({ ...summary, revision: 2 })).toBe(false);
  expect(valid({ ...summary, currentEventId: id, pendingDraftId: id })).toBe(false);
  expect(valid({ ...summary, pendingDraftId: null })).toBe(false);
  expect(
    valid({ ...summary, status: "finalized", pendingDraftId: null, currentEventId: null }),
  ).toBe(false);
  expect(valid({ ...summary, status: "amended", pendingDraftId: null, currentEventId: id })).toBe(
    false,
  );
  expect(valid({ ...summary, status: "void", pendingDraftId: null, currentEventId: id })).toBe(
    false,
  );
  expect(valid({ ...summary, previousRevisionId: randomUUID() })).toBe(false);
  const currentId = randomUUID();
  const amendment = {
    ...summary,
    id: currentId,
    revision: 2,
    status: "finalized" as const,
    previousRevisionId: id,
    amendmentReason: "Correction",
    currentEventId: currentId,
    pendingDraftId: null,
  };
  expect(valid(amendment)).toBe(true);
  expect(
    valid({ ...summary, status: "amended", currentEventId: currentId, pendingDraftId: null }),
  ).toBe(true);
  expect(
    valid({
      ...summary,
      status: "void",
      currentEventId: null,
      pendingDraftId: null,
      voidReason: "Correction",
    }),
  ).toBe(true);
  expect(valid({ ...amendment, previousRevisionId: null })).toBe(false);
  expect(valid({ ...amendment, amendmentReason: null })).toBe(false);
  expect(valid({ ...amendment, previousRevisionId: currentId })).toBe(false);
});

it("accepts only safe typed errors and bounded blocker metadata", () => {
  for (const code of [
    "transformation_not_found",
    "transformation_reference_not_found",
    "transformation_not_draft",
    "transformation_draft_conflict",
    "transformation_lifecycle_conflict",
    "transformation_operation_conflict",
    "transformation_readiness_changed",
    "transformation_output_identity_locked",
    "transformation_lot_conflict",
    "transformation_genealogy_cycle",
  ])
    expect(transformationHttpErrorSchema.safeParse({ code }).success).toBe(true);
  expect(
    transformationHttpErrorSchema.safeParse({
      code: "transformation_pending_amendment",
      pendingDraftId: id,
    }).success,
  ).toBe(true);
  expect(
    transformationHttpErrorSchema.safeParse({
      code: "transformation_pending_amendment",
      pendingDraftId: "bad",
    }).success,
  ).toBe(false);
  const issue = {
    severity: "error",
    group: "event",
    line: null,
    field: "eventDate",
    code: "missing",
    detail: null,
  };
  expect(
    transformationHttpErrorSchema.safeParse({ code: "event_incomplete", issues: [issue] }).success,
  ).toBe(true);
  const blocker = { lotId: id, eventId: randomUUID(), rootId: randomUUID(), revision: 1 };
  const blocked = { code: "traceability_downstream_blocked", blockers: [blocker], hasMore: false };
  expect(transformationHttpErrorSchema.safeParse(blocked).success).toBe(true);
  expect(
    transformationHttpErrorSchema.safeParse({ ...blocked, blockers: Array(101).fill(blocker) })
      .success,
  ).toBe(false);
  expect(
    transformationHttpErrorSchema.safeParse({ ...blocked, raw: "database detail" }).success,
  ).toBe(false);
  expect(
    transformationHttpErrorSchema.safeParse({
      code: "event_incomplete",
      issues: [{ ...issue, secret: "x" }],
    }).success,
  ).toBe(false);
});
