import { resolveUsRequestDeadline } from "@markiro/domain";
import {
  usTraceRequestCreateBodySchema,
  type UsTraceRequestCreateBody,
  type UsTraceRequestUpdateBody,
  type UsRequestDetailResponse,
} from "@markiro/platform-contracts";
import { resolveRequestWallTime } from "./time.js";

export type RequestTimingFields = {
  requestNumber: string;
  requesterName: string;
  requesterOrganization: string;
  requesterContact: string;
  receivedWall: string;
  receivedOffsetSeconds: number | null;
  duePolicy: "default" | "alternative";
  dueWall: string;
  dueOffsetSeconds: number | null;
  alternateDeadlineReason: string;
};

/** Native datetime-local omits zero seconds. Expand precision without parsing in the browser zone. */
export function canonicalRequestWall(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
  return match ? `${match[1]}:${match[2] ?? "00"}.${(match[3] ?? "").padEnd(3, "0")}` : value;
}

function instantFields(instant: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const wall = `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}.${part("fractionalSecond")}`;
  return { wall, offset: (Date.parse(`${wall}Z`) - Date.parse(instant)) / 1000 };
}

export function requestTimingFields(
  detail: UsRequestDetailResponse | null,
  timeZone: string,
): RequestTimingFields {
  const receipt = detail ? instantFields(detail.receivedAt, timeZone) : null;
  const due = detail ? instantFields(detail.dueAt, timeZone) : null;
  return {
    requestNumber: detail?.requestNumber ?? "",
    requesterName: detail?.requesterName ?? "",
    requesterOrganization: detail?.requesterOrganization ?? "",
    requesterContact: detail?.requesterContact ?? "",
    receivedWall: receipt?.wall ?? "",
    receivedOffsetSeconds: receipt?.offset ?? null,
    duePolicy:
      detail &&
      (Date.parse(detail.dueAt) - Date.parse(detail.receivedAt) !== 86_400_000 ||
        detail.alternateDeadlineReason !== null)
        ? "alternative"
        : "default",
    dueWall: due?.wall ?? "",
    dueOffsetSeconds: due?.offset ?? null,
    alternateDeadlineReason: detail?.alternateDeadlineReason ?? "",
  };
}

export function changedRequestTiming(
  body: Omit<UsTraceRequestCreateBody, "scope">,
  baseline: UsRequestDetailResponse,
): UsTraceRequestUpdateBody {
  const changed: UsTraceRequestUpdateBody = { expectedRevision: baseline.revision };
  for (const key of ["requestNumber", "requesterName"] as const) {
    if (body[key] !== baseline[key]) changed[key] = body[key];
  }
  for (const key of [
    "requesterOrganization",
    "requesterContact",
    "alternateDeadlineReason",
  ] as const) {
    if (body[key] !== baseline[key]) changed[key] = body[key] ?? null;
  }
  if (Date.parse(body.receivedAt) !== Date.parse(baseline.receivedAt))
    changed.receivedAt = body.receivedAt;
  if (body.dueAt !== undefined && Date.parse(body.dueAt) !== Date.parse(baseline.dueAt))
    changed.dueAt = body.dueAt;
  return changed;
}

export function parseRequestTiming(
  fields: RequestTimingFields,
  timeZone: string,
):
  | { ok: true; body: Omit<UsTraceRequestCreateBody, "scope"> }
  | { ok: false; fields: Readonly<Record<string, string>> } {
  // Values are localized error keys, never the server or schema's raw messages.
  const errors: Record<string, string> = {};
  const resolve = (wall: string, offset: number | null, field: string): string | undefined => {
    const result = resolveRequestWallTime(wall, timeZone);
    if (!("candidates" in result)) {
      errors[field] = result.kind;
      return undefined;
    }
    const candidate =
      offset === null && result.kind === "unique"
        ? result.candidates[0]
        : result.candidates.find((value) => value.offsetSeconds === offset);
    if (candidate === undefined) errors[field] = "offsetRequired";
    return candidate?.instant;
  };
  const receivedAt = resolve(fields.receivedWall, fields.receivedOffsetSeconds, "receivedWall");
  const dueAt =
    fields.duePolicy === "alternative"
      ? resolve(fields.dueWall, fields.dueOffsetSeconds, "dueWall")
      : undefined;
  const optional = (value: string): string | null => (value === "" ? null : value);
  const parsed = usTraceRequestCreateBodySchema.safeParse({
    requestNumber: fields.requestNumber,
    requesterName: fields.requesterName,
    requesterOrganization: optional(fields.requesterOrganization),
    requesterContact: optional(fields.requesterContact),
    receivedAt: receivedAt ?? "",
    ...(dueAt === undefined ? {} : { dueAt }),
    alternateDeadlineReason: optional(fields.alternateDeadlineReason),
    scope: null,
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key !== "string" || key === "receivedAt" || key === "dueAt") continue;
      errors[key] = "invalid";
    }
  }
  if (Object.keys(errors).length > 0 || !parsed.success) return { ok: false, fields: errors };
  let deadline: ReturnType<typeof resolveUsRequestDeadline>;
  try {
    deadline = resolveUsRequestDeadline(
      parsed.data.receivedAt,
      dueAt,
      parsed.data.alternateDeadlineReason,
    );
  } catch (error) {
    const code = error instanceof RangeError ? error.message : "";
    if (code === "us_request_alternate_reason_required")
      errors.alternateDeadlineReason = "alternateReason";
    else if (code === "us_request_deadline_order") errors.dueWall = "deadlineOrder";
    else if (code === "us_request_deadline_out_of_range") errors.receivedWall = "invalid";
    else errors.dueWall = "invalid";
    return { ok: false, fields: errors };
  }
  const resolved = usTraceRequestCreateBodySchema.parse({
    ...parsed.data,
    ...deadline,
    scope: null,
  });
  return {
    ok: true,
    body: {
      requestNumber: resolved.requestNumber,
      requesterName: resolved.requesterName,
      requesterOrganization: resolved.requesterOrganization,
      requesterContact: resolved.requesterContact,
      receivedAt: resolved.receivedAt,
      dueAt: deadline.dueAt,
      alternateDeadlineReason: deadline.alternateDeadlineReason,
    },
  };
}
