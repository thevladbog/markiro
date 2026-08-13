import type { KioskBootstrapSnapshotDto } from "../api/types.js";
import type { KioskScan } from "../domain-guard/classify.js";
import { effectivePickupPolicy, type EffectivePickupPolicy } from "./day-count.js";

export interface CartItem {
  rawKm: string;
  kmKey: string;
  gtin14: string;
  /**
   * The KM's serial, as `classifyKioskScan` parsed it. Carried rather than
   * left to be sliced back out of `kmKey`: it is half of what a worker reads
   * to tell one bottle from the next, and recovering it downstream would put
   * knowledge of the `01<gtin14>21<serial>` layout in a screen.
   */
  serial: string;
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

/**
 * Why the last scan was refused. `null` means "the last scan was accepted".
 *
 * `unknown-product` and `not-a-code` are deliberately separate and must stay
 * so: `unknown-product` means "a real marking code, for something this kiosk
 * does not stock" — nothing the worker can fix by re-scanning, they need an
 * administrator. `not-a-code` means "that barcode is not a marking code at
 * all" — almost always the plain EAN printed next to the DataMatrix, which the
 * worker fixes on the spot by scanning the right symbol. The server's
 * equivalent verdict is `not_km`.
 */
export type CartNotice =
  | { kind: "duplicate" }
  | { kind: "limit" }
  | { kind: "unknown-product" }
  | { kind: "incomplete" }
  | { kind: "not-a-code" };

export type CartAction =
  | { type: "scan"; scan: KioskScan }
  | { type: "remove"; kmKey: string }
  | { type: "reason"; reason: "buy" | "writeoff" }
  | { type: "writeoffReason"; id: string }
  | { type: "dismissNotice" }
  | { type: "reset" };

/** Everything the reducer needs from outside itself. No clock, no I/O. */
export interface CartContext {
  bootstrap: KioskBootstrapSnapshotDto;
  employeeId: string;
  alreadyTakenToday: number;
}

const DENY_ALL_POLICY: EffectivePickupPolicy = Object.freeze({
  limited: true,
  dayLimit: 0,
  canWriteoff: false,
});

/** Missing employee data is an unusable session, never implicit privilege. */
export function cartPickupPolicy(ctx: CartContext): EffectivePickupPolicy {
  return effectivePickupPolicy(ctx.bootstrap, ctx.employeeId) ?? DENY_ALL_POLICY;
}

// Frozen because `reset` hands this very object straight back out and it is
// the module's only singleton: one stray mutation in any consumer would poison
// every cart the app opens afterwards. The empty array is frozen too — it is
// the sole reachable nested value, and `push` is the mutation worth stopping.
// The reducer itself never mutates: every branch below builds new objects.
const noItems: CartItem[] = [];
Object.freeze(noItems);

export const initialCartState: CartState = Object.freeze({
  items: noItems,
  reason: "buy",
  writeoffReasonId: null,
  notice: null,
});

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
      // Clearing the notice matters: at `dayLimitPerEmployee: 1` a full cart
      // refuses the next scan with `limit`, and removing the item is exactly
      // how the worker resolves that. Leaving the banner up would tell them
      // they are still blocked when the slot they just freed is theirs again.
      return {
        ...state,
        items: state.items.filter((item) => item.kmKey !== action.kmKey),
        notice: null,
      };
    case "reason":
      if (action.reason === "writeoff" && !cartPickupPolicy(ctx).canWriteoff) return state;
      return {
        ...state,
        reason: action.reason,
        ...(action.reason === "buy" ? { writeoffReasonId: null } : {}),
      };
    case "writeoffReason":
      if (!cartPickupPolicy(ctx).canWriteoff) return state;
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
  // A bare GTIN or SSCC — the worker scanned the plain product barcode next to
  // the DataMatrix, the commonest mis-scan at a kiosk. Say so: silence here
  // (and, worse, an identical state object with nothing to re-render on) makes
  // a working scanner look dead. Placed with the other non-`km` kinds rather
  // than in the refusal ladder below because the order cannot be observed: a
  // scan is `unknown` xor `km`, so it can never also be a duplicate, an
  // unstocked product or a limit case.
  if (scan.kind === "unknown") return { ...state, notice: { kind: "not-a-code" } };
  // A `badge` payload is not cart input at all: mid-cart identification is the
  // surrounding screen's business, so leave both items and notice untouched.
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
  //
  // Asked through `remainingToday` rather than re-stated as an inequality,
  // because the screen has to ask the same question to decide whether to show
  // a scan prompt at all: one expression, so the prompt and the refusal cannot
  // drift into disagreeing.
  if (remainingToday(state, ctx) === 0) return { ...state, notice: { kind: "limit" } };

  const item: CartItem = {
    rawKm: scan.rawKm,
    kmKey: scan.kmKey,
    gtin14: scan.gtin14,
    serial: scan.serial,
    productId: product.id,
    name: product.name,
    unitPrice: product.unitPrice,
  };
  return { ...state, items: [...state.items, item], notice: null };
}

/**
 * How many more items this employee may take today. The reducer's own limit
 * rule read as a number instead of as a refusal — `remainingToday(…) === 0` is
 * precisely when the next scan comes back `{ kind: "limit" }`, because
 * `applyScan` above asks this very function.
 *
 * Clamped at zero, and that clamp is load-bearing twice over. `alreadyTakenToday`
 * is counted off the device's own order journal (`session/day-count.ts`) and can
 * exceed the limit — an administrator lowering it mid-day, or a snapshot older
 * than the orders it is being compared against — so the raw difference goes
 * negative. Negative is neither printable («осталось −2») nor, more
 * importantly, equal to zero: a caller testing "is there anything left?" with
 * the unclamped difference would answer "yes" for a worker who has none, put an
 * inviting scan prompt in front of them, and let the reducer refuse every code
 * they present.
 */
export function remainingToday(state: CartState, ctx: CartContext): number {
  const policy = cartPickupPolicy(ctx);
  if (!policy.limited) return Number.POSITIVE_INFINITY;
  const taken = ctx.alreadyTakenToday + state.items.length;
  return Math.max(0, policy.dayLimit - taken);
}

/**
 * Whether the cart can be handed to an administrator. A write-off must name
 * its sub-reason: `writeoffReasonId` is what the server files the loss under,
 * and an unattributed write-off is the one thing this flow cannot audit later.
 */
export function canSubmit(state: CartState, ctx: CartContext): boolean {
  if (state.items.length === 0) return false;
  if (state.reason === "writeoff") {
    if (!cartPickupPolicy(ctx).canWriteoff) return false;
    if (state.writeoffReasonId === null) return false;
  }
  return true;
}
