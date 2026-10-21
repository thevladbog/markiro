import type { SyncState } from "../app/shell.js";
import type { HostStatus } from "../host/protocol.js";
import type { ScannerIndicator } from "./scanner-indicator.js";

/**
 * The floor header's chips (kit: one component for every screen of the floor, board `SgyS0` of
 * station-signin-setup): a glyph and a word on a tone, never a bare dot. This file is the pure
 * part: which chips a screen shows, what each state says, and what gives way when the row does
 * not fit. `FloorStatusBar` draws them.
 */

export type ChipTone = "ok" | "warn" | "error" | "neutral";

/** The glyphs the header draws (`kit/StatusIcons`). */
export type ChipIcon =
  "wifi-high" | "wifi-medium" | "wifi-slash" | "printer" | "barcode" | "plugs" | "upload" | "stock";

export type ChipKind =
  | "link"
  | "printer"
  | "scanner"
  | "queue"
  | "rejected"
  | "conflicts"
  | "displaced"
  | "stranded"
  | "stock"
  | "demo";

/** The three kinds of floor screen the header tells apart. */
export type HeaderScreen = "sign-in" | "hub" | "work";

/**
 * The always-present chips of a screen: sign-in has no operator and no printer to speak of;
 * the hub, the setup and the forms show the link, the printer and the scanner (the queue is the
 * hub's footer button); the work screen adds the queue.
 */
export function chipKinds(screen: HeaderScreen): ChipKind[] {
  switch (screen) {
    case "sign-in":
      return ["link", "scanner"];
    case "hub":
      return ["link", "printer", "scanner"];
    case "work":
      return ["link", "printer", "scanner", "queue"];
  }
}

/** One chip: its tone and glyph, and the key of its words under `floor.chips.<kind>.<text>`. */
export interface HeaderChip {
  kind: ChipKind;
  tone: ChipTone;
  icon: ChipIcon;
  text: string;
  /** A count the words carry (`{{n}}`). */
  n?: number;
}

export function linkChip(status: HostStatus | null, sync: SyncState | null): HeaderChip {
  if (status === null) return { kind: "link", tone: "neutral", icon: "wifi-high", text: "pending" };
  if (status.state === "offline") {
    return { kind: "link", tone: "warn", icon: "wifi-slash", text: "none" };
  }
  if (status.state === "connecting") {
    return { kind: "link", tone: "warn", icon: "wifi-medium", text: "weak" };
  }
  const unwell = (sync?.failure ?? null) !== null || (sync?.quarantined ?? 0) > 0;
  return unwell
    ? { kind: "link", tone: "warn", icon: "wifi-medium", text: "attention" }
    : { kind: "link", tone: "ok", icon: "wifi-high", text: "ok" };
}

/**
 * The printer as far as the station can honestly know it: it does not probe a printer, so the
 * chip is an error while a label of the shift waits failed or unknown, and «not set» when the
 * workstation has no printer at all.
 */
export function printerChip(state: { configured: boolean; failed: boolean }): HeaderChip {
  if (state.failed) return { kind: "printer", tone: "error", icon: "printer", text: "error" };
  if (!state.configured) {
    return { kind: "printer", tone: "neutral", icon: "printer", text: "none" };
  }
  return { kind: "printer", tone: "ok", icon: "printer", text: "ok" };
}

export function scannerChip(indicator: ScannerIndicator): HeaderChip {
  switch (indicator) {
    case "keyboard":
    case "connected":
      return { kind: "scanner", tone: "ok", icon: "barcode", text: "ready" };
    case "partial":
      return { kind: "scanner", tone: "warn", icon: "barcode", text: "partial" };
    case "disconnected":
      return { kind: "scanner", tone: "error", icon: "plugs", text: "disconnected" };
    case "unknown":
      return { kind: "scanner", tone: "warn", icon: "barcode", text: "unknown" };
  }
}

/** «Очередь N» (quiet at 0, a warning while something waits or a send fails) and «Отклонено N». */
export function queueChips(state: {
  unsent: number;
  rejected: number;
  failing: boolean;
}): HeaderChip[] {
  const chips: HeaderChip[] = [
    {
      kind: "queue",
      tone: state.unsent > 0 || state.failing ? "warn" : "neutral",
      icon: "upload",
      text: "count",
      n: state.unsent,
    },
  ];
  if (state.rejected > 0) {
    chips.push({
      kind: "rejected",
      tone: "error",
      icon: "upload",
      text: "count",
      n: state.rejected,
    });
  }
  return chips;
}

/** What gives way, in order: 0 everything; 1 healthy chips lose their words; 2 «Сменить оператора» is an icon. */
export type CollapseLevel = 0 | 1 | 2;
const LAST_LEVEL: CollapseLevel = 2;

/** The work screen's four chips never have room for all their words: its healthy ones start at 1. */
export function minCollapseLevel(screen: HeaderScreen): CollapseLevel {
  return screen === "work" ? 1 : 0;
}

/** Widths of the header row, in px, as the browser laid them out. */
export interface BarMeasure {
  barWidth: number;
  /** The chips, the sync and window buttons and the operator button (they never shrink). */
  railWidth: number;
  /** The identity's text at its natural width. */
  identityWidth: number;
  /** The space between the identity and the rail, plus the bar's padding. */
  gap: number;
}

/** The identity takes at most this much: a longer name is cut with an ellipsis. */
export const IDENTITY_CAP = 360;

export function overflows(measure: BarMeasure): boolean {
  return (
    Math.min(measure.identityWidth, IDENTITY_CAP) + measure.gap + measure.railWidth >
    measure.barWidth
  );
}

/** One step per measurement: the next level when the row overflows, never under the screen's minimum. */
export function nextCollapseLevel(
  level: CollapseLevel,
  measure: BarMeasure,
  min: CollapseLevel,
): CollapseLevel {
  const floor = Math.max(level, min) as CollapseLevel;
  if (!overflows(measure) || floor >= LAST_LEVEL) return floor;
  return (floor + 1) as CollapseLevel;
}

/** Healthy chips (ok, neutral) collapse to a glyph; a warning or an error keeps its words. */
export function chipForm(level: CollapseLevel, tone: ChipTone): "full" | "icon" {
  return level >= 1 && (tone === "ok" || tone === "neutral") ? "icon" : "full";
}

export function operatorForm(level: CollapseLevel): "text" | "icon" {
  return level >= 2 ? "icon" : "text";
}
