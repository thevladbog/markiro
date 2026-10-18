import type { DisaggregationFilter, DisaggregationStatus } from "../../host/disaggregation.js";

/** What the list's filters hold. */
export interface DocumentFilterState {
  status: "all" | DisaggregationStatus;
  /** `""` = every reason. */
  reasonId: string;
  docNo: string;
  /** A civil date or `""`. */
  from: string;
  to: string;
}

const CIVIL = /^(\d{4})-(\d{2})-(\d{2})$/u;

/** Milliseconds the zone is ahead of UTC at `at` (its wall clock read back as UTC). */
function zoneOffset(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(at));
  const field = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  const wall = Date.UTC(
    field("year"),
    field("month") - 1,
    field("day"),
    field("hour"),
    field("minute"),
    field("second"),
  );
  return wall - at;
}

function hostInstant(at: number): string {
  return new Date(at).toISOString().replace(/\.\d{3}Z$/u, "Z");
}

function dayStart(date: string, timeZone: string, plusDays: number): number {
  const match = CIVIL.exec(date);
  if (match === null) throw new RangeError(`not a civil date: ${date}`);
  const midnight = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + plusDays);
  // Twice: the zone's offset at midnight may differ from the one at UTC midnight (a DST day).
  const first = midnight - zoneOffset(midnight, timeZone);
  return midnight - zoneOffset(first, timeZone);
}

/** The host's instant (`YYYY-MM-DDTHH:MM:SSZ`) at which civil `date` begins in `timeZone`. */
export function dayStartInstant(date: string, timeZone: string): string {
  return hostInstant(dayStart(date, timeZone, 0));
}

/**
 * The host's list filter (plan ДЗГ, Р16) from the page's: the days become
 * instants in `timeZone`, «По» the last second of its day. Nothing empty goes
 * in, so `disaggregationQuery` writes no empty parameter.
 */
export function documentFilter(state: DocumentFilterState, timeZone: string): DisaggregationFilter {
  const q = state.docNo.trim();
  return {
    ...(state.status === "all" ? {} : { status: state.status }),
    ...(state.reasonId === "" ? {} : { reasonId: state.reasonId }),
    ...(q === "" ? {} : { q }),
    // A value that is no civil date (a picker's half-typed text) narrows nothing.
    ...(!CIVIL.test(state.from) ? {} : { from: dayStartInstant(state.from, timeZone) }),
    // The last second of the day «По»: the host compares instants of whole seconds.
    ...(!CIVIL.test(state.to) ? {} : { to: hostInstant(dayStart(state.to, timeZone, 1) - 1000) }),
  };
}
