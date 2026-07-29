import { describe, expect, it } from "vitest";
import type { KioskBootstrapDto } from "../src/api/types.js";
import { classifyKioskScan, type KioskScan } from "../src/domain-guard/classify.js";
import {
  canSubmit,
  cartReducer,
  initialCartState,
  remainingToday,
  type CartAction,
  type CartState,
} from "../src/session/cart.js";

const GS = String.fromCharCode(0x1d);
// Check-digit-valid GTIN-14s. The classifier does not throw on a bad check
// digit — it swallows the parse error and degrades to "unknown" — so the `km()`
// helper below throws itself whenever a fixture comes back as anything but
// "km". That is what makes a mistyped GTIN here fail loudly instead of quietly
// turning a KM test into a not-a-marking-code test.
const GTIN_MILK = "04600682000013";
const GTIN_BREAD = "04600682000020";
const GTIN_ABSENT = "04600682000037"; // valid code, deliberately not in `products`

/**
 * Builds a KM scan by pushing a real payload through the real classifier,
 * so these fixtures stay honest about what the scanner actually produces.
 */
function km(gtin14: string, serial: string): KioskScan {
  const raw = `01${gtin14}21${serial}${GS}93Abcd`;
  const scan = classifyKioskScan(raw);
  if (scan.kind !== "km") throw new Error(`fixture "${raw}" classified as ${scan.kind}, not km`);
  return scan;
}

/** The same payload with the GS separator swallowed by a keyboard wedge. */
function incompleteScan(): KioskScan {
  const scan = classifyKioskScan(`01${GTIN_MILK}21KYC9X7MQ93Abcd`);
  if (scan.kind !== "incomplete") throw new Error(`fixture classified as ${scan.kind}`);
  return scan;
}

/** The bare EAN printed next to the DataMatrix — the likeliest mis-scan here. */
function bareProductBarcode(): KioskScan {
  const scan = classifyKioskScan(GTIN_MILK);
  if (scan.kind !== "unknown") throw new Error(`fixture classified as ${scan.kind}`);
  return scan;
}

/** An opaque payload with no GS1 structure — what a staff badge looks like. */
function badgeScan(): KioskScan {
  const scan = classifyKioskScan("BADGE-7F3A21C0");
  if (scan.kind !== "badge") throw new Error(`fixture classified as ${scan.kind}`);
  return scan;
}

function bootstrapWith(dayLimitPerEmployee: number): KioskBootstrapDto {
  return {
    generatedAt: "2026-07-28T09:00:00.000Z",
    config: { dayLimitPerEmployee, showPrices: true },
    badgeSalt: "c2FsdA==",
    reasons: [{ id: "reason-defect", name: "Брак" }],
    products: [
      { id: "p-milk", gtin14: GTIN_MILK, name: "Молоко 3,2%", unitPrice: "89.90", egaisCode: null },
      { id: "p-bread", gtin14: GTIN_BREAD, name: "Хлеб", unitPrice: "45.00", egaisCode: null },
    ],
    employees: [],
    operators: [],
  };
}

function ctxOf(dayLimitPerEmployee: number, alreadyTakenToday = 0) {
  return { bootstrap: bootstrapWith(dayLimitPerEmployee), alreadyTakenToday };
}

type Ctx = ReturnType<typeof ctxOf>;

function run(ctx: Ctx, ...actions: CartAction[]): CartState {
  return actions.reduce((state, action) => cartReducer(state, action, ctx), initialCartState);
}

const scan = (s: KioskScan): CartAction => ({ type: "scan", scan: s });

