import { expect, it } from "vitest";

import { kmOrderMetrics } from "../src/pages/km-orders/index.js";
import type { KmOrderListItem } from "../src/pages/km-orders/schemas.js";

/**
 * `kmOrderMetrics` is pure and exported specifically so the two most
 * contested tiles -- the 30-day issuing window and the buffer-expiry sum --
 * can be asserted directly against fixtures whose predicates only this test
 * exercises. `km-orders-page.test.tsx` covers the rendered strip end to end,
 * but every one of its fixture orders happens to have either `issuedCount: 0`
 * for anything outside the 30-day window or no past `bufferExpiresAt` at all,
 * so it cannot fail if either predicate were deleted.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-19T00:00:00.000Z");

function agoDays(days: number): string {
  return new Date(NOW - days * DAY_MS).toISOString();
}

function order(overrides: Partial<KmOrderListItem>): KmOrderListItem {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    productId: "22222222-2222-4222-8222-222222222222",
    productName: "Тестовый товар",
    gtin14: "04680089900383",
    productGroupAlias: "water",
    templateId: 1,
    quantity: 1000,
    state: "completed",
    omsOrderId: null,
    bufferStatus: null,
    bufferExpiresAt: null,
    availableCodes: null,
    fetchedCount: 0,
    issuedCount: 0,
    availableForIssue: 0,
    rejectionReason: null,
    errorCode: null,
    errorMessage: null,
    attempts: 1,
    createdBy: { id: "user_1", name: "Тестовый пользователь" },
    createdAt: agoDays(1),
    updatedAt: agoDays(1),
    ...overrides,
  };
}

it("excludes issued codes from an order created outside the 30-day window", () => {
  const old = order({ createdAt: agoDays(40), issuedCount: 500 });

  expect(kmOrderMetrics([old], NOW).issuedRecently).toBe(0);
});

it("includes issued codes from an order created inside the 30-day window", () => {
  const recent = order({ createdAt: agoDays(10), issuedCount: 500 });

  expect(kmOrderMetrics([recent], NOW).issuedRecently).toBe(500);
});

it("counts an already-expired buffer's available codes as expiring, not silent", () => {
  const pastExpiry = order({
    bufferExpiresAt: agoDays(1),
    availableCodes: 250,
  });

  expect(kmOrderMetrics([pastExpiry], NOW).expiringSoon).toBe(250);
});

it("excludes an order with no buffer expiry from the expiring-soon tile", () => {
  const noExpiry = order({ bufferExpiresAt: null, availableCodes: 250 });

  expect(kmOrderMetrics([noExpiry], NOW).expiringSoon).toBe(0);
});
