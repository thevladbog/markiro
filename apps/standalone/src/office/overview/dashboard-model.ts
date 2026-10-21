import type { BackupState } from "../../host/backups.js";
import type { ExportSettings } from "../../host/export-files.js";
import type {
  DeviceRecord,
  OfficeLicense,
  OfficeLine,
  OfficeProduct,
  OfficeShift,
  OrgProfile,
} from "../../host/protocol.js";
import { shiftProductTitle } from "../../lib/shift-product.js";
import { backupWarnings, warningTone } from "../backups/backup-warnings.js";
import { stateText, stateTone } from "../info/license/license-view.js";
import { lineMaxStations } from "../../host/requests.js";
import { activeParticipants } from "../shifts/participation.js";
import { shiftUnits } from "../shifts/shift-list.js";
import { formatWhen } from "../backups/backup-format.js";
import {
  CLOCK_SKEW_MS,
  clockSkewMs,
  isOnline,
  type ReasonMissingShift,
  shiftProgress,
  type SilentParticipant,
  storeNearlyFull,
} from "./overview-model.js";
import { recentCivilDays } from "./overview-time.js";

// The pure reading of the host's lists behind «Обзор» (phase 1: nothing but what the office
// already reads). A figure of a DAY is by the shift's own civil date (`plannedDate`), the
// organization's day, never by UTC or by this PC's zone; an INSTANT (`lastFactAt`, `openedAt`)
// is only ever compared with another instant. No code, SSCC or operator is read here.

/** A line or a shift with no fact for longer than this is idle (owner's decision, 10 minutes). */
export const IDLE_AFTER_MS = 10 * 60 * 1000;
/** A pace says nothing before a shift has run this long. */
export const MIN_PACE_MS = 10 * 60 * 1000;
/** The lines the overview shows as cards; the rest is «+N». */
export const MAX_LINE_CARDS = 3;
const HOUR_MS = 3_600_000;
const NUMBER = new Intl.NumberFormat("ru-RU");

export interface DayFigures {
  date: string;
  units: number;
  boxes: number;
  pallets: number;
  /** Shifts of the day that have begun. */
  shifts: number;
}

/** What the shifts of the civil day `date` that have begun (not planned) put out. */
export function dayFigures(shifts: readonly OfficeShift[], date: string): DayFigures {
  const figures: DayFigures = { date, units: 0, boxes: 0, pallets: 0, shifts: 0 };
  for (const shift of shifts) {
    if (shift.status === "planned" || shift.plannedDate !== date) continue;
    figures.units += shiftUnits(shift);
    figures.boxes += shift.totals.closedBoxes;
    figures.pallets += shift.totals.closedPallets;
    figures.shifts += 1;
  }
  return figures;
}

/** The last `count` days' figures, oldest first, the last one `today`. */
export function recentDays(shifts: readonly OfficeShift[], today: string, count = 7): DayFigures[] {
  return recentCivilDays(today, count).map((date) => dayFigures(shifts, date));
}

export interface ChartScale {
  step: number;
  top: number;
}

/**
 * The axis of the chart: the smallest step of 1, 2 or 5 times a power of ten that needs at most
 * four intervals, and the top that many whole steps above the highest value.
 */
export function chartScale(max: number): ChartScale {
  if (max <= 0) return { step: 1_000, top: 3_000 };
  const exponent = Math.floor(Math.log10(max));
  for (const power of [exponent - 1, exponent, exponent + 1]) {
    for (const base of [1, 2, 5]) {
      const step = base * 10 ** power;
      if (step >= 1 && max / step <= 4) return { step, top: Math.ceil(max / step) * step };
    }
  }
  const step = 10 ** (exponent + 1);
  return { step, top: Math.ceil(max / step) * step };
}

export interface SignedDifference {
  /** `+663`, `−337`, `0`: the sign is in the text, so the colour is never alone. */
  text: string;
  direction: "up" | "down" | "same";
}

