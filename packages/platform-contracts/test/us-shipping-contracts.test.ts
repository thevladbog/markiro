import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  createShippingDraftSchema,
  saveShippingDraftSchema,
  shippingDraftSchema,
  shippingDraftRecordSchema,
  shippingReadinessSchema,
  shippingBalanceQuerySchema,
  shippingBalanceResponseSchema,
} from "../src/index.js";

const lotId = randomUUID();
const empty = {
  eventDate: null,
  shipFromLocationId: null,
  recipientLocationId: null,
  carrierReference: null,
  notes: null,
  items: [],
  documentIds: [],
};

it("saves an empty draft and a selected lot with incomplete quantity", () => {
  expect(shippingDraftSchema.parse(empty)).toEqual(empty);
  const partial = {
    ...empty,
    items: [{ lotId, quantity: null, unitOfMeasure: null }],
  };
  expect(shippingDraftSchema.parse(partial)).toEqual(partial);
  expect(
    shippingDraftSchema.safeParse({
      ...empty,
      items: [{ lotId: null, quantity: null, unitOfMeasure: null }],
    }).success,
  ).toBe(false);
});

it("accepts only a complete replacement context and strict exact balance response", () => {
  const draftId = randomUUID();
  expect(shippingBalanceQuerySchema.parse({})).toEqual({});
  expect(
    shippingBalanceQuerySchema.parse({ contextDraftId: draftId, expectedDraftVersion: 2 }),
  ).toEqual({
    contextDraftId: draftId,
    expectedDraftVersion: 2,
  });
  for (const query of [
    { contextDraftId: draftId },
    { expectedDraftVersion: 2 },
    { contextDraftId: draftId, expectedDraftVersion: 2, excludedEventId: randomUUID() },
  ])
    expect(shippingBalanceQuerySchema.safeParse(query).success).toBe(false);
  const known = {
    lotId,
    originUom: "case",
    balance: {
      state: "known",
      unitOfMeasure: "case",
      supply: "100.001",
      used: "40",
      remaining: "60.001",
    },
  };
  expect(shippingBalanceResponseSchema.parse(known)).toEqual(known);
  expect(shippingBalanceResponseSchema.safeParse({ ...known, available: "60.001" }).success).toBe(
    false,
  );
  expect(
    shippingBalanceResponseSchema.safeParse({
      ...known,
      balance: { state: "unknown", reason: "no_current_origin" },
      originUom: null,
    }).success,
  ).toBe(true);
  expect(
    shippingBalanceResponseSchema.safeParse({
      ...known,
      balance: { state: "unknown", reason: "no_current_origin", remaining: "0" },
    }).success,
  ).toBe(false);
});

it("rejects new identity, tenant fields, duplicate lots and duplicate documents", () => {
  const line = { lotId, quantity: "1.000", unitOfMeasure: "case" };
  for (const field of ["tlc", "productId", "createLot", "tenantId"] as const)
    expect(
      shippingDraftSchema.safeParse({ ...empty, items: [{ ...line, [field]: field }] }).success,
    ).toBe(false);
  for (const field of ["tenantId", "tlc", "productId", "createLot"] as const)
    expect(
      createShippingDraftSchema.safeParse({
        operationKey: randomUUID(),
        draft: empty,
        [field]: field,
      }).success,
    ).toBe(false);
  expect(shippingDraftSchema.safeParse({ ...empty, items: [line, line] }).success).toBe(false);
  expect(shippingDraftSchema.safeParse({ ...empty, documentIds: [lotId, lotId] }).success).toBe(
    false,
  );
  expect(
    saveShippingDraftSchema.safeParse({
      operationKey: randomUUID(),
      expectedDraftVersion: 1,
      draft: empty,
      tenantId: "x",
    }).success,
  ).toBe(false);
});

it("binds saved record and readiness to a versioned server identity", () => {
  const id = randomUUID();
  const record = {
    id,
    eventNumber: "SHP-26-0001",
    revision: 1,
    draftVersion: 1,
    timeZone: "America/Chicago",
    createdBy: randomUUID(),
    updatedBy: randomUUID(),
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z",
    status: "draft",
    draft: empty,
  };
  expect(shippingDraftRecordSchema.safeParse(record).success).toBe(true);
  expect(shippingDraftRecordSchema.safeParse({ ...record, tenantId: randomUUID() }).success).toBe(
    false,
  );
  expect(
    shippingReadinessSchema.safeParse({
      eventId: id,
      expectedDraftVersion: 1,
      ruleVersion: "shipping-readiness-v1",
      inputDigest: "a".repeat(64),
      state: "incomplete",
      profileCode: "US_GENERIC_LOT_TRACEABILITY",
      issues: [{ severity: "error", path: "items", code: "required", line: null }],
    }).success,
  ).toBe(true);
});
