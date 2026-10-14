import type { AlertTone } from "@markiro/ui";

import {
  LICENSE_FEATURE_KEYS,
  LICENSE_STATES,
  type OfficeLicense,
} from "../../../host/protocol.js";
import {
  lastMomentBefore,
  licenseDay,
  licenseDayMonth,
  licenseMinute,
} from "../../../lib/license-dates.js";

/** A text of the license section: an i18n key and its values. */
export interface LicenseText {
  key: string;
  values?: Record<string, string | number>;
}

const KNOWN_STATES: ReadonlySet<string> = new Set(LICENSE_STATES);
const KNOWN_PLANS: ReadonlySet<string> = new Set(["trial", "demo", "subscription"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The state in words; a valid demo file is «Демо-лицензия» (spec §3.4), and a
 * state a newer host adds is named as it is (the wire's state is a word).
 */
export function stateText(license: OfficeLicense): LicenseText {
  if (license.state === "active" && license.license?.plan === "demo") {
    return { key: "office.about.license.state.demo" };
  }
  // The host opens new shifts again for the extension: the word says so,
  // not «не открываются» above the extension's own line.
  if (
    emergencyRuns(license) &&
    (license.state === "restricted" || license.state === "trial_expired")
  ) {
    return { key: `office.about.license.state.${license.state}Emergency` };
  }
  return KNOWN_STATES.has(license.state)
    ? { key: `office.about.license.state.${license.state}` }
    : { key: "office.about.license.state.unknown", values: { state: license.state } };
}

/** Whether the emergency extension runs: the host opens new shifts by it now. */
function emergencyRuns(license: OfficeLicense): boolean {
  return license.emergency.until !== null && license.opensNewShifts;
}

/** The tone of the state: an error where no new shift opens or soon will not. */
export function stateTone(state: string): AlertTone {
  switch (state) {
    case "active":
      return "ok";
    case "trial":
      return "info";
    case "grace":
    case "restricted":
    case "trial_expired":
    case "inn_mismatch":
      return "error";
    default:
      // `expiring`, `wrong_host`, and a state a newer host adds.
      return "warn";
  }
}

/** The plan in words; a newer host's plan as it is. */
export function planText(plan: string): LicenseText {
  return KNOWN_PLANS.has(plan)
    ? { key: `office.about.license.plans.${plan}` }
    : { key: "office.about.license.plans.other", values: { plan } };
}

/**
 * Whether the site holds a subscription file: the owner's promise that its
 * next file is free (a subscription file lasts at most a year from its issue,
 * and the file does not say why its term ends, so every one gets the line).
 * Never a demo file, the trial, or a plan a newer cloud adds.
 */
function renewsFree(license: OfficeLicense): boolean {
  return license.license?.plan === "subscription";
}

/**
 * The states where a subscription's term is the matter, as on the band: a
 * file for another host or for another INN is not renewed for its term.
 */
const TERM_STATES: ReadonlySet<string> = new Set(["active", "expiring", "grace", "restricted"]);

/** The lines under the state: the term, the days left, the emergency (spec §9.2). */
export function licenseTerms(license: OfficeLicense, zone: string | null): LicenseText[] {
  const day = (end: string) => licenseDay(lastMomentBefore(end), zone);
  const file = license.license;
  const terms: LicenseText[] = [];
  switch (license.state) {
    case "trial":
      // The trial ends 14 days after the wizard began, at that time of day,
      // not at a midnight: its end is a moment, never «… включительно».
      if (license.trial !== null) {
        terms.push({
          key: "office.about.license.terms.trial",
          values: { until: licenseMinute(license.trial.endsAt, zone) },
        });
      }
      break;
    case "active":
    case "expiring":
      if (file !== null) {
        terms.push({
          key:
            file.plan === "demo"
              ? "office.about.license.terms.demo"
              : "office.about.license.terms.validThrough",
          values: { date: day(file.validUntil) },
        });
      }
      break;
    case "grace":
      if (file !== null && license.phaseEndsAt !== null) {
        terms.push({
          key: "office.about.license.terms.grace",
          values: {
            expired: licenseDayMonth(lastMomentBefore(file.validUntil), zone),
            until: day(license.phaseEndsAt),
          },
        });
      }
      break;
    case "wrong_host":
      terms.push(
        license.phaseEndsAt === null
          ? { key: "office.about.license.terms.wrongHostNoDate" }
          : {
              key: "office.about.license.terms.wrongHost",
              values: { date: day(license.phaseEndsAt) },
            },
      );
      break;
    case "restricted":
    case "trial_expired":
    case "inn_mismatch":
      // `since` is the moment the state began: no new shift opens from then,
      // unless the extension runs (its own line says until when).
      if (emergencyRuns(license)) break;
      terms.push({
        key: "office.about.license.terms.blockedSince",
        values: { date: licenseDay(license.since, zone) },
      });
      break;
  }
  const counts =
    license.state === "trial" || license.state === "expiring" || license.state === "grace";
  if (counts && license.daysLeft !== null) {
    terms.push({ key: "office.about.license.terms.daysLeft", values: { n: license.daysLeft } });
  }
  if (license.emergency.until !== null) {
    terms.push({
      key: emergencyRuns(license)
        ? "office.about.license.terms.emergency"
        : "office.about.license.terms.emergencyOver",
      values: { until: licenseMinute(license.emergency.until, zone) },
    });
  }
  if (renewsFree(license) && TERM_STATES.has(license.state)) {
    terms.push({ key: "office.about.license.terms.freeRenewal" });
  }
  return terms;
}

/** The quotas the host applies, in the order the section lists them; kiosks wait for a kiosk (spec §4.7). */
export const SHOWN_QUOTAS = ["stations", "cabinetUsers", "lines"] as const;

export interface QuotaRow {
  key: (typeof SHOWN_QUOTAS)[number];
  limit: number | null;
  used: number;
  over: boolean;
}

export function quotaRows(license: OfficeLicense): QuotaRow[] {
  return SHOWN_QUOTAS.map((key) => {
    const { limit, used, over } = license.quotas[key];
    return { key, limit, used, over };
  });
}

export function featureRows(license: OfficeLicense): { key: string; on: boolean }[] {
  return LICENSE_FEATURE_KEYS.map((key) => ({ key, on: license.features[key] }));
}

export type LicenseNoticeKind =
  | "trial"
  | "trialEnding"
  | "expiring"
  | "expiringDemo"
  | "grace"
  | "restricted"
  | "trialExpired"
  | "wrongHost"
  | "innMismatch"
  // The same three while the emergency extension runs: new shifts open by it.
  | "restrictedEmergency"
  | "trialExpiredEmergency"
  | "innMismatchEmergency"
  | "clockBehind"
  | "clockAhead";

/** A warning above the office's pages and on «Обзор» (spec §9.5). */
export interface LicenseNotice {
  kind: LicenseNoticeKind;
  tone: "info" | "warn" | "error";
  /** Hidden for the rest of the session by «Скрыть»; the serious ones never are. */
  dismissible: boolean;
}

function phaseNotice(license: OfficeLicense): LicenseNotice | null {
  // While the extension runs the host opens new shifts again, so the band
  // says until when instead of «не открываются»; still serious, never hidden.
  const extended = emergencyRuns(license);
  switch (license.state) {
    case "trial":
      return license.daysLeft !== null && license.daysLeft <= license.warnDays
        ? { kind: "trialEnding", tone: "warn", dismissible: true }
        : { kind: "trial", tone: "info", dismissible: true };
    case "expiring":
      return {
        kind: license.license?.plan === "demo" ? "expiringDemo" : "expiring",
        tone: "warn",
        dismissible: true,
      };
    case "grace":
      return { kind: "grace", tone: "error", dismissible: false };
    case "restricted":
      return {
        kind: extended ? "restrictedEmergency" : "restricted",
        tone: "error",
        dismissible: false,
      };
    case "trial_expired":
      return {
        kind: extended ? "trialExpiredEmergency" : "trialExpired",
        tone: "error",
        dismissible: false,
      };
    case "wrong_host":
      return { kind: "wrongHost", tone: "warn", dismissible: false };
    case "inn_mismatch":
      return {
        kind: extended ? "innMismatchEmergency" : "innMismatch",
        tone: "error",
        dismissible: false,
      };
    default:
      // `active`, and a state a newer host adds: the section names it.
      return null;
  }
}

/** The warnings of a license: its phase's, then the clock's. Nothing while all is well. */
export function licenseNotices(license: OfficeLicense): LicenseNotice[] {
  const notices: LicenseNotice[] = [];
  const phase = phaseNotice(license);
  if (phase !== null) notices.push(phase);
  if (license.flags.clockBehindDays !== null) {
    notices.push({ kind: "clockBehind", tone: "warn", dismissible: true });
  }
  if (license.flags.clockAhead) {
    notices.push({ kind: "clockAhead", tone: "warn", dismissible: true });
  }
  return notices;
}

/** Whether the warning writes a date, so the organization's zone has to be read for it. */
export function noticeNeedsTime(notice: LicenseNotice): boolean {
  return (
    notice.kind === "trialEnding" ||
    notice.kind === "expiring" ||
    notice.kind === "expiringDemo" ||
    notice.kind === "grace" ||
    notice.kind === "restrictedEmergency" ||
    notice.kind === "trialExpiredEmergency" ||
    notice.kind === "innMismatchEmergency"
  );
}

/** The words of a warning, its dates in `zone`. */
export function noticeText(
  notice: LicenseNotice,
  license: OfficeLicense,
  zone: string | null,
): LicenseText {
  const key = `office.banner.license.${notice.kind}`;
  const dayMonth = (end: string | null | undefined) =>
    end === null || end === undefined ? "—" : licenseDayMonth(lastMomentBefore(end), zone);
  switch (notice.kind) {
    case "trial":
      // Without the host's count of days, no number: «осталось 0 дн.» would be false.
      return license.daysLeft === null
        ? { key: "office.banner.license.trialNoDays" }
        : { key, values: { n: license.daysLeft } };
    case "trialEnding":
      // A moment (the wizard's time of day), not a last day.
      return {
        key,
        values: {
          until: license.trial === null ? "—" : licenseMinute(license.trial.endsAt, zone),
        },
      };
    case "expiring":
    case "expiringDemo":
      return {
        key,
        values: {
          date:
            license.license === null
              ? "—"
              : licenseDay(lastMomentBefore(license.license.validUntil), zone),
        },
      };
    case "grace":
      return {
        key,
        values: {
          expired: dayMonth(license.license?.validUntil),
          until: dayMonth(license.phaseEndsAt),
        },
      };
    case "restrictedEmergency":
    case "trialExpiredEmergency":
    case "innMismatchEmergency":
      return {
        key,
        values: {
          until:
            license.emergency.until === null ? "—" : licenseMinute(license.emergency.until, zone),
        },
      };
    case "clockBehind":
      return { key, values: { n: license.flags.clockBehindDays ?? 0 } };
    default:
      return { key };
  }
}

/** The warnings of a subscription's term: before its end, in the grace and after it. */
const FREE_RENEWAL_NOTICES: ReadonlySet<LicenseNoticeKind> = new Set([
  "expiring",
  "grace",
  "restricted",
  "restrictedEmergency",
]);

/**
 * The words that follow a warning's own: a subscription's warnings about its
 * term add that its next file is free (the owner's line); every other, nothing.
 */
export function noticeFreeRenewal(
  notice: LicenseNotice,
  license: OfficeLicense,
): LicenseText | null {
  return FREE_RENEWAL_NOTICES.has(notice.kind) && renewsFree(license)
    ? { key: "office.banner.license.freeRenewal" }
    : null;
}

/** The first eight characters of a license's id, never the whole id; «—» for anything else. */
export function shortLicenseId(id: string): string {
  return UUID.test(id) ? id.slice(0, 8).toLowerCase() : "—";
}