/** `current − previous`, written with its sign. */
export function signedDifference(current: number, previous: number): SignedDifference {
  const diff = current - previous;
  if (diff === 0) return { text: "0", direction: "same" };
  return diff > 0
    ? { text: `+${NUMBER.format(diff)}`, direction: "up" }
    : { text: `−${NUMBER.format(-diff)}`, direction: "down" };
}

export interface Duration {
  unit: "minutes" | "hours" | "days";
  count: number;
}

/** A span in the biggest whole unit: minutes below an hour, hours below two days, then days. */
export function formatDuration(ms: number): Duration {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return { unit: "minutes", count: Math.max(0, minutes) };
  const hours = Math.floor(ms / HOUR_MS);
  if (hours < 48) return { unit: "hours", count: hours };
  return { unit: "days", count: Math.floor(hours / 24) };
}

export type LineStatus = "running" | "idle" | "none";

export interface LineCard {
  line: OfficeLine;
  status: LineStatus;
  /** The shift at work on the line, the most recently opened one. */
  shift: OfficeShift | null;
  /** The product's print name (the shift's title), `null` without a shift. */
  productTitle: string | null;
  done: number;
  planned: number | null;
  percent: number | null;
  /** Units per hour, the average since the shift opened; `null` while that says nothing. */
  paceHourly: number | null;
  /** When the plan is met at that pace (an instant, ms); `null` without a plan, a pace, or when met. */
  etaAt: number | null;
  /** Whole minutes without a fact, for an idle line. */
  idleMinutes: number | null;
  /**
   * The devices at work in the shift against the line's limit (plan 2b); `null` for a line of one, a
   * line with no shift and a host before protocol 7, which name no participants.
   */
  stations: { active: number; max: number } | null;
  /** For a line without a shift: the last shift of it closed, and the next one planned. */
  lastClosed: OfficeShift | null;
  nextPlanned: OfficeShift | null;
}

const byName = (a: string, b: string) => a.localeCompare(b, "ru", { numeric: true });
const STATUS_ORDER: Record<LineStatus, number> = { idle: 0, running: 1, none: 2 };

function openedMs(shift: OfficeShift): number {
  return shift.openedAt === null ? 0 : Date.parse(shift.openedAt);
}

function cardFor(
  line: OfficeLine,
  shifts: readonly OfficeShift[],
  products: readonly OfficeProduct[],
  nowMs: number,
  today: string,
  revoked: ReadonlySet<string>,
): LineCard {
  const own = shifts.filter((shift) => shift.lineId === line.id);
  const shift =
    own.filter((each) => each.status === "active").sort((a, b) => openedMs(b) - openedMs(a))[0] ??
    null;
  const lastClosed =
    own
      .filter((each) => each.status === "closed")
      .sort((a, b) => Date.parse(b.closedAt ?? "") - Date.parse(a.closedAt ?? ""))[0] ?? null;
  const nextPlanned =
    own
      .filter((each) => each.status === "planned" && each.plannedDate >= today)
      .sort(
        (a, b) => a.plannedDate.localeCompare(b.plannedDate) || byName(a.number, b.number),
      )[0] ?? null;
  if (shift === null) {
    return {
      line,
      status: "none",
      shift: null,
      productTitle: null,
      done: 0,
      planned: null,
      percent: null,
      paceHourly: null,
      etaAt: null,
      idleMinutes: null,
      stations: null,
      lastClosed,
      nextPlanned,
    };
  }
  const progress = shiftProgress(shift);
  const factAt = Date.parse(shift.totals.lastFactAt ?? shift.openedAt ?? "");
  const silent = Number.isNaN(factAt) ? 0 : nowMs - factAt;
  const idle = silent > IDLE_AFTER_MS;
  const elapsed = shift.openedAt === null ? 0 : nowMs - Date.parse(shift.openedAt);
  const paceHourly =
    elapsed >= MIN_PACE_MS && progress.done > 0
      ? Math.round(progress.done / (elapsed / HOUR_MS))
      : null;
  const etaAt =
    !idle && paceHourly !== null && progress.planned !== null && progress.done < progress.planned
      ? nowMs + Math.round(((progress.planned - progress.done) / paceHourly) * HOUR_MS)
      : null;
  const product = products.find((each) => each.id === shift.productId);
  const limit = lineMaxStations(line);
  const stations =
    shift.participants === undefined || limit <= 1
      ? null
      : { active: activeParticipants(shift, revoked).length, max: limit };
  return {
    line,
    status: idle ? "idle" : "running",
    shift,
    productTitle: shiftProductTitle(product) || null,
    done: progress.done,
    planned: progress.planned,
    percent: progress.percent,
    paceHourly,
    etaAt,
    idleMinutes: idle ? Math.floor(silent / 60_000) : null,
    stations,
    lastClosed,
    nextPlanned,
  };
}

