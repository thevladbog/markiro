import { DomainError } from "../errors.js";

type RetentionRecord =
  | { readonly recordClass: "record"; readonly createdOrObtainedOn: string }
  | {
      readonly recordClass: "plan";
      readonly createdOrObtainedOn: string;
      readonly supersededOn?: string;
    };

export type TraceabilityRetentionInput = RetentionRecord & {
  readonly retentionYears?: number;
  readonly holdUntil?: string;
  readonly indefiniteHold?: boolean;
  /** Persisted floor: reducing a later policy must not shorten this boundary. */
  readonly previousRetainThrough?: string;
};

export type TraceabilityRetentionDecision =
  | { readonly retainThrough: string; readonly indefiniteReason: null }
  | {
      readonly retainThrough: null;
      readonly indefiniteReason: "hold" | "effective_plan" | "date_range_exceeded";
    };

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function parseCivilDate(value: string): { year: number; month: number; day: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new DomainError("invalid_retention_date", "Expected an ISO civil date.");
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const monthDays = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const limit = monthDays[month - 1];
  if (year < 1 || limit === undefined || day < 1 || day > limit) {
    throw new DomainError("invalid_retention_date", "Expected a valid ISO civil date.");
  }
  return { year, month, day };
}

/**
 * Pure calendar policy, not a purge authorization or storage enforcement.
 * retainThrough includes the whole civil day in the record's authoritative zone.
 * Callers preserve persisted floors and must not infer removal of an active hold.
 */
export function traceabilityRetention(
  input: TraceabilityRetentionInput,
): TraceabilityRetentionDecision {
  const years = input.retentionYears ?? 5;
  if (!Number.isInteger(years) || years < 2 || years > 2147483647) {
    throw new DomainError("invalid_retention_years", "Expected an integer of at least two years.");
  }
  parseCivilDate(input.createdOrObtainedOn);
  const supersededOn = input.recordClass === "plan" ? input.supersededOn : undefined;
  const anchor = parseCivilDate(supersededOn ?? input.createdOrObtainedOn);
  if (supersededOn !== undefined && supersededOn < input.createdOrObtainedOn) {
    throw new DomainError("invalid_retention_anchor", "A plan cannot precede its creation.");
  }
  const floors = [input.holdUntil, input.previousRetainThrough];
  for (const floor of floors) {
    if (floor !== undefined) parseCivilDate(floor);
  }
  if (input.indefiniteHold === true) return { retainThrough: null, indefiniteReason: "hold" };
  if (input.recordClass === "plan" && supersededOn === undefined) {
    return { retainThrough: null, indefiniteReason: "effective_plan" };
  }
  const year = anchor.year + years;
  if (year > 9999) return { retainThrough: null, indefiniteReason: "date_range_exceeded" };
  const leapRollover = anchor.month === 2 && anchor.day === 29 && !isLeapYear(year);
  const month = leapRollover ? 3 : anchor.month;
  const day = leapRollover ? 1 : anchor.day;
  let retainThrough = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  for (const floor of floors) {
    if (floor !== undefined && floor > retainThrough) retainThrough = floor;
  }
  return { retainThrough, indefiniteReason: null };
}
