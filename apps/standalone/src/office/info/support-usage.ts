import type { InstallRole } from "../../host/device.js";
import { HostError } from "../../host/client.js";
import {
  LICENSE_FEATURE_KEYS,
  LICENSE_QUOTA_KEYS,
  type OfficeLicense,
} from "../../host/protocol.js";
import type { UsageMonth, UsageStats } from "../../host/usage-stats.js";
import { encryptSupportPayload } from "./support-crypto.js";
import { activeSupportKey, type SupportKeyset } from "./support-keys.js";
import { safeValue, type SupportBlock } from "./support-report.js";
import type { SupportContext } from "./support-blocks.js";

/** The version of the statistics' JSON, for the one who reads it. */
export const USAGE_PAYLOAD_VERSION = 2;

/** How the page learned the statistics: the host's counts, or why there are none. */
export type UsageLoad =
  { kind: "ok"; stats: UsageStats } | { kind: "forbidden" } | { kind: "failed" };

/** The answer of `getUsageStats` as `UsageLoad` says it. */
export function usageLoadOf(result: PromiseSettledResult<UsageStats>): UsageLoad {
  if (result.status === "fulfilled") return { kind: "ok", stats: result.value };
  const error: unknown = result.reason;
  return error instanceof HostError && error.code === "forbidden"
    ? { kind: "forbidden" }
    : { kind: "failed" };
}

/** How the page learned the license: the host's answer, or why there is none. */
export type LicenseLoad =
  { kind: "ok"; license: OfficeLicense } | { kind: "forbidden" } | { kind: "failed" };

/** The answer of `getLicense` as `LicenseLoad` says it. */
export function licenseLoadOf(result: PromiseSettledResult<OfficeLicense>): LicenseLoad {
  if (result.status === "fulfilled") return { kind: "ok", license: result.value };
  const error: unknown = result.reason;
  return error instanceof HostError && error.code === "forbidden"
    ? { kind: "forbidden" }
    : { kind: "failed" };
}