/**
 * The cards of the lines. When there are more than `MAX_LINE_CARDS`, the most pressing ones are
 * picked (idle, then running, then without a shift, by name within a group) and the rest is
 * counted; the ones shown always stand in the order of their names, so a card does not jump when
 * a status changes. `all` is every card, the order of the picking (the attention list counts the
 * idle ones among them). An archived line is drawn only while a shift of it is at work.
 */
export function lineCards(
  shifts: readonly OfficeShift[],
  lines: readonly OfficeLine[],
  products: readonly OfficeProduct[],
  nowMs: number,
  today: string,
  revoked: ReadonlySet<string> = new Set(),
): { cards: LineCard[]; hidden: number; all: LineCard[] } {
  const all = lines
    .map((line) => cardFor(line, shifts, products, nowMs, today, revoked))
    .filter((card) => !card.line.archived || card.shift !== null)
    .sort(
      (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || byName(a.line.name, b.line.name),
    );
  return {
    cards: all.slice(0, MAX_LINE_CARDS).sort((a, b) => byName(a.line.name, b.line.name)),
    hidden: Math.max(0, all.length - MAX_LINE_CARDS),
    all,
  };
}

export interface ShiftDayRow {
  /** Shifts at work (only asked of «Сегодня»: they are at work whatever their date). */
  active: number;
  planned: number;
  closed: number;
  /** The sum of the planned shifts' plans; `null` when none has one. */
  planSum: number | null;
}

/** The counts of the shifts of a civil day by phase. */
export function shiftDayRow(
  shifts: readonly OfficeShift[],
  date: string,
  withActive: boolean,
): ShiftDayRow {
  const row: ShiftDayRow = {
    active: withActive ? shifts.filter((shift) => shift.status === "active").length : 0,
    planned: 0,
    closed: 0,
    planSum: null,
  };
  for (const shift of shifts) {
    if (shift.plannedDate !== date) continue;
    if (shift.status === "closed") row.closed += 1;
    if (shift.status === "planned") {
      row.planned += 1;
      if (shift.plannedQty !== null) row.planSum = (row.planSum ?? 0) + shift.plannedQty;
    }
  }
  return row;
}

export type AttentionKind =
  | "conflicts"
  | "device_silent"
  | "backup"
  | "license"
  | "clock_skew"
  | "store_full"
  | "line_idle"
  | "participant_silent"
  | "close_reason_missing";

export type AttentionSeverity = "err" | "warn" | "info";

/** One row of «Требует внимания»; the same shape a host `attention` endpoint would answer (phase 2). */
export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  severity: AttentionSeverity;
  titleKey: string;
  titleValues: Record<string, string | number>;
  detailKey: string | null;
  detailValues: Record<string, string | number>;
  /** Where the action leads; `null` where there is nowhere to go. */
  to: string | null;
  actionKey: string | null;
}

export interface AttentionInput {
  /** The unreviewed conflicts; `oldestDetectedAt` only when every one of them is on the page read. */
  conflicts: { total: number; oldestDetectedAt: string | null } | null;
  /** `null` for a role that cannot read devices, or while they are not read. */
  devices: readonly DeviceRecord[] | null;
  backups: BackupState | null;
  license: OfficeLicense | null;
  settings: ExportSettings | null;
  idleLines: readonly { lineName: string; shiftId: string; minutes: number }[];
  /**
   * Active participants of a line of several devices not heard for ten minutes (plan 2b): each is one
   * row, and takes the place of the plain silent-device row of the same device.
   */
  silentParticipants?: readonly SilentParticipant[];
  /** Closed shifts the host marked as closed without the reason (plan 2b). */
  reasonMissing?: readonly ReasonMissingShift[];
  /** The host's clock (a device's age is measured by it), and this PC's. */
  nowMs: number;
  pcNowMs: number;
  /** Writes an instant in the organization's zone. */
  format?: (instant: string) => string;
}

