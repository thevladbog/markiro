import { isTraceabilityCivilDate } from "../civil-date.js";

const MIN_INSTANT = Date.parse("0001-01-01T00:00:00.000Z");
const MAX_INSTANT = Date.parse("9999-12-31T23:59:59.999Z");

function parseOffsetInstant(value: string): Date {
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3}0*)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) throw new RangeError("us_request_invalid_instant");
  const [, civilDate, hour, minute, second, offset, sign, offsetHour, offsetMinute] = match;
  if (
    civilDate === undefined ||
    !isTraceabilityCivilDate(civilDate) ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    (offset !== "Z" && (Number(offsetHour) > 23 || Number(offsetMinute) > 59))
  ) {
    throw new RangeError("us_request_invalid_instant");
  }
  const instant = new Date(value);
  const epoch = instant.getTime();
  if (!Number.isFinite(epoch) || epoch < MIN_INSTANT || epoch > MAX_INSTANT) {
    throw new RangeError("us_request_deadline_out_of_range");
  }
  const offsetMilliseconds =
    offset === "Z"
      ? 0
      : (sign === "-" ? -1 : 1) * (Number(offsetHour) * 60 + Number(offsetMinute)) * 60_000;
  const reconstructed = new Date(epoch + offsetMilliseconds).toISOString().slice(0, 19);
  if (reconstructed !== value.slice(0, 19)) {
    throw new RangeError("us_request_invalid_instant");
  }
  return instant;
}

export function resolveUsRequestDeadline(
  receivedAt: string,
  dueAt?: string,
  reason?: string | null,
): { dueAt: string; alternateDeadlineReason: string | null } {
  const received = parseOffsetInstant(receivedAt);
  const normal = received.getTime() + 86_400_000;
  if (!Number.isFinite(normal) || normal > MAX_INSTANT) {
    throw new RangeError("us_request_deadline_out_of_range");
  }
  const due = dueAt === undefined ? new Date(normal) : parseOffsetInstant(dueAt);
  if (due.getTime() <= received.getTime()) throw new RangeError("us_request_deadline_order");
  const alternate = due.getTime() !== normal;
  const trimmed = reason?.trim() ?? "";
  if (alternate && (trimmed.length < 3 || trimmed.length > 2000)) {
    throw new RangeError("us_request_alternate_reason_required");
  }
  return { dueAt: due.toISOString(), alternateDeadlineReason: alternate ? trimmed : null };
}
