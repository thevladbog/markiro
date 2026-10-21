import { LANDING_LEAD_DIGEST_SECTIONS, type LandingLeadDigestSection } from "@markiro/email";
import type { LandingLeadStatus } from "@markiro/platform-contracts";

/** Digest days are civil days in Moscow: the digest goes out at 09:00 MSK (06:00 UTC). */
export const LEAD_DIGEST_TIME_ZONE = "Europe/Moscow";

export type LeadDigestSections<T> = Record<LandingLeadDigestSection, T[]>;

export interface LeadDigestCandidate {
  id: string;
  company: string;
  status: LandingLeadStatus;
  createdAt: Date;
  statusChangedAt: Date;
  nextTouchAt: Date | null;
  firstDownloadAt: Date | null;
}

const DAY_MS = 86_400_000;

export function civilDate(value: Date, timeZone = LEAD_DIGEST_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** `YYYY-MM-DD` minus whole days, in the civil calendar. */
export function minusDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) - days));
  return shifted.toISOString().slice(0, 10);
}

/**
 * The sections of the daily digest (spec §15.5), in order:
 * - `new_uncontacted` — `new`, created more than a day ago;
 * - `day_3` — first download three civil days ago, still `new` or `contacted`;
 * - `day_10` — first download ten civil days ago (four days before the trial ends);
 * - `touch_due` — next touch today or earlier;
 * - `invoice_unpaid` — `invoice_sent` for more than seven days.
 * Won, lost and anonymized leads never appear, and a lead whose next touch lies after
 * today leaves the digest until that day («Написал»).
 */
export function selectDigestSections(
  candidates: readonly LeadDigestCandidate[],
  now: Date,
): LeadDigestSections<LeadDigestCandidate> {
  const today = civilDate(now);
  const day3 = minusDays(today, 3);
  const day10 = minusDays(today, 10);
  const sections = Object.fromEntries(
    LANDING_LEAD_DIGEST_SECTIONS.map((section) => [section, [] as LeadDigestCandidate[]]),
  ) as LeadDigestSections<LeadDigestCandidate>;
  for (const lead of candidates) {
    if (lead.status === "won" || lead.status === "lost") continue;
    const touch = lead.nextTouchAt === null ? null : civilDate(lead.nextTouchAt);
    if (touch !== null && touch > today) continue;
    const download = lead.firstDownloadAt === null ? null : civilDate(lead.firstDownloadAt);
    if (lead.status === "new" && now.getTime() - lead.createdAt.getTime() > DAY_MS) {
      sections.new_uncontacted.push(lead);
    }
    if (download === day3 && (lead.status === "new" || lead.status === "contacted")) {
      sections.day_3.push(lead);
    }
    if (download === day10) sections.day_10.push(lead);
    if (touch !== null) sections.touch_due.push(lead);
    if (
      lead.status === "invoice_sent" &&
      now.getTime() - lead.statusChangedAt.getTime() > 7 * DAY_MS
    ) {
      sections.invoice_unpaid.push(lead);
    }
  }
  return sections;
}

export function digestIsEmpty<T>(sections: LeadDigestSections<T>): boolean {
  return LANDING_LEAD_DIGEST_SECTIONS.every((section) => sections[section].length === 0);
}
