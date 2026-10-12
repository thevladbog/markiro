import { resolveUsRequestDeadline } from "@markiro/domain";

type WallCandidate = { instant: string; offsetSeconds: number };
type WallResolution =
  { kind: "invalid" | "gap" } | { kind: "unique" | "fold"; candidates: readonly WallCandidate[] };

const minimumInstant = Date.parse("0001-01-01T00:00:00.000Z");
const maximumInstant = Date.parse("9999-12-31T23:59:59.999Z");

function wallFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
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
  });
}

function formattedWall(formatter: Intl.DateTimeFormat, epoch: number): string {
  const parts = formatter.formatToParts(epoch);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((value) => value.type === type)?.value ?? "";
  return `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}.${part("fractionalSecond")}`;
}

export function resolveRequestWallTime(wall: string, timeZone: string): WallResolution {
  if (/^[+-]/.test(timeZone) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/.test(wall))
    return { kind: "invalid" };
  const wallEpoch = Date.parse(`${wall}Z`);
  if (
    !Number.isFinite(wallEpoch) ||
    wallEpoch < minimumInstant ||
    wallEpoch > maximumInstant ||
    new Date(wallEpoch).toISOString() !== `${wall}Z`
  )
    return { kind: "invalid" };

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = wallFormatter(timeZone);
  } catch {
    return { kind: "invalid" };
  }
  const offsets = new Set<number>();
  for (let hour = -36; hour <= 36; hour++) {
    const sample = wallEpoch + hour * 3_600_000;
    if (sample < minimumInstant || sample > maximumInstant) continue;
    const localEpoch = Date.parse(`${formattedWall(formatter, sample)}Z`);
    if (Number.isFinite(localEpoch)) offsets.add((localEpoch - sample) / 1000);
  }

  const candidates: WallCandidate[] = [];
  let outsideDomain = false;
  for (const offsetSeconds of offsets) {
    const epoch = wallEpoch - offsetSeconds * 1000;
    if (formattedWall(formatter, epoch) !== wall) continue;
    const instant = new Date(epoch).toISOString();
    try {
      // Validate the candidate as a due instant when possible, so the final day
      // stays representable. Receipt capacity is checked by the timing form.
      const precedingDay = epoch - 86_400_000;
      if (precedingDay < minimumInstant) resolveUsRequestDeadline(instant);
      else resolveUsRequestDeadline(new Date(precedingDay).toISOString(), instant);
      candidates.push({ instant, offsetSeconds });
    } catch {
      outsideDomain = true;
    }
  }
  if (outsideDomain) return { kind: "invalid" };
  if (candidates.length === 0) return { kind: "gap" };
  candidates.sort((left, right) => Date.parse(left.instant) - Date.parse(right.instant));
  return { kind: candidates.length === 1 ? "unique" : "fold", candidates };
}

export function requestCountdown(
  dueAt: string,
  closedAt: string | null,
  nowMs: number,
): { kind: "neutral" | "attention" | "overdue" | "closed"; milliseconds: number } {
  const milliseconds = Date.parse(dueAt) - (closedAt === null ? nowMs : Date.parse(closedAt));
  const kind =
    closedAt !== null
      ? "closed"
      : milliseconds < 0
        ? "overdue"
        : milliseconds < 14_400_000
          ? "attention"
          : "neutral";
  return { kind, milliseconds };
}

export function formatRequestInstant(
  instant: string,
  timeZone: string,
  language: "en-US" | "es-US",
): string {
  const formatter = new Intl.DateTimeFormat(language, {
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
    timeZoneName: "longOffset",
  });
  const date = new Date(instant);
  return `${formatter.format(date)} (${timeZone}; UTC ${date.toISOString()})`;
}
