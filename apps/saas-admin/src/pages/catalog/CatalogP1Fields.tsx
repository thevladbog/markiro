import { P1_FEATURE_KEYS, type EntitlementFeatureKey } from "@markiro/platform-contracts";
import { Alert, Select } from "@markiro/ui";
import { useTranslation } from "react-i18next";
export type P1DraftFeatures = Record<(typeof P1_FEATURE_KEYS)[number], boolean | null>;
export const UNKNOWN_P1_FEATURES: P1DraftFeatures = {
  chzIntegration: null,
  inventory: null,
  commerceMl: null,
  handheld: null,
};
export function CatalogP1Fields({
  values,
  policyId,
  policies,
  onFeatureChange,
  onPolicyChange,
  disabled = false,
}: {
  values: P1DraftFeatures | null;
  policyId: string | null;
  policies: readonly { id: string; policyKey: string; version: number }[];
  onFeatureChange: (
    key: Exclude<EntitlementFeatureKey, "labelEditor" | "publicApi" | "pallets">,
    value: boolean | null,
  ) => void;
  onPolicyChange: (id: string | null) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <fieldset disabled={disabled}>
      <legend>{t("entitlements.candidate")}</legend>
      {values
        ? P1_FEATURE_KEYS.map((key) => (
            <Select
              key={key}
              label={t(`entitlements.features.${key}`)}
              value={values[key] === null ? "unknown" : String(values[key])}
              onValueChange={(value) =>
                onFeatureChange(key, value === "unknown" ? null : value === "true")
              }
              options={[
                { value: "unknown", label: t("entitlements.unknown") },
                { value: "true", label: t("entitlements.enabled") },
                { value: "false", label: t("entitlements.disabled") },
              ]}
            />
          ))
        : null}
      {values && P1_FEATURE_KEYS.some((key) => values[key] === null) ? (
        <Alert tone="info">{t("entitlements.mappingRequired")}</Alert>
      ) : null}
      <Select
        label={t("entitlements.policy")}
        value={policyId ?? ""}
        onValueChange={(value) => onPolicyChange(value || null)}
        options={[
          { value: "", label: t("entitlements.policySelect") },
          ...policies.map((policy) => ({
            value: policy.id,
            label: `${policy.policyKey} · v${policy.version}`,
          })),
        ]}
      />
      {!policies.some((policy) => policy.id === policyId) ? (
        <Alert tone="info">{t("entitlements.policyMissing")}</Alert>
      ) : null}
    </fieldset>
  );
}