describe("cartReducer — scanning", () => {
  // The serial is carried, not re-derived: it is the half of the item's
  // identity a worker reads off the screen, and the classifier has already
  // parsed it. Anything downstream that sliced it back out of `kmKey` would be
  // re-implementing the GS1 layout in a place that has no business knowing it.
  it("appends a scanned KM with its product's id, name, price and serial", () => {
    const state = run(ctxOf(5), scan(km(GTIN_MILK, "KYC9X7MQ")));

    expect(state.items).toEqual([
      {
        rawKm: `01${GTIN_MILK}21KYC9X7MQ${GS}93Abcd`,
        kmKey: `01${GTIN_MILK}21KYC9X7MQ`,
        gtin14: GTIN_MILK,
        serial: "KYC9X7MQ",
        productId: "p-milk",
        name: "Молоко 3,2%",
        unitPrice: "89.90",
      },
    ]);
    expect(state.notice).toBeNull();
  });

  it("reports the same kmKey scanned twice as a duplicate and does not grow the list", () => {
    const repeated = km(GTIN_MILK, "KYC9X7MQ");
    const state = run(ctxOf(5), scan(repeated), scan(repeated));

    expect(state.notice).toEqual({ kind: "duplicate" });
    expect(state.items).toHaveLength(1);
  });

  it("keeps two serials of the same product apart — dedup is per kmKey, not per GTIN", () => {
    const state = run(ctxOf(5), scan(km(GTIN_MILK, "AAAA1111")), scan(km(GTIN_MILK, "BBBB2222")));

    expect(state.notice).toBeNull();
    expect(state.items.map((i) => i.kmKey)).toEqual([
      `01${GTIN_MILK}21AAAA1111`,
      `01${GTIN_MILK}21BBBB2222`,
    ]);
  });

  it("refuses a KM whose GTIN is not in the catalogue", () => {
    const state = run(ctxOf(5), scan(km(GTIN_ABSENT, "KYC9X7MQ")));

    expect(state.notice).toEqual({ kind: "unknown-product" });
    expect(state.items).toHaveLength(0);
  });

  it("refuses a scan once the day limit is already reached", () => {
    const state = run(ctxOf(1, 1), scan(km(GTIN_MILK, "KYC9X7MQ")));

    expect(state.notice).toEqual({ kind: "limit" });
    expect(state.items).toHaveLength(0);
  });

  it("counts alreadyTakenToday against the limit — 2 per day with 1 taken leaves exactly one", () => {
    const ctx = ctxOf(2, 1);
    const first = cartReducer(initialCartState, scan(km(GTIN_MILK, "AAAA1111")), ctx);
    expect(first.items).toHaveLength(1);
    expect(first.notice).toBeNull();

    const second = cartReducer(first, scan(km(GTIN_BREAD, "BBBB2222")), ctx);
    expect(second.notice).toEqual({ kind: "limit" });
    expect(second.items).toHaveLength(1);
  });

  it("accepts nothing at dayLimitPerEmployee: 0 — zero is a limit, not 'unlimited'", () => {
    const state = run(ctxOf(0), scan(km(GTIN_MILK, "KYC9X7MQ")));

    expect(state.notice).toEqual({ kind: "limit" });
    expect(state.items).toHaveLength(0);
  });

  it("reports a duplicate as a duplicate even when the cart is already at the limit", () => {
    // dayLimit 1: the single slot is taken by this very item, so a re-scan of
    // it is not a new withdrawal and the limit is irrelevant to it.
    const repeated = km(GTIN_MILK, "KYC9X7MQ");
    const state = run(ctxOf(1), scan(repeated), scan(repeated));

    expect(state.notice).toEqual({ kind: "duplicate" });
    expect(state.items).toHaveLength(1);
  });

  it("asks for a re-scan when the GS separator was dropped", () => {
    const state = run(ctxOf(5), scan(incompleteScan()));

    expect(state.notice).toEqual({ kind: "incomplete" });
    expect(state.items).toHaveLength(0);
  });

  it("tells the worker a bare product barcode is not a marking code", () => {
    const state = run(ctxOf(5), scan(bareProductBarcode()));

    expect(state.notice).toEqual({ kind: "not-a-code" });
    expect(state.items).toHaveLength(0);
  });

  it("leaves the cart entirely alone on a badge scan — identification is not cart input", () => {
    const ctx = ctxOf(5);
    const stocked = run(ctx, scan(km(GTIN_MILK, "AAAA1111")), scan(km(GTIN_MILK, "AAAA1111")));
    expect(stocked.notice).toEqual({ kind: "duplicate" });

    const state = cartReducer(stocked, scan(badgeScan()), ctx);

    expect(state.items).toEqual(stocked.items);
    expect(state.notice).toEqual({ kind: "duplicate" });
  });

  it("never mutates the state it was given", () => {
    const ctx = ctxOf(5);
    const before = cartReducer(initialCartState, scan(km(GTIN_MILK, "AAAA1111")), ctx);
    const snapshot = structuredClone(before);

    cartReducer(before, scan(km(GTIN_BREAD, "BBBB2222")), ctx);
    cartReducer(before, scan(km(GTIN_MILK, "AAAA1111")), ctx);

    expect(before).toEqual(snapshot);
  });
});

