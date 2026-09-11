export type CommercialBillingPeriod = "month" | "year";

export type CommercialPeriod = {
  billingPeriod: CommercialBillingPeriod;
  billingTimezone: "Europe/Moscow";
  calendarPolicyVersion: 1;
  anchorAt: string;
  cycle: number;
  startsAt: string;
  endsAt: string;
};

export type SellerTaxPolicy =
  | { kind: "without_vat"; regime: "npd" | "other" }
  | {
      kind: "vat";
      regime: "other";
      allowedRatesBps: number[];
      defaultRateBps: number;
      defaultIncluded: boolean;
    };

export type CommercialTax = { vatRateBps: number | null; vatIncluded: boolean };

const BILLING_TIMEZONE = "Europe/Moscow" as const;
const CALENDAR_POLICY_VERSION = 1 as const;
const ISO_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;
const MAX_VAT_RATE_BPS = 10_000;
const TIMEZONE_OFFSET_PROBES_MS = [-48, -24, -6, 0, 6, 24, 48].map(
  (hours) => hours * 60 * 60 * 1_000,
);

type DateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
};

const moscowDateTime = new Intl.DateTimeFormat("en-US", {
  timeZone: BILLING_TIMEZONE,
  calendar: "gregory",
  numberingSystem: "latn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export function resolveCommercialPeriod(input: {
  anchorAt: string;
  billingPeriod: CommercialBillingPeriod;
  cycle: number;
}): CommercialPeriod {
  if (input.billingPeriod !== "month" && input.billingPeriod !== "year") {
    throw new RangeError("Unsupported commercial billing period");
  }
  if (
    !Number.isSafeInteger(input.cycle) ||
    input.cycle < 0 ||
    input.cycle === Number.MAX_SAFE_INTEGER
  ) {
    throw new RangeError("Commercial cycle must be a nonnegative safe integer");
  }

  const anchor = parseIsoInstant(input.anchorAt);
  const original = dateTimeParts(anchor);
  const startsAt =
    input.cycle === 0 ? anchor : boundaryFromAnchor(original, input.billingPeriod, input.cycle);
  const endsAt = boundaryFromAnchor(original, input.billingPeriod, input.cycle + 1);

  return {
    billingPeriod: input.billingPeriod,
    billingTimezone: BILLING_TIMEZONE,
    calendarPolicyVersion: CALENDAR_POLICY_VERSION,
    anchorAt: anchor.toISOString(),
    cycle: input.cycle,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
  };
}

export function commercialTaxDefaults(policy: SellerTaxPolicy): CommercialTax {
  assertSellerTaxPolicy(policy);
  if (policy.kind === "without_vat") {
    return { vatRateBps: null, vatIncluded: false };
  }
  return {
    vatRateBps: policy.defaultRateBps,
    vatIncluded: policy.defaultIncluded,
  };
}

export function isCommercialTaxAllowed(policy: SellerTaxPolicy, value: CommercialTax): boolean {
  assertSellerTaxPolicy(policy);
  if (typeof value.vatIncluded !== "boolean") {
    return false;
  }
  if (policy.kind === "without_vat") {
    return value.vatRateBps === null && !value.vatIncluded;
  }
  return isVatRateBps(value.vatRateBps) && policy.allowedRatesBps.includes(value.vatRateBps);
}

function parseIsoInstant(value: string): Date {
  const match = ISO_INSTANT_PATTERN.exec(value);
  if (match === null) {
    throw new RangeError("Invalid commercial anchor instant");
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? "").padEnd(3, "0"));
  const timezone = match[8];
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    timezone === undefined
  ) {
    throw new RangeError("Invalid commercial anchor instant");
  }

  let offsetMinutes = 0;
  if (timezone !== "Z") {
    const offsetHour = Number(timezone.slice(1, 3));
    const offsetMinute = Number(timezone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) {
      throw new RangeError("Invalid commercial anchor instant");
    }
    offsetMinutes = (offsetHour * 60 + offsetMinute) * (timezone[0] === "+" ? 1 : -1);
  }

  const localMillis = utcMillis({ year, month, day, hour, minute, second, millisecond });
  const instantMillis = localMillis - offsetMinutes * 60_000;
  const instant = new Date(instantMillis);
  const instantYear = instant.getUTCFullYear();
  if (!Number.isFinite(instantMillis) || instantYear < 1 || instantYear > 9_999) {
    throw new RangeError("Commercial anchor instant is outside the supported date range");
  }
  return instant;
}

