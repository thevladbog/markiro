import {
  ENTITLEMENT_FEATURE_KEYS,
  ENTITLEMENT_QUOTA_KEYS,
  type EntitlementSourcePreview,
} from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";

/** Compare server facts verbatim; preparation does not replace current enforcement. */
export function EntitlementPreviewComparison({ preview }: { preview: EntitlementSourcePreview }) {
  const { t } = useTranslation();
  const flag = (value: boolean | null) =>
    t(`entitlements.${value === null ? "unknown" : value ? "enabled" : "disabled"}`);
  return (
    <table className="entitlement-preview-comparison">
      <caption>{t("entitlements.comparison")}</caption>
      <thead>
        <tr>
          <th scope="col">{t("entitlements.effects")}</th>
          <th scope="col">{t("entitlements.before")}</th>
          <th scope="col">{t("entitlements.after")}</th>
        </tr>
      </thead>
      <tbody>
        {ENTITLEMENT_QUOTA_KEYS.map((key) => (
          <tr key={key}>
            <th scope="row">{t(`entitlements.quotas.${key}`)}</th>
            {(["before", "after"] as const).map((side) => (
              <td key={side}>
                <strong>
                  {preview[side].candidate.quotas[key].used} /{" "}
                  {preview[side].candidate.quotas[key].limit ?? t("entitlements.unlimited")}
                </strong>
                <br />
                {t("entitlements.remaining", {
                  value:
                    preview[side].candidate.quotas[key].remaining ?? t("entitlements.unlimited"),
                })}
              </td>
            ))}
          </tr>
        ))}
        {ENTITLEMENT_FEATURE_KEYS.map((key) => (
          <tr key={key}>
            <th scope="row">{t(`entitlements.features.${key}`)}</th>
            <td>{flag(preview.before.candidate.features[key])}</td>
            <td>{flag(preview.after.candidate.features[key])}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
