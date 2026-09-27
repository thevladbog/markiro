import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { usEventListQuerySchema, usEventListSchema } from "../src/index.js";

const id = randomUUID();
const receiving = {
  type: "receiving" as const,
  id,
  rootId: id,
  eventNumber: "REC-26-0001",
  revision: 1,
  status: "draft" as const,
  lifecycleVersion: 1,
  currentEventId: null,
  pendingDraftId: id,
  eventDate: null,
  timeZone: "America/Chicago",
  locationId: null,
  locationDisplay: null,
  lineCount: 0,
  documentCount: 0,
  previousSourceLocationId: null,
  updatedAt: "2026-09-27T00:00:00.000Z",
};
it("defaults the mixed Events query and rejects noncanonical or unknown input", () => {
  expect(usEventListQuerySchema.parse({})).toMatchObject({
    type: "all",
    history: "current",
    limit: 50,
    offset: 0,
  });
  for (const query of [
    { limit: "101" },
    { limit: "01" },
    { offset: "-1" },
    { search: "x".repeat(201) },
    { search: "bad\u0000text" },
    { tenantId: id },
  ])
    expect(usEventListQuerySchema.safeParse(query).success).toBe(false);
  expect(usEventListQuerySchema.parse({ type: "transformation", limit: "1" }).limit).toBe(1);
  expect(usEventListQuerySchema.parse({ type: "shipping" }).type).toBe("shipping");
});

it("accepts all three strict discriminated summaries and rejects foreign fields", () => {
  const transformationId = randomUUID();
  const validTransformation = {
    type: "transformation" as const,
    id: transformationId,
    rootId: transformationId,
    eventNumber: "TRN-26-0002",
    revision: 1,
    status: "finalized" as const,
    lifecycleVersion: 1,
    currentEventId: transformationId,
    pendingDraftId: null,
    eventDate: "2026-09-27",
    timeZone: "America/Chicago",
    locationId: null,
    locationDisplay: null,
    inputCount: 1,
    outputCount: 1,
    documentCount: 1,
    updatedAt: "2026-09-27T00:00:00.000Z",
  };
  const list = { items: [receiving, validTransformation], limit: 2, offset: 0 };
  expect(usEventListSchema.safeParse(list).success).toBe(true);
  const shippingId = randomUUID();
  const shipping = {
    ...receiving,
    id: shippingId,
    rootId: shippingId,
    pendingDraftId: shippingId,
    type: "shipping",
    eventNumber: "SHP-26-0001",
    lineCount: 1,
    documentCount: 1,
  };
  delete (shipping as { previousSourceLocationId?: string | null }).previousSourceLocationId;
  expect(
    usEventListSchema.safeParse({
      items: [receiving, validTransformation, shipping],
      limit: 3,
      offset: 0,
    }).success,
  ).toBe(true);
  expect(
    usEventListSchema.safeParse({ items: [{ ...shipping, inputCount: 1 }], limit: 1, offset: 0 })
      .success,
  ).toBe(false);
  expect(usEventListSchema.safeParse({ ...list, extra: true }).success).toBe(false);
  expect(
    usEventListSchema.safeParse({ ...list, items: [{ ...receiving, outputCount: 1 }] }).success,
  ).toBe(false);
  expect(
    usEventListSchema.safeParse({ ...list, items: [{ ...validTransformation, inputCount: 101 }] })
      .success,
  ).toBe(false);
  expect(
    usEventListSchema.safeParse({
      ...list,
      items: [{ ...validTransformation, eventDate: "2026-02-30" }],
    }).success,
  ).toBe(false);
});

it("rejects an over-limit page, duplicate IDs and inconsistent root lifecycle", () => {
  expect(
    usEventListSchema.safeParse({ items: [receiving, receiving], limit: 1, offset: 0 }).success,
  ).toBe(false);
  expect(
    usEventListSchema.safeParse({ items: [receiving, receiving], limit: 2, offset: 0 }).success,
  ).toBe(false);
  const nextId = randomUUID();
  const first = {
    ...receiving,
    status: "amended" as const,
    currentEventId: nextId,
    pendingDraftId: null,
  };
  const next = {
    ...receiving,
    id: nextId,
    revision: 2,
    status: "finalized" as const,
    currentEventId: nextId,
    pendingDraftId: null,
  };
  expect(usEventListSchema.safeParse({ items: [first, next], limit: 2, offset: 0 }).success).toBe(
    true,
  );
  expect(
    usEventListSchema.safeParse({
      items: [first, { ...next, lifecycleVersion: 2 }],
      limit: 2,
      offset: 0,
    }).success,
  ).toBe(false);
  expect(
    usEventListSchema.safeParse({
      items: [first, { ...next, eventNumber: "REC-26-9999" }],
      limit: 2,
      offset: 0,
    }).success,
  ).toBe(false);
});

it("rejects impossible identity and status pointers on a single row of either event type", () => {
  const transformationId = randomUUID();
  const transformation = {
    type: "transformation" as const,
    id: transformationId,
    rootId: transformationId,
    eventNumber: "TRN-26-0002",
    revision: 1,
    status: "finalized" as const,
    lifecycleVersion: 1,
    currentEventId: transformationId,
    pendingDraftId: null,
    eventDate: "2026-09-27",
    timeZone: "America/Chicago",
    locationId: null,
    locationDisplay: null,
    inputCount: 1,
    outputCount: 1,
    documentCount: 1,
    updatedAt: "2026-09-27T00:00:00.000Z",
  };
  const valid = (row: unknown) =>
    usEventListSchema.safeParse({ items: [row], limit: 1, offset: 0 }).success;
  expect(valid(receiving)).toBe(true);
  expect(valid(transformation)).toBe(true);
  for (const row of [receiving, transformation]) {
    expect(
      valid({ ...row, status: "amended", currentEventId: randomUUID(), pendingDraftId: null }),
    ).toBe(true);
    expect(valid({ ...row, status: "void", currentEventId: null, pendingDraftId: null })).toBe(
      true,
    );
    expect(valid({ ...row, rootId: randomUUID() })).toBe(false);
    expect(valid({ ...row, revision: 2 })).toBe(false);
    expect(valid({ ...row, currentEventId: row.id, pendingDraftId: row.id })).toBe(false);
    expect(valid({ ...row, status: "draft", pendingDraftId: null })).toBe(false);
    expect(valid({ ...row, status: "finalized", currentEventId: null, pendingDraftId: null })).toBe(
      false,
    );
    expect(valid({ ...row, status: "amended", currentEventId: row.id, pendingDraftId: null })).toBe(
      false,
    );
    expect(valid({ ...row, status: "void", currentEventId: row.id, pendingDraftId: null })).toBe(
      false,
    );
  }
});