/** The license summary, field by field: never the customer, the INN, the fingerprint or the file. */
function pickLicense(license: OfficeLicense) {
  const file = license.license;
  const quota = (key: (typeof LICENSE_QUOTA_KEYS)[number]) => ({
    limit: license.quotas[key].limit,
    used: license.quotas[key].used,
    over: license.quotas[key].over,
  });
  return {
    state: license.state,
    plan: file?.plan ?? null,
    licenseId: file?.licenseId.toLowerCase() ?? null,
    sequence: file?.sequence ?? null,
    kid: file?.kid ?? null,
    validFrom: file?.validFrom ?? null,
    validUntil: file?.validUntil ?? null,
    graceDays: file?.graceDays ?? null,
    daysLeft: license.daysLeft,
    quotas: Object.fromEntries(LICENSE_QUOTA_KEYS.map((key) => [key, quota(key)])),
    features: Object.fromEntries(LICENSE_FEATURE_KEYS.map((key) => [key, license.features[key]])),
    innMatches: license.binding.innMatches,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const system = (value: string | null): string | null => {
  if (value === null) return null;
  const text = safeValue(value);
  return text === "" ? null : text;
};

export interface UsagePayloadAbout {
  generatedAt: Date;
  appVersion: string | null;
  hostVersion: string | null;
  hostId: string | null;
  role: InstallRole | "unknown";
  os: string | null;
  arch: string | null;
  webview: string | null;
  license: OfficeLicense | null;
}

/** One month, field by field: the allowlist of what the statistics may say. */
function pickMonth(month: UsageMonth) {
  return {
    month: month.month,
    shifts: {
      aggregation: month.shifts.aggregation,
      validation: month.shifts.validation,
      validationPrint: month.shifts.validationPrint,
      fromOffice: month.shifts.fromOffice,
      fromStation: month.shifts.fromStation,
      withPallets: month.shifts.withPallets,
    },
    scans: {
      accepted: month.scans.accepted,
      duplicates: month.scans.duplicates,
      rejected: month.scans.rejected,
    },
    boxes: {
      closed: month.boxes.closed,
      disassembled: month.boxes.disassembled,
      codes: month.boxes.codes,
    },
    pallets: { closed: month.pallets.closed, disassembled: month.pallets.disassembled },
    exceptions: {
      boxUndo: month.exceptions.boxUndo,
      boxClear: month.exceptions.boxClear,
      boxReprint: month.exceptions.boxReprint,
      boxDisassemble: month.exceptions.boxDisassemble,
      palletReprint: month.exceptions.palletReprint,
      palletDisassemble: month.exceptions.palletDisassemble,
    },
    conflicts: {
      late: month.conflicts.late,
      displaced: month.conflicts.displaced,
      reviewed: month.conflicts.reviewed,
    },
    reprints: { warehouse: month.reprints.warehouse, unitLabel: month.reprints.unitLabel },
    disaggregationApplied: month.disaggregationApplied,
    syncRejected: month.syncRejected,
  };
}

/**
 * What is encrypted: the generation instant, the versions of the app and the
 * host, the host's id, the PC role, the system (OS, architecture, WebView2), a
 * license summary and the host's counts, copied field by field. A field the host's
 * answer holds beyond these (it is read loosely) cannot reach it; no name,
 * code, hash, SSCC, path or secret has a place here.
 */
export function usagePayload(stats: UsageStats, about: UsagePayloadAbout): string {
  return JSON.stringify({
    v: USAGE_PAYLOAD_VERSION,
    generatedAt: about.generatedAt.toISOString(),
    appVersion: about.appVersion,
    hostVersion: about.hostVersion,
    months: stats.months.map(pickMonth),
    devices: {
      station: stats.devices.station,
      office: stats.devices.office,
      handheld: stats.devices.handheld,
    },
    hostId: about.hostId !== null && UUID.test(about.hostId) ? about.hostId.toLowerCase() : null,
    role: about.role === "unknown" ? null : about.role,
    os: system(about.os),
    arch: system(about.arch),
    webview: system(about.webview),
    license: about.license === null ? null : pickLicense(about.license),
  });
}

/** Shared encrypted allowlist for support text and activation exports. */
export async function createUsageToken(
  stats: UsageStats,
  about: UsagePayloadAbout,
  keyset: SupportKeyset,
): Promise<string | null> {
  const key = activeSupportKey(keyset);
  if (key === null) return null;
  try {
    return await encryptSupportPayload(usagePayload(stats, about), key);
  } catch {
    return null;
  }
}

/**
 * The contributor of the usage statistics (`SUPPORT_CONTRIBUTORS`): a block
 * titled «Данные для анализа» with the line «Зашифрованные данные» and the
 * token under it, or «Отсутствуют» when there is none (no key in this build,
 * not an administrator, the host did not answer; the text gives no reason).
 * Never plaintext counts.
 */
export function createUsageContributor(keyset: SupportKeyset) {
  return async (context: SupportContext): Promise<SupportBlock | null> => {
    const { t, facts } = context;
    const title = t("office.about.support.usage.title");
    // One neutral line whatever the reason (no key, not an administrator, no answer): the text
    // names no technical cause.
    const absent = (): SupportBlock => ({
      title,
      lines: [["", t("office.about.support.usage.absent")]],
    });
    const key = activeSupportKey(keyset);
    if (key === null) return absent();
    if (context.usage === undefined) return null;
    if (context.usage.kind === "forbidden") return absent();
    if (context.usage.kind === "failed") return absent();
    const stats = context.usage.stats;
    const license = context.license?.kind === "ok" ? context.license.license : null;
    const opaque = await createUsageToken(
      stats,
      {
        generatedAt: facts.generatedAt,
        appVersion: facts.appVersion,
        hostVersion: facts.hostVersion,
        hostId: facts.hostId,
        role: facts.role,
        os: facts.os,
        arch: facts.arch,
        webview: facts.webview,
        license,
      },
      keyset,
    );
    if (opaque === null) return absent();
    return {
      title,
      lines: [["", t("office.about.support.usage.encrypted")]],
      opaque,
    };
  };
}
