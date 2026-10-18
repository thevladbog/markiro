import type { TFunction } from "i18next";

import { formatQuantity } from "./shifts/shift-text.js";
import type { SerialStock, ShiftStock } from "./outbox-status.js";

export type StockKind = "box" | "pallet";

/**
 * The words for a stock of serials below `ok` (the thresholds are
 * `stockLevel`'s: a quarter and a tenth of the newest block, the last serial,
 * none); `null` while the stock is fine.
 */
export function stockText(t: TFunction, what: StockKind, stock: SerialStock): string | null {
  if (stock.level === "ok") return null;
  return t(`floor.status.stock.${what}.${stock.level}`, { n: formatQuantity(stock.left) });
}

/** The tone of the header's one low-stock chip: `null` while no stock is low. */
export function stockChipTone(stock: ShiftStock | null): "warn" | "error" | null {
  if (stock === null) return null;
  const levels = [stock.boxes.level, ...(stock.pallets === null ? [] : [stock.pallets.level])];
  if (levels.some((level) => level === "last" || level === "none")) return "error";
  return levels.some((level) => level !== "ok") ? "warn" : null;
}

/** What the low-stock chip says in full: the words of each stock that is low. */
export function stockChipDetail(t: TFunction, stock: ShiftStock): string {
  return [
    stockText(t, "box", stock.boxes),
    stock.pallets === null ? null : stockText(t, "pallet", stock.pallets),
  ]
    .filter((line): line is string => line !== null)
    .join(" ");
}