const SEVERITY_ORDER: Record<AttentionSeverity, number> = { err: 0, warn: 1, info: 2 };

/**
 * What needs a person, most serious first: conflicts waiting, devices not heard for more than
 * ten minutes, the copies, the license, the clocks, the store of files, an
 * idle line, a participant of a shared shift silent for ten minutes, a shift closed without its reason (app versions are never compared: the office, stations and handhelds have their own). Built here from what the office reads; a host endpoint may take the rules over.
 */
export function attentionItems(input: AttentionInput): AttentionItem[] {
  const format = input.format ?? ((instant: string) => formatWhen(instant, null));
  const items: AttentionItem[] = [];
  const { conflicts } = input;
  if (conflicts !== null && conflicts.total > 0) {
    const age =
      conflicts.oldestDetectedAt === null
        ? null
        : formatDuration(input.nowMs - Date.parse(conflicts.oldestDetectedAt));
    items.push({
      id: "conflicts",
      kind: "conflicts",
      severity: "err",
      titleKey: "office.overview.attention.conflicts.title",
      titleValues: { count: conflicts.total },
      detailKey: age === null ? null : "office.overview.attention.conflicts.oldest",
      detailValues: age === null ? {} : { unit: age.unit, count: age.count },
      to: "/conflicts",
      actionKey: "office.overview.attention.conflicts.action",
    });
  }
  const covered = new Set((input.silentParticipants ?? []).map((each) => each.deviceId));
  if (input.devices !== null) {
    const silent = input.devices
      .filter(
        (device) =>
          device.revokedAt === null && !isOnline(device, input.nowMs) && !covered.has(device.id),
      )
      .sort(
        (a, b) =>
          (a.lastSeenAt === null ? -Infinity : Date.parse(a.lastSeenAt)) -
          (b.lastSeenAt === null ? -Infinity : Date.parse(b.lastSeenAt)),
      );
    for (const device of silent) {
      if (device.lastSeenAt === null) {
        items.push({
          id: `device-${device.id}`,
          kind: "device_silent",
          severity: "warn",
          titleKey: "office.overview.attention.device.neverTitle",
          titleValues: { name: device.name },
          detailKey: "office.overview.attention.device.neverDetail",
          detailValues: {},
          to: "/devices",
          actionKey: "office.overview.attention.device.action",
        });
        continue;
      }
      const span = formatDuration(input.nowMs - Date.parse(device.lastSeenAt));
      items.push({
        id: `device-${device.id}`,
        kind: "device_silent",
        severity: "warn",
        titleKey: "office.overview.attention.device.title",
        titleValues: { name: device.name, unit: span.unit, count: span.count },
        detailKey: "office.overview.attention.device.detail",
        detailValues: { when: format(device.lastSeenAt) },
        to: "/devices",
        actionKey: "office.overview.attention.device.action",
      });
    }
  }
  for (const each of input.silentParticipants ?? []) {
    const span = formatDuration(input.nowMs - Date.parse(each.since));
    items.push({
      id: `participant-${each.shiftId}-${each.deviceId}`,
      kind: "participant_silent",
      severity: "warn",
      titleKey: "office.overview.attention.participant.title",
      titleValues: { name: each.name, unit: span.unit, count: span.count },
      detailKey: "office.overview.attention.participant.detail",
      detailValues: { shift: each.shiftNumber, line: each.lineName },
      to: `/shifts?shift=${encodeURIComponent(each.shiftId)}&tab=stations`,
      actionKey: "office.overview.attention.participant.action",
    });
  }
  for (const each of input.reasonMissing ?? []) {
    items.push({
      id: `close-reason-${each.shiftId}`,
      kind: "close_reason_missing",
      severity: "warn",
      titleKey: "office.overview.attention.closeReason.title",
      titleValues: { number: each.number },
      detailKey: "office.overview.attention.closeReason.detail",
      detailValues: {},
      to: `/shifts?shift=${encodeURIComponent(each.shiftId)}`,
      actionKey: "office.overview.attention.closeReason.action",
    });
  }
  if (input.backups !== null) {
    const warning = backupWarnings(input.backups)[0];
    if (warning !== undefined) {
      items.push({
        id: "backup",
        kind: "backup",
        severity: warningTone(warning) === "error" ? "err" : "warn",
        titleKey: `office.overview.attention.backup.${warning.kind}`,
        titleValues: {},
        detailKey: null,
        detailValues: {},
        to: "/backups",
        actionKey: "office.overview.attention.backup.action",
      });
    }
  }
  if (input.license !== null) {
    const tone = stateTone(input.license.state);
    if (tone === "error" || tone === "warn") {
      const text = stateText(input.license);
      items.push({
        id: "license",
        kind: "license",
        severity: tone === "error" ? "err" : "warn",
        titleKey: text.key,
        titleValues: text.values ?? {},
        detailKey: null,
        detailValues: {},
        to: "/about#license",
        actionKey: "office.overview.attention.license.action",
      });
    }
  }
  const skew = clockSkewMs(
    input.backups?.now ?? new Date(input.nowMs).toISOString(),
    input.pcNowMs,
  );
  if (input.backups !== null && Math.abs(skew) > CLOCK_SKEW_MS) {
    items.push({
      id: "clock",
      kind: "clock_skew",
      severity: "warn",
      titleKey: "office.overview.attention.clock.title",
      titleValues: { minutes: Math.round(Math.abs(skew) / 60_000) },
      detailKey: "office.overview.attention.clock.detail",
      detailValues: {},
      to: null,
      actionKey: null,
    });
  }
  if (input.settings !== null && storeNearlyFull(input.settings)) {
    items.push({
      id: "store",
      kind: "store_full",
      severity: "warn",
      titleKey: "office.overview.attention.store.title",
      titleValues: {
        percent: Math.round((input.settings.storedBytes / input.settings.maxStoredBytes) * 100),
      },
      detailKey: "office.overview.attention.store.detail",
      detailValues: {},
      to: null,
      actionKey: null,
    });
  }
  for (const line of input.idleLines) {
    items.push({
      id: `line-${line.shiftId}`,
      kind: "line_idle",
      severity: "warn",
      titleKey: "office.overview.attention.lineIdle.title",
      titleValues: { line: line.lineName },
      detailKey: "office.overview.attention.lineIdle.detail",
      detailValues: { unit: "minutes", count: line.minutes },
      to: `/shifts?shift=${encodeURIComponent(line.shiftId)}`,
      actionKey: "office.overview.attention.lineIdle.action",
    });
  }
  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.item.severity] - SEVERITY_ORDER[b.item.severity] || a.index - b.index,
    )
    .map(({ item }) => item);
}

export type FirstStepId = "profile" | "line" | "station" | "products" | "shift";

export interface FirstStep {
  id: FirstStepId;
  /** `null`: not known (the role cannot read the devices). */
  done: boolean | null;
}

/** The checklist of a site that has just been set up, from what the office reads. */
export function firstSteps(input: {
  org: OrgProfile | null;
  lines: readonly OfficeLine[];
  devices: readonly DeviceRecord[] | null;
  products: readonly OfficeProduct[];
  shifts: readonly OfficeShift[];
}): FirstStep[] {
  return [
    { id: "profile", done: input.org !== null && input.org.name.trim() !== "" },
    { id: "line", done: input.lines.some((line) => !line.archived) },
    {
      id: "station",
      done:
        input.devices === null
          ? null
          : input.devices.some((device) => device.kind === "station" && device.revokedAt === null),
    },
    { id: "products", done: input.products.some((product) => !product.archived) },
    { id: "shift", done: input.shifts.length > 0 },
  ];
}
