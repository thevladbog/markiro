import { HostError } from "../../host/client.js";
import type { UsageMonth, UsageStats } from "../../host/usage-stats.js";
import { encryptSupportPayload } from "./support-crypto.js";
import { activeSupportKey, type SupportKeyset } from "./support-keys.js";
import type { SupportBlock } from "./support-report.js";
import type { SupportContext } from "./support-blocks.js";

/** The version of the statistics' JSON, for the one who reads it. */
export const USAGE_PAYLOAD_VERSION = 1;

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
 * host, and the host's counts, copied field by field. A field the host's
 * answer holds beyond these (it is read loosely) cannot reach it; no name,
 * code, hash, SSCC, path or secret has a place here.
 */
export function usagePayload(
  stats: UsageStats,
  about: { generatedAt: Date; appVersion: string | null; hostVersion: string | null },
): string {
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
  });
}

/**
 * The contributor of the usage statistics (`SUPPORT_CONTRIBUTORS`): a block
 * with a short neutral label and the encrypted token, or one line saying why
 * there are no statistics (no key in this build, not an administrator, the
 * host did not answer). Never plaintext counts.
 */
export function createUsageContributor(keyset: SupportKeyset) {
  return async (context: SupportContext): Promise<SupportBlock | null> => {
    const { t, facts } = context;
    const title = t("office.about.support.usage.title");
    const said = (reason: string): SupportBlock => ({
      title,
      lines: [[t("office.about.support.usage.label"), t(`office.about.support.usage.${reason}`)]],
    });
    const key = activeSupportKey(keyset);
    if (key === null) return said("noKey");
    if (context.usage === undefined) return null;
    if (context.usage.kind === "forbidden") return said("adminOnly");
    if (context.usage.kind === "failed") return said("hostFailed");
    const stats = context.usage.stats;
    const payload = usagePayload(stats, {
      generatedAt: facts.generatedAt,
      appVersion: facts.appVersion,
      hostVersion: facts.hostVersion,
    });
    let opaque: string;
    try {
      opaque = await encryptSupportPayload(payload, key);
    } catch {
      return said("encryptFailed");
    }
    const first = stats.months[0]?.month;
    const last = stats.months.at(-1)?.month;
    return {
      title,
      lines: [
        [
          t("office.about.support.usage.label"),
          t("office.about.support.usage.encrypted", {
            from: first ?? "—",
            to: last ?? "—",
          }),
        ],
      ],
      opaque,
    };
  };
}
