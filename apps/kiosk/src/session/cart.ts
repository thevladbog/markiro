import type { KioskBootstrapSnapshotDto } from "../api/types.js";
import type { KioskScan } from "../domain-guard/classify.js";
import { effectivePickupPolicy, type EffectivePickupPolicy } from "./day-count.js";

export interface LooseKmLine {
  kind: "km";
  rawKm: string;
  kmKey: string;
  gtin14: string;
  serial: string;
  productId: string;
  name: string;
  unitPrice: string | null;
  bottleCount: 1;
}

export interface BoxLine {
  kind: "box";
  boxId: string;
  sscc: string;
  productId: string;
  name: string;
  bottleCount: number;
  unitPrice: string | null;
  /** Local overlap evidence only. Never serialized into an order. */
  contentKeys: readonly string[];
  registryVersion: string;
}

export type KioskCartLine = LooseKmLine | BoxLine;
/** Compatibility name for pre-SSCC screen fixtures; the canonical state is `lines`. */
export type CartItem = LooseKmLine;

export interface CartState {
  lines: KioskCartLine[];
  reason: "buy" | "writeoff";
  writeoffReasonId: string | null;
  notice: CartNotice | null;
}

export type CartNotice =
  | { kind: "duplicate" }
  | { kind: "duplicate-box" }
  | { kind: "duplicate-sscc" }
  | { kind: "limit"; requested: number; remaining: number }
  | { kind: "unknown-product" }
  | { kind: "unknown-box" }
  | { kind: "registry-unavailable" }
  | { kind: "registry-blocked" }
  | { kind: "incomplete" }
  | { kind: "not-a-code" };

export type CartAction =
  | { type: "scan"; scan: KioskScan }
  | { type: "scanBox"; box: BoxLine }
  | { type: "boxRejected"; kind: "unknown-box" | "registry-unavailable" | "registry-blocked" }
  | { type: "remove"; kmKey: string }
  | { type: "removeBox"; sscc: string }
  | { type: "reason"; reason: "buy" | "writeoff" }
  | { type: "writeoffReason"; id: string }
  | { type: "dismissNotice" }
  | { type: "reset" };

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

export function cartPickupPolicy(ctx: CartContext): EffectivePickupPolicy {
  return effectivePickupPolicy(ctx.bootstrap, ctx.employeeId) ?? DENY_ALL_POLICY;
}

const noLines: KioskCartLine[] = [];
Object.freeze(noLines);
export const initialCartState: CartState = Object.freeze({
  lines: noLines,
  reason: "buy",
  writeoffReasonId: null,
  notice: null,
});

export function bottleCount(state: Pick<CartState, "lines">): number {
  return state.lines.reduce((sum, line) => sum + line.bottleCount, 0);
}

export function looseLines(state: Pick<CartState, "lines">): LooseKmLine[] {
  return state.lines.filter((line): line is LooseKmLine => line.kind === "km");
}

export function boxLines(state: Pick<CartState, "lines">): BoxLine[] {
  return state.lines.filter((line): line is BoxLine => line.kind === "box");
}

export function remainingToday(state: CartState, ctx: CartContext): number | null {
  const policy = cartPickupPolicy(ctx);
  if (!policy.limited) return null;
  return Math.max(0, policy.dayLimit - ctx.alreadyTakenToday - bottleCount(state));
}

function contentKeys(lines: readonly KioskCartLine[]): Set<string> {
  const keys = new Set<string>();
  for (const line of lines) {
    if (line.kind === "km") keys.add(line.kmKey);
    else for (const key of line.contentKeys) keys.add(key);
  }
  return keys;
}

export function cartReducer(state: CartState, action: CartAction, ctx: CartContext): CartState {
  switch (action.type) {
    case "scan":
      return applyScan(state, action.scan, ctx);
    case "scanBox":
      return applyBox(state, action.box, ctx);
    case "boxRejected":
      return { ...state, notice: { kind: action.kind } };
    case "remove":
      return {
        ...state,
        lines: state.lines.filter((line) => line.kind !== "km" || line.kmKey !== action.kmKey),
        notice: null,
      };
    case "removeBox":
      return {
        ...state,
        lines: state.lines.filter((line) => line.kind !== "box" || line.sscc !== action.sscc),
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
      return cartPickupPolicy(ctx).canWriteoff ? { ...state, writeoffReasonId: action.id } : state;
    case "dismissNotice":
      return { ...state, notice: null };
    case "reset":
      return initialCartState;
  }
}

function applyScan(state: CartState, scan: KioskScan, ctx: CartContext): CartState {
  if (scan.kind === "incomplete") return { ...state, notice: { kind: "incomplete" } };
  if (scan.kind === "unknown") return { ...state, notice: { kind: "not-a-code" } };
  if (scan.kind !== "km") return state;
  const product = ctx.bootstrap.products.find((candidate) => candidate.gtin14 === scan.gtin14);
  if (!product) return { ...state, notice: { kind: "unknown-product" } };
  if (contentKeys(state.lines).has(scan.kmKey)) return { ...state, notice: { kind: "duplicate" } };
  const remaining = remainingToday(state, ctx);
  if (remaining !== null && remaining < 1)
    return { ...state, notice: { kind: "limit", requested: 1, remaining } };
  const line: LooseKmLine = {
    kind: "km",
    rawKm: scan.rawKm,
    kmKey: scan.kmKey,
    gtin14: scan.gtin14,
    serial: scan.serial,
    productId: product.id,
    name: product.name,
    unitPrice: product.unitPrice,
    bottleCount: 1,
  };
  return { ...state, lines: [...state.lines, line], notice: null };
}

function applyBox(state: CartState, box: BoxLine, ctx: CartContext): CartState {
  if (state.lines.some((line) => line.kind === "box" && line.sscc === box.sscc))
    return { ...state, notice: { kind: "duplicate-sscc" } };
  const occupied = contentKeys(state.lines);
  if (box.contentKeys.some((key) => occupied.has(key)))
    return { ...state, notice: { kind: "duplicate-box" } };
  const remaining = remainingToday(state, ctx);
  if (remaining !== null && remaining < box.bottleCount)
    return {
      ...state,
      notice: { kind: "limit", requested: box.bottleCount, remaining },
    };
  return { ...state, lines: [...state.lines, box], notice: null };
}

export function canSubmit(state: CartState, ctx: CartContext): boolean {
  if (state.lines.length === 0) return false;
  if (state.reason === "writeoff")
    return cartPickupPolicy(ctx).canWriteoff && state.writeoffReasonId !== null;
  return true;
}
