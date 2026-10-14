import { classifyScan, kmHash } from "@markiro/domain";

import type { CodeSearchQuery } from "../../host/code-search.js";
import { isCivilDate } from "../../lib/civil-date.js";

/**
 * What was typed or scanned into «Поиск кодов», read as the station reads a
 * scan (the domain's `classifyScan`: the AIM prefixes and edge spaces go,
 * the group separators stay), and a shift's number besides. A code travels
 * only as its hash (`kmHash`), as on the floor.
 */
export type SearchInput =
  | { kind: "empty" }
  | { kind: "code"; codeHash: string }
  | { kind: "gtin"; gtin14: string }
  | { kind: "sscc"; sscc: string }
  | { kind: "shift"; number: string }
  | { kind: "unknown" };

/** `OCT26-004`, `oct26-4/s`: a month key, a dash, 1-6 digits, the station's `/S` or none. */
const SHIFT_NUMBER = /^[A-Za-z]{3}[0-9]{2}-[0-9]{1,6}(\/[Ss])?$/;

export function classifySearchInput(raw: string): SearchInput {
  const trimmed = raw.trim();
  if (trimmed === "") return { kind: "empty" };
  if (SHIFT_NUMBER.test(trimmed)) return { kind: "shift", number: trimmed.toUpperCase() };
  const scan = classifyScan(raw);
  switch (scan.kind) {
    case "km":
      return { kind: "code", codeHash: kmHash(scan.km) };
    case "gtin":
      return { kind: "gtin", gtin14: scan.gtin14 };
    case "sscc":
      return { kind: "sscc", sscc: scan.sscc };
    case "unknown":
      return { kind: "unknown" };
  }
}

/** The zone's clock minus UTC at the instant `at`, in milliseconds. */
function zoneOffsetMs(at: number, timeZone: string): number {
  const fields = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(at));
  const field = (type: Intl.DateTimeFormatPartTypes) =>
    Number(fields.find((part) => part.type === type)?.value);
  const wall = Date.UTC(
    field("year"),
    field("month") - 1,
    field("day"),
    field("hour"),
    field("minute"),
    field("second"),
  );
  return wall - Math.floor(at / 1000) * 1000;
}

/**
 * The instant a civil date begins in `timeZone` (the organization's IANA
 * zone), in milliseconds: the site's midnight, whatever this PC's zone. A
 * day that begins inside a clock change begins at the first instant it has.
 */
export function zonedDayStartMs(civil: string, timeZone: string): number {
  const [year, month, day] = civil.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(year, month - 1, day);
  let at = wall - zoneOffsetMs(wall, timeZone);
  // The offset at the guess may differ from the offset at the answer.
  const again = wall - zoneOffsetMs(at, timeZone);
  if (again !== at) at = Math.min(at, again);
  return at;
}

/** The civil date after `civil`. */
export function nextDay(civil: string): string {
  const [year, month, day] = civil.split("-").map(Number) as [number, number, number];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day + 1);
  return date.toISOString().slice(0, 10);
}

/**
 * The query of a search: the criterion that was typed and the period's days
 * in the organization's zone, both ends included (`[the first day's
 * midnight, the midnight after the last day)`). `null` when there is
 * nothing to ask: no criterion and no period, an input that is no
 * criterion, or a period that ends before it starts. A code's own search
 * sends only its hash: its card shows every placement.
 */
export function searchQuery(
  input: SearchInput,
  from: string,
  to: string,
  timeZone: string,
  page: number,
): CodeSearchQuery | null {
  if (input.kind === "unknown") return null;
  if (input.kind === "code") return { codeHash: input.codeHash };
  const query: CodeSearchQuery = {};
  if (input.kind === "gtin") query.gtin = input.gtin14;
  if (input.kind === "sscc") query.sscc = input.sscc;
  if (input.kind === "shift") query.shift = input.number;
  const hasFrom = isCivilDate(from);
  const hasTo = isCivilDate(to);
  if (hasFrom && hasTo && to < from) return null;
  if (hasFrom) query.fromMs = zonedDayStartMs(from, timeZone);
  if (hasTo) query.toMs = zonedDayStartMs(nextDay(to), timeZone);
  if (Object.keys(query).length === 0) return null;
  if (page > 1) query.page = page;
  return query;
}
