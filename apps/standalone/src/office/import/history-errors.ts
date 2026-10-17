import type { TFunction } from "i18next";
import { UnsupportedHistoryTimeZoneError } from "./history-time-zone.js";
import { HostError } from "../../host/client.js";
import { errorMessageKey } from "../../host/errors.js";
const CONSTRAINTS = new Set([
  "history_source",
  "history_time_zone_unsupported",
  "org_gln",
  "history_site_not_empty",
  "history_batch_changed",
  "history_part_changed",
  "history_duplicate",
  "history_incomplete",
  "history_counts",
  "history_graph",
  "history_cancelled",
  "history_missing",
  "history_already_complete",
  "history_counter",
  "history_counter_overflow",
  "cloud_history_pending",
  "SHIFT_DATE_MISSING",
  "history_composition_unavailable",
]);
/** Fixed messages only: neither server message nor an untrusted field value is rendered. */
export function historyFailure(t: TFunction, error: unknown): string {
  if (error instanceof UnsupportedHistoryTimeZoneError)
    return t("office.cloudHistory.errors.history_time_zone_unsupported");
  if (error instanceof HostError && error.kind === "api") {
    if (error.code === "forbidden") return t("office.cloudHistory.adminRequired");
    const constraint = error.details.constraint;
    if (typeof constraint === "string" && CONSTRAINTS.has(constraint))
      return t(`office.cloudHistory.errors.${constraint}`);
  }
  return t(errorMessageKey(error));
}
