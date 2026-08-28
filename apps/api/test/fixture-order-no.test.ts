import { describe, expect, it } from "vitest";
import { fixtureOrderNo } from "./support/order-no";

/**
 * `pickup_orders` is unique on `(tenant_id, order_no)`, and e2e fixtures seed
 * that column directly instead of going through `nextOrderNo`. They used to
 * draw it as `ORD-26-${randomUUID().slice(0, 4)}` -- four hex characters, a
 * space of 65 536 values. One file seeds 14 of those into a SINGLE tenant, so
 * by the birthday bound a run had a ~0.1% chance of dying on
 * `pickup_orders_tenant_order_no_uq` before asserting anything, and the whole
 * suite was reported flaky for it. This helper replaces the draw with a
 * counter, so the guarantee is structural rather than probabilistic.
 */
describe("fixtureOrderNo", () => {
  it("never repeats a value", () => {
    // 1000 draws from the old 4-hex space would collide with ~99.9%
    // probability (expected ~7.6 collisions); a counter cannot collide at all.
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) seen.add(fixtureOrderNo());
    expect(seen.size).toBe(1000);
  });

  it("cannot collide with a number the service itself generates", () => {
    // `formatOrderNo` (src/pickup/order-number.ts) emits `ORD-YY-NNNN` with a
    // zero-padded DIGIT sequence starting at 1 per tenant. A fixture that
    // happened to draw "0001" collided with the first API-created order in the
    // same tenant -- the same crash from the other direction. The `T` marker
    // puts fixtures in a namespace the generator can never reach.
    for (let i = 0; i < 100; i += 1) {
      expect(fixtureOrderNo()).toMatch(/^ORD-\d{2}-T\d+$/);
    }
  });
});