function boundaryFromAnchor(
  anchor: DateTimeParts,
  billingPeriod: CommercialBillingPeriod,
  cycle: number,
): Date {
  let year: number;
  let month: number;
  if (billingPeriod === "month") {
    const targetMonth = anchor.year * 12 + anchor.month - 1 + cycle;
    if (!Number.isSafeInteger(targetMonth)) {
      throw new RangeError("Commercial period exceeds the supported date range");
    }
    year = Math.floor(targetMonth / 12);
    month = (targetMonth % 12) + 1;
  } else {
    year = anchor.year + cycle;
    month = anchor.month;
  }
  if (!Number.isSafeInteger(year) || year < 1 || year > 9_999) {
    throw new RangeError("Commercial period exceeds the supported date range");
  }

  const target: DateTimeParts = {
    ...anchor,
    year,
    month,
    day: Math.min(anchor.day, daysInMonth(year, month)),
  };
  return instantFromMoscowDateTime(target);
}

function dateTimeParts(date: Date): DateTimeParts {
  const values = new Map(
    moscowDateTime
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: requiredPart(values, "year"),
    month: requiredPart(values, "month"),
    day: requiredPart(values, "day"),
    hour: requiredPart(values, "hour"),
    minute: requiredPart(values, "minute"),
    second: requiredPart(values, "second"),
    millisecond: date.getUTCMilliseconds(),
  };
}

function requiredPart(values: Map<string, number>, part: string): number {
  const value = values.get(part);
  if (value === undefined) {
    throw new RangeError("Unable to resolve commercial billing timezone");
  }
  return value;
}

function instantFromMoscowDateTime(target: DateTimeParts): Date {
  const localMillis = utcMillis(target);
  const offsets = new Set(
    TIMEZONE_OFFSET_PROBES_MS.map((probe) => {
      const instantMillis = localMillis + probe;
      return utcMillis(dateTimeParts(new Date(instantMillis))) - instantMillis;
    }),
  );
  const candidates = [...offsets]
    .map((offset) => new Date(localMillis - offset))
    .filter((candidate) => sameDateTimeParts(dateTimeParts(candidate), target))
    .sort((left, right) => left.getTime() - right.getTime());
  const earliest = candidates[0];
  if (earliest !== undefined) {
    // A clock overlap has two valid instants. The calendar policy always chooses the earlier one.
    return earliest;
  }
  throw new RangeError("Commercial boundary is invalid in the billing timezone");
}

function sameDateTimeParts(left: DateTimeParts, right: DateTimeParts): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.second === right.second &&
    left.millisecond === right.millisecond
  );
}

function utcMillis(parts: DateTimeParts): number {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, parts.second, parts.millisecond);
  return date.getTime();
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function assertSellerTaxPolicy(policy: SellerTaxPolicy): void {
  if (typeof policy !== "object" || policy === null) {
    throw new TypeError("Invalid seller tax policy");
  }
  if (policy.kind === "without_vat") {
    if (policy.regime !== "npd" && policy.regime !== "other") {
      throw new TypeError("Invalid seller tax policy");
    }
    return;
  }
  if (
    policy.kind !== "vat" ||
    policy.regime !== "other" ||
    !Array.isArray(policy.allowedRatesBps) ||
    policy.allowedRatesBps.length === 0 ||
    !policy.allowedRatesBps.every(isVatRateBps) ||
    new Set(policy.allowedRatesBps).size !== policy.allowedRatesBps.length ||
    !isVatRateBps(policy.defaultRateBps) ||
    !policy.allowedRatesBps.includes(policy.defaultRateBps) ||
    typeof policy.defaultIncluded !== "boolean"
  ) {
    throw new TypeError("Invalid seller tax policy");
  }
}

function isVatRateBps(value: number | null): value is number {
  return Number.isInteger(value) && value !== null && value >= 0 && value <= MAX_VAT_RATE_BPS;
}
