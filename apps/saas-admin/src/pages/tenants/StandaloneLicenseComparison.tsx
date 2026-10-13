import { useTranslation } from "react-i18next";
import { Badge } from "@markiro/ui";
import {
  ENTITLEMENT_FEATURE_KEYS,
  ENTITLEMENT_QUOTA_KEYS,
  type StandaloneIssuancePreview,
} from "@markiro/platform-contracts";

import { useStandaloneDate } from "./standalone-format.js";

/** «Было → станет» in the look of EntitlementPreviewComparison (plan Д15). */
export function StandaloneLicenseComparison({ preview }: { preview: StandaloneIssuancePreview }) {
  const { t } = useTranslation();
  const formatDate = useStandaloneDate();
  const before = preview.previous;
  const after = preview.next;
  const prefix = "tenants.detail.standalone";
  const none = t(`${prefix}.issue.none`);
  const quota = (value: number | null) =>
    value === null ? t(`${prefix}.issue.unlimited`) : String(value);
  const flag = (value: boolean) => t(`${prefix}.issue.${value ? "enabled" : "disabled"}`);
  const unmapped = new Set(
    preview.warnings.flatMap((warning) =>
      warning.code === "feature_unmapped" ? [warning.feature] : [],
    ),
  );
  const belowUsage = new Set(
    preview.warnings.flatMap((warning) =>
      warning.code === "quota_below_usage" ? [warning.quota] : [],
    ),
  );
  return (
    <table className="entitlement-preview-comparison">
      <caption>{t(`${prefix}.issue.comparison`)}</caption>
      <thead>
        <tr>
          <th scope="col">{t("entitlements.effects")}</th>
          <th scope="col">{t(`${prefix}.issue.before`)}</th>
          <th scope="col">{t(`${prefix}.issue.after`)}</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <th scope="row">{t(`${prefix}.issue.row.sequence`)}</th>
          <td>{before ? before.sequence : none}</td>
          <td>{after.sequence}</td>
        </tr>
        <tr>
          <th scope="row">{t(`${prefix}.issue.row.source`)}</th>
          <td>{before ? t(`${prefix}.source.${before.source}`) : none}</td>
          <td>{t(`${prefix}.source.${after.source}`)}</td>
        </tr>
        <tr>
          <th scope="row">{t(`${prefix}.issue.row.plan`)}</th>
          <td>{before ? t(`${prefix}.plan.${before.plan}`) : none}</td>
          <td>{t(`${prefix}.plan.${after.plan}`)}</td>
        </tr>
        <tr>
          <th scope="row">{t(`${prefix}.issue.row.validUntil`)}</th>
          <td>{before ? formatDate(before.validUntil) : none}</td>
          <td>
            {formatDate(after.validUntil)} ({t(`${prefix}.issue.reason.${after.validUntilReason}`)})
          </td>
        </tr>
        <tr>
          <th scope="row">{t(`${prefix}.issue.row.graceDays`)}</th>
          <td>{before ? before.graceDays : none}</td>
          <td>{after.graceDays}</td>
        </tr>
        {ENTITLEMENT_QUOTA_KEYS.map((key) => (
          <tr key={key}>
            <th scope="row">{t(`entitlements.quotas.${key}`)}</th>
            <td>{before ? quota(before.rights.quotas[key]) : none}</td>
            <td>
              {quota(after.rights.quotas[key])}
              {belowUsage.has(key) ? (
                <>
                  {" "}
                  <Badge tone="warn">{t(`${prefix}.issue.belowUsage`)}</Badge>
                </>
              ) : null}
            </td>
          </tr>
        ))}
        {ENTITLEMENT_FEATURE_KEYS.map((key) => (
          <tr key={key}>
            <th scope="row">{t(`entitlements.features.${key}`)}</th>
            <td>{before ? flag(before.rights.features[key]) : none}</td>
            <td>
              {flag(after.rights.features[key])}
              {unmapped.has(key) ? (
                <>
                  {" "}
                  <Badge tone="warn">{t(`${prefix}.issue.unmapped`)}</Badge>
                </>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
