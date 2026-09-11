import { useTranslation } from "react-i18next";
import { Select } from "@markiro/ui";
import type { SellerTaxPolicy } from "@markiro/platform-contracts";
export function formatVat(
  rateBps: number | null,
  included: boolean,
  t: (key: string, options?: { rate: string }) => string,
): string {
  return rateBps === null
    ? t("catalog.vat.without")
    : t(included ? "catalog.vat.included" : "catalog.vat.excluded", {
        rate: String(rateBps / 100),
      });
}
export function CatalogVatField({
  value,
  onChange,
  policy,
  error,
  disabled = false,
}: {
  value: number | null;
  onChange: (rate: number | null) => void;
  policy: SellerTaxPolicy | null | undefined;
  error?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const rates = policy?.kind === "vat" ? policy.allowedRatesBps : [];
  const options =
    policy?.kind === "without_vat"
      ? [{ value: "none", label: t("catalog.vat.without") }]
      : rates.map((rate) => ({
          value: String(rate),
          label: t("catalog.vat.option", { rate: rate / 100 }),
        }));
  const selected = value === null ? "none" : String(value);
  if (!options.some((option) => option.value === selected))
    options.unshift({
      value: selected,
      label: t("catalog.vat.unavailable", {
        rate: value === null ? t("catalog.vat.without") : `${value / 100}%`,
      }),
    });
  return (
    <div className="catalog-vat-field">
      <Select
        label={t("catalog.form.vat")}
        value={selected}
        options={options}
        onValueChange={(next) => onChange(next === "none" ? null : Number(next))}
        disabled={disabled || !policy}
        {...(error ? { error } : {})}
        required
      />
      {!policy ? <span className="catalog-field-hint">{t("catalog.policyRequired")}</span> : null}
    </div>
  );
}
