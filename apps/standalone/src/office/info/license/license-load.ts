import { HostError } from "../../../host/client.js";
import { errorMessageKey } from "../../../host/errors.js";
import {
  LICENSE_FEATURE_KEYS,
  LICENSE_REFUSALS,
  MAX_LICENSE_FILE_BYTES,
  type LicensePreview,
  type LicenseTerms,
  type OfficeLicense,
} from "../../../host/protocol.js";
import { lastMomentBefore, licenseDay } from "../../../lib/license-dates.js";
import { planText, SHOWN_QUOTAS, type LicenseText } from "./license-view.js";

/** What the picker offers. */
export const LICENSE_FILE_ACCEPT = ".mklic";

export type LicenseFileRead =
  { kind: "text"; text: string } | { kind: "too_large" } | { kind: "unreadable" };

/** The file's text, trimmed; a file over the host's bound (16 KiB) is refused unread. */
export async function readLicenseFile(file: File): Promise<LicenseFileRead> {
  if (file.size > MAX_LICENSE_FILE_BYTES) return { kind: "too_large" };
  try {
    return { kind: "text", text: (await file.text()).trim() };
  } catch {
    return { kind: "unreadable" };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INN = /^\d{10}(?:\d{2})?$/;

function shortHost(value: unknown): string {
  return typeof value === "string" && UUID.test(value) ? value.slice(0, 8).toLowerCase() : "—";
}

/**
 * A refused preview or load in words (spec §9.7): a refusal of the file by
 * its reason, an unknown reason as a bad file, anything else (the rate
 * limit, the host away, a refusal of another field) by its code. The host
 * names only the file's host (`fileHostId`); the file's INN is said when a
 * host sends it (`fileInn`), and the newest file's number comes from `GET`.
 */
export function loadFailureText(error: unknown, current: OfficeLicense | undefined): LicenseText {
  if (
    !(error instanceof HostError) ||
    error.code !== "validation_failed" ||
    error.field !== "file"
  ) {
    return { key: errorMessageKey(error) };
  }
  const reason =
    LICENSE_REFUSALS.find((known) => known === error.details.reason) ?? "license_malformed";
  const key = `office.about.license.errors.${reason}`;
  const orgInn = current?.binding.orgInn ?? "—";
  switch (reason) {
    case "license_wrong_host":
      return {
        key,
        values: {
          fileHost: shortHost(error.details.fileHostId),
          thisHost: shortHost(current?.binding.hostId),
        },
      };
    case "license_older":
      return { key, values: { sequence: current?.license?.sequence ?? "—" } };
    case "license_inn_mismatch": {
      const fileInn = error.details.fileInn;
      return typeof fileInn === "string" && INN.test(fileInn)
        ? { key, values: { fileInn, orgInn } }
        : { key: `${key}_short`, values: { orgInn } };
    }
    default:
      return { key };
  }
}

/** One row of «было → станет»; `id` is the name the host's `changes` uses. */
export interface ComparisonRow {
  id: string;
  label: LicenseText;
  before: LicenseText;
  after: LicenseText;
  changed: boolean;
}

const DASH: LicenseText = { key: "office.about.license.load.none" };

function limitText(limit: number | null): LicenseText {
  return limit === null
    ? { key: "office.about.license.seats.unlimited" }
    : { key: "office.about.license.load.value", values: { value: limit } };
}

function featureText(on: boolean): LicenseText {
  return { key: on ? "office.about.license.features.on" : "office.about.license.features.off" };
}

/**
 * The table a file is loaded after (spec §4.8, §9.2): the plan, the last day,
 * the grace, the seats and the features, before and after, each row marked
 * when the host names it in `changes`. Before the first file the host
 * answers the trial's terms (`plan: "trial"`, no limits, every feature).
 */
export function comparisonRows(preview: LicensePreview, zone: string | null): ComparisonRow[] {
  const day = (end: string | null): LicenseText =>
    end === null
      ? DASH
      : {
          key: "office.about.license.load.value",
          values: { value: licenseDay(lastMomentBefore(end), zone) },
        };
  const grace = (n: number): LicenseText => ({
    key: "office.about.license.load.days",
    values: { n },
  });
  const columns = (terms: LicenseTerms) => ({
    plan: planText(terms.plan),
    validUntil: day(terms.validUntil),
    graceDays: grace(terms.graceDays),
  });
  const before = columns(preview.before);
  const after = columns(preview.after);
  const rows: Omit<ComparisonRow, "changed">[] = [
    {
      id: "plan",
      label: { key: "office.about.license.load.rows.plan" },
      before: before.plan,
      after: after.plan,
    },
    {
      id: "validUntil",
      label: { key: "office.about.license.load.rows.validUntil" },
      before: before.validUntil,
      after: after.validUntil,
    },
    {
      id: "graceDays",
      label: { key: "office.about.license.load.rows.graceDays" },
      before: before.graceDays,
      after: after.graceDays,
    },
    ...SHOWN_QUOTAS.map((key) => ({
      id: `quotas.${key}`,
      label: { key: `office.about.license.quotas.${key}` },
      before: limitText(preview.before.quotas[key].limit),
      after: limitText(preview.after.quotas[key].limit),
    })),
    ...LICENSE_FEATURE_KEYS.map((key) => ({
      id: `features.${key}`,
      label: { key: `office.about.license.features.${key}` },
      before: featureText(preview.before.features[key]),
      after: featureText(preview.after.features[key]),
    })),
  ];
  return rows.map((row) => ({ ...row, changed: preview.changes.includes(row.id) }));
}

/** A quota the file would leave below what is used now, as the host counted it. */
export interface OverLimit {
  key: (typeof SHOWN_QUOTAS)[number];
  used: number;
  limit: number;
}

export function overLimits(preview: LicensePreview): OverLimit[] {
  return SHOWN_QUOTAS.flatMap((key) => {
    const { limit, used, over } = preview.after.quotas[key];
    return over && limit !== null ? [{ key, used, limit }] : [];
  });
}

/** The host's other warnings of the checked file: already expired, not yet valid (spec §4.3). */
export function previewWarnings(preview: LicensePreview, zone: string | null): LicenseText[] {
  const { validFrom, validUntil } = preview.after;
  const warnings: LicenseText[] = [];
  if (preview.warnings.includes("expired") && validUntil !== null) {
    warnings.push({
      key: "office.about.license.load.expired",
      values: { date: licenseDay(lastMomentBefore(validUntil), zone) },
    });
  }
  if (preview.warnings.includes("not_yet_valid") && validFrom !== null) {
    warnings.push({
      key: "office.about.license.load.notYetValid",
      values: { date: licenseDay(validFrom, zone) },
    });
  }
  return warnings;
}

/**
 * What the page says after a load of the file whose terms were `loaded`: when
 * it begins (a file issued ahead waits for its start, spec §4.4), that it has
 * already ended, or till when it runs — by the host's effective time.
 */
export function loadedMessage(
  next: OfficeLicense,
  loaded: LicenseTerms,
  zone: string | null,
): { tone: "ok" | "warn"; text: LicenseText } {
  const now = Date.parse(next.effectiveAt);
  if (loaded.validFrom !== null && Date.parse(loaded.validFrom) > now) {
    return {
      tone: "ok",
      text: {
        key: "office.about.license.load.loadedLater",
        values: { date: licenseDay(loaded.validFrom, zone) },
      },
    };
  }
  if (loaded.validUntil === null) {
    return { tone: "ok", text: { key: "office.about.license.load.loadedNoDate" } };
  }
  const date = licenseDay(lastMomentBefore(loaded.validUntil), zone);
  return Date.parse(loaded.validUntil) <= now
    ? { tone: "warn", text: { key: "office.about.license.load.loadedExpired", values: { date } } }
    : { tone: "ok", text: { key: "office.about.license.load.loaded", values: { date } } };
}
