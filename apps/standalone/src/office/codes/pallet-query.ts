import type { PalletListQuery } from "../../host/pack-cards.js";
import { isCivilDate } from "../../lib/civil-date.js";
import { nextDay, zonedDayStartMs } from "./code-query.js";

/**
 * The pallet list's filters as the address keeps them (`?product=&line=&
 * device=&from=&to=&sscc=`), so «Назад» from a pallet's card finds the list
 * as it was. An empty text is an unset filter.
 */
export interface PalletFilters {
  product: string;
  line: string;
  device: string;
  /** The first day of closing, `YYYY-MM-DD`. */
  from: string;
  /** The last day of closing, `YYYY-MM-DD`, included. */
  to: string;
  sscc: string;
}

export const EMPTY_PALLET_FILTERS: PalletFilters = {
  product: "",
  line: "",
  device: "",
  from: "",
  to: "",
  sscc: "",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SSCC = /^[0-9]{18}$/;

/** What an address names, with what the host would refuse dropped. */
export function palletFiltersOf(params: URLSearchParams): PalletFilters {
  const id = (name: string) => {
    const value = params.get(name) ?? "";
    return UUID.test(value) ? value : "";
  };
  const day = (name: string) => {
    const value = params.get(name) ?? "";
    return isCivilDate(value) ? value : "";
  };
  const sscc = params.get("sscc") ?? "";
  return {
    product: id("product"),
    line: id("line"),
    device: id("device"),
    from: day("from"),
    to: day("to"),
    sscc: SSCC.test(sscc) ? sscc : "",
  };
}

export function paramsOfPalletFilters(filters: PalletFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const name of ["product", "line", "device", "from", "to", "sscc"] as const) {
    if (filters[name] !== "") params.set(name, filters[name]);
  }
  return params;
}

/**
 * The host's query of the filters: the days in the organization's zone,
 * `[from 00:00, the day after to 00:00)`. `null` for an SSCC that is not 18
 * digits or a period that ends before it starts.
 */
export function palletListQuery(filters: PalletFilters, timeZone: string): PalletListQuery | null {
  const query: PalletListQuery = {};
  if (filters.product !== "") query.product = filters.product;
  if (filters.line !== "") query.line = filters.line;
  if (filters.device !== "") query.device = filters.device;
  if (filters.sscc !== "") {
    if (!SSCC.test(filters.sscc)) return null;
    query.sscc = filters.sscc;
  }
  const hasFrom = isCivilDate(filters.from);
  const hasTo = isCivilDate(filters.to);
  if (hasFrom && hasTo && filters.to < filters.from) return null;
  if (hasFrom) query.fromMs = zonedDayStartMs(filters.from, timeZone);
  if (hasTo) query.toMs = zonedDayStartMs(nextDay(filters.to), timeZone);
  return query;
}
