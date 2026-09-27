import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  amendShippingSchema,
  voidShippingSchema,
  shippingRevisionListQuerySchema,
  shippingHttpErrorSchema,
} from "../src/index.js";

it("accepts strict versioned QA amendment and void commands", () => {
  const command = {
    operationKey: randomUUID(),
    expectedLifecycleVersion: 2,
    reason: "Correct dispatch quantity",
  };
  expect(amendShippingSchema.parse(command)).toEqual(command);
  expect(amendShippingSchema.safeParse({ ...command, tenantId: randomUUID() }).success).toBe(false);
  expect(voidShippingSchema.parse({ ...command, expectedDraftVersion: 1 })).toEqual({
    ...command,
    expectedDraftVersion: 1,
  });
  expect(voidShippingSchema.safeParse({ ...command, tlc: "NEW" }).success).toBe(false);
  expect(voidShippingSchema.safeParse({ ...command, reason: "  " }).success).toBe(false);
});

it("bounds revision pages and typed lifecycle conflicts", () => {
  expect(shippingRevisionListQuerySchema.safeParse({ limit: 100, offset: 100000 }).success).toBe(
    true,
  );
  expect(shippingRevisionListQuerySchema.safeParse({ limit: 101, offset: 0 }).success).toBe(false);
  expect(
    shippingRevisionListQuerySchema.safeParse({ limit: 10, offset: 0, tenantId: randomUUID() })
      .success,
  ).toBe(false);
  expect(
    shippingHttpErrorSchema.safeParse({
      code: "shipping_pending_amendment",
      pendingDraftId: randomUUID(),
    }).success,
  ).toBe(true);
  expect(
    shippingHttpErrorSchema.safeParse({
      code: "traceability_downstream_blocked",
      blockers: [],
      hasMore: false,
    }).success,
  ).toBe(true);
});
