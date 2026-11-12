import type { DisaggregationReportVariant } from "../../host/disaggregation.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";

export interface DisaggregationReportSource {
  scope: "document" | "shift";
  id: string;
  number: string;
}

export function useDisaggregationReport(
  { scope, id }: DisaggregationReportSource,
  variant: DisaggregationReportVariant,
) {
  return useOfficeQuery(
    scope === "shift"
      ? officeKeys.shiftDisaggregationReport(id, variant)
      : officeKeys.disaggregationReport(id, variant),
    (api, token) =>
      scope === "shift"
        ? api.getShiftDisaggregationReportRows(token, id, variant)
        : api.getDisaggregationReportRows(token, id, variant),
  );
}