describe("cartReducer — plain actions", () => {
  it("removes the item with the matching kmKey and leaves the rest", () => {
    const ctx = ctxOf(5);
    const stocked = run(ctx, scan(km(GTIN_MILK, "AAAA1111")), scan(km(GTIN_BREAD, "BBBB2222")));

    const state = cartReducer(stocked, { type: "remove", kmKey: `01${GTIN_MILK}21AAAA1111` }, ctx);

    expect(state.items.map((i) => i.kmKey)).toEqual([`01${GTIN_BREAD}21BBBB2222`]);
  });

  it("clears a stale notice on remove — emptying the cart un-does the limit", () => {
    const ctx = ctxOf(1);
    const full = run(ctx, scan(km(GTIN_MILK, "AAAA1111")), scan(km(GTIN_BREAD, "BBBB2222")));
    expect(full.notice).toEqual({ kind: "limit" });

    const state = cartReducer(full, { type: "remove", kmKey: `01${GTIN_MILK}21AAAA1111` }, ctx);

    expect(state.items).toHaveLength(0);
    expect(state.notice).toBeNull();
  });

  it("clears the notice on dismissNotice without touching the items", () => {
    const repeated = km(GTIN_MILK, "KYC9X7MQ");
    const state = run(ctxOf(5), scan(repeated), scan(repeated), { type: "dismissNotice" });

    expect(state.notice).toBeNull();
    expect(state.items).toHaveLength(1);
  });

  it("returns the initial state on reset", () => {
    const state = run(
      ctxOf(5),
      scan(km(GTIN_MILK, "AAAA1111")),
      { type: "reason", reason: "writeoff" },
      { type: "writeoffReason", id: "reason-defect" },
      { type: "reset" },
    );

    expect(state).toEqual(initialCartState);
  });
});

describe("initialCartState", () => {
  it("is frozen — `reset` hands this very object out, so a stray mutation would poison the app", () => {
    expect(Object.isFrozen(initialCartState)).toBe(true);
    expect(Object.isFrozen(initialCartState.items)).toBe(true);
  });
});

// The screen has to print this number and has to decide when to replace the
// scan prompt with the blocking panel. It lives here, next to the rule it
// re-states, so the panel and the reducer cannot drift apart.
describe("remainingToday", () => {
  it("subtracts both the cart and what was taken earlier today", () => {
    const ctx = ctxOf(5, 1);
    expect(remainingToday(initialCartState, ctx)).toBe(4);
    expect(remainingToday(run(ctx, scan(km(GTIN_MILK, "AAAA1111"))), ctx)).toBe(3);
  });

  // `alreadyTakenToday` is counted off the device's own journal and can
  // legitimately exceed the limit: an administrator lowering it mid-day, or a
  // snapshot older than the orders it is compared against. Unclamped,
  // «осталось −2» would print, and — worse — a screen that
  // shows its scan prompt while `remaining` is merely non-zero would invite
  // scans the reducer refuses one after another.
  it("never goes negative for an employee already past their allowance", () => {
    expect(remainingToday(initialCartState, ctxOf(5, 7))).toBe(0);
    expect(remainingToday(initialCartState, ctxOf(5, 5))).toBe(0);
    expect(remainingToday(initialCartState, ctxOf(0))).toBe(0);
  });

  it("hits zero exactly when the reducer starts refusing scans", () => {
    for (const limit of [0, 1, 2, 5]) {
      for (const taken of [0, 1, 2, 5, 7]) {
        const ctx = ctxOf(limit, taken);
        const refused =
          cartReducer(initialCartState, scan(km(GTIN_MILK, "AAAA1111")), ctx).notice?.kind ===
          "limit";
        expect({ limit, taken, exhausted: remainingToday(initialCartState, ctx) === 0 }).toEqual({
          limit,
          taken,
          exhausted: refused,
        });
      }
    }
  });
});

describe("canSubmit", () => {
  it("is false while nothing has been scanned", () => {
    expect(canSubmit(initialCartState)).toBe(false);
  });

  it("is true for a non-empty buy cart", () => {
    expect(canSubmit(run(ctxOf(5), scan(km(GTIN_MILK, "AAAA1111"))))).toBe(true);
  });

  it("is false for a write-off with no sub-reason chosen", () => {
    const state = run(ctxOf(5), scan(km(GTIN_MILK, "AAAA1111")), {
      type: "reason",
      reason: "writeoff",
    });

    expect(state.writeoffReasonId).toBeNull();
    expect(canSubmit(state)).toBe(false);
  });

  it("is true for a write-off once a sub-reason is chosen", () => {
    const state = run(
      ctxOf(5),
      scan(km(GTIN_MILK, "AAAA1111")),
      { type: "reason", reason: "writeoff" },
      { type: "writeoffReason", id: "reason-defect" },
    );

    expect(canSubmit(state)).toBe(true);
  });
});
