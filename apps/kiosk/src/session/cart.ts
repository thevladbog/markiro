import type { KioskBootstrapDto } from "../api/types.js";
import type { KioskScan } from "../domain-guard/classify.js";

export interface CartItem {
  rawKm: string;
  kmKey: string;
  gtin14: string;
  productId: string | null;
  name: string;
  unitPrice: string | null;
}

export interface CartState {
  items: CartItem[];
  reason: "buy" | "writeoff";
  writeoffReasonId: string | null;
  notice: CartNotice | null;
}

/** Why the last scan was refused. `null` means "the last scan was accepted". */
export type CartNotice =
  { kind: "duplicate" } | { kind: "limit" } | { kind: "unknown-product" } | { kind: "incomplete" };

export type CartAction =
  | { type: "scan"; scan: KioskScan }
  | { type: "remove"; kmKey: string }
  | { type: "reason"; reason: "buy" | "writeoff" }
  | { type: "writeoffReason"; id: string }
  | { type: "dismissNotice" }
  | { type: "reset" };

/** Everything the reducer needs from outside itself. No clock, no I/O. */
export interface CartContext {
  bootstrap: KioskBootstrapDto;
  alreadyTakenToday: number;
}

export const initialCartState: CartState = {
  items: [],
  reason: "buy",
  writeoffReasonId: null,
  notice: null,
};

/**
 * The whole cart, as one pure function: same inputs, same output, never a
 * `Date.now()`, never a mutation of `state` or of the arrays inside it. Every
 * decision lives here so the screen stays a projection of `CartState` and no
 * rule can leak into a component.
 *
 * LOCAL vs SERVER. These checks are UX only — they exist so a worker standing
 * at the kiosk learns immediately that they scanned the same bottle twice or
 * hit their daily allowance, instead of finding out after the order is filed.
 * They are NOT the decision. `POST /kiosk/orders` re-decides every one of them
 * against live data and its `conflicts[]` are authoritative: the device works
 * offline from a snapshot that may be hours old, so it can miss an item a
 * colleague's order already claimed, a product added since the last refresh,
 * or items the worker took at another kiosk. Never suppress a server conflict
 * because the local pass said the scan was fine.
 */
export function cartReducer(state: CartState, action: CartAction, ctx: CartContext): CartState {
  switch (action.type) {
    case "scan":
      return applyScan(state, action.scan, ctx);
    case "remove":
      return { ...state, items: state.items.filter((item) => item.kmKey !== action.kmKey) };
    case "reason":
      return { ...state, reason: action.reason };
    case "writeoffReason":
      return { ...state, writeoffReasonId: action.id };
    case "dismissNotice":
      return { ...state, notice: null };
    case "reset":
      return initialCartState;
  }
}

/**
 * Refusal order mirrors the server's per-item order in
 * `PickupOrdersService.resolveItems` / `applyDayLimit`: incomplete, then
 * unknown product, then duplicate, then the day limit. Duplicate beating the
 * limit is the load-bearing part — an item already in the cart is not a new
 * withdrawal, so the limit has nothing to say about it, and reporting "limit"
 * there would send the worker to an administrator over a double-scan.
 */
function applyScan(state: CartState, scan: KioskScan, ctx: CartContext): CartState {
  // The GS separator was dropped, so the serial (and the dedup key with it) is
  // untrustworthy — ask for a re-scan rather than guess.
  if (scan.kind === "incomplete") return { ...state, notice: { kind: "incomplete" } };
  // `badge` and `unknown` payloads are not cart input: identification and
  // unrecognised codes are the surrounding screen's business, not the cart's.
  if (scan.kind !== "km") return state;

  const product = ctx.bootstrap.products.find((p) => p.gtin14 === scan.gtin14);
  if (!product) return { ...state, notice: { kind: "unknown-product" } };

  if (state.items.some((item) => item.kmKey === scan.kmKey)) {
    return { ...state, notice: { kind: "duplicate" } };
  }

  // Exactly the server's rule: it accepts a candidate only while
  // `count < dayLimit`, counting from the employee's items already taken
  // today. Zero is therefore a real limit that accepts nothing — it is not a
  // sentinel for "unlimited", and there is no unlimited branch to mirror.
  if (ctx.alreadyTakenToday + state.items.length >= ctx.bootstrap.config.dayLimitPerEmployee) {
    return { ...state, notice: { kind: "limit" } };
  }

  const item: CartItem = {
    rawKm: scan.rawKm,
    kmKey: scan.kmKey,
    gtin14: scan.gtin14,
    productId: product.id,
    name: product.name,
    unitPrice: product.unitPrice,
  };
  return { ...state, items: [...state.items, item], notice: null };
}

/**
 * Whether the cart can be handed to an administrator. A write-off must name
 * its sub-reason: `writeoffReasonId` is what the server files the loss under,
 * and an unattributed write-off is the one thing this flow cannot audit later.
 */
export function canSubmit(state: CartState): boolean {
  if (state.items.length === 0) return false;
  if (state.reason === "writeoff" && state.writeoffReasonId === null) return false;
  return true;
}
