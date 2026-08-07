import type { KioskDto } from "./api.js";
import { resolveDateTimeLocale } from "../../lib/datetime.js";

export type KioskOperationalState = "archived" | "awaiting-pairing" | "online" | "offline";
export type KioskStateFilter = "all" | KioskOperationalState;

export const ONLINE_THRESHOLD_MS = 2 * 60 * 1000;

export function getKioskOperationalState(
  kiosk: Pick<KioskDto, "status" | "enrolled" | "lastSeenAt">,
  nowMs: number,
): KioskOperationalState {
  if (kiosk.status === "archived") return "archived";
  if (!kiosk.enrolled) return "awaiting-pairing";
  if (!kiosk.lastSeenAt) return "offline";
  return nowMs - new Date(kiosk.lastSeenAt).getTime() <= ONLINE_THRESHOLD_MS ? "online" : "offline";
}

export function formatRelativeLastSeen(iso: string, nowMs: number, language: string): string {
  const seconds = Math.round((new Date(iso).getTime() - nowMs) / 1000);
  const locale = resolveDateTimeLocale(language);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}
