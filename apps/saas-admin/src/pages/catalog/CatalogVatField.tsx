import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Input, Select } from "@markiro/ui";

const CUSTOM = "custom";
const NONE = "none";
const VAT_PRESETS = [null, 0, 500, 700, 1000, 2000, 2200] as const;
const VAT_PRESET_RATES = [0, 500, 700, 1000, 2000, 2200] as const;
const VAT_PATTERN = /^(?:100(?:\.0{1,2})?|\d{1,2}(?:\.\d{1,2})?)$/;

function percentFromBasisPoints(value: number): string {
  return (value / 100).toFixed(value % 100 === 0 ? 0 : 2);
}

export function formatVat(
  rateBps: number | null,
  included: boolean,
  t: (key: string, options?: { rate: string }) => string,
): string {
  if (rateBps === null || !included) return t("catalog.vat.without");
  return t("catalog.vat.included", { rate: percentFromBasisPoints(rateBps) });
}

export function CatalogVatField({
  value,
  onChange,
  error,
  disabled = false,
}: {
  value: number | null;
  onChange: (rate: number | null) => void;
  error?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const isPreset =
    value === null || VAT_PRESET_RATES.includes(value as (typeof VAT_PRESET_RATES)[number]);
  const [customValue, setCustomValue] = useState(
    value !== null && !isPreset ? percentFromBasisPoints(value) : "",
  );
  const [selection, setSelection] = useState<string | null>(null);

  useEffect(() => {
    if (
      selection === null &&
      value !== null &&
      !VAT_PRESET_RATES.includes(value as (typeof VAT_PRESET_RATES)[number])
    ) {
      setCustomValue(percentFromBasisPoints(value));
    }
  }, [selection, value]);

  const selected = selection ?? (value === null ? NONE : isPreset ? String(value) : CUSTOM);
  const emitCustom = (next: string) => {
    setCustomValue(next);
    if (VAT_PATTERN.test(next)) onChange(Math.round(Number(next) * 100));
  };

  return (
    <div className="catalog-vat-field">
      <Select
        label={t("catalog.form.vat")}
        native
        value={selected}
        options={[
          { value: NONE, label: t("catalog.vat.without") },
          ...VAT_PRESET_RATES.map((rate) => ({
            value: String(rate),
            label: t("catalog.vat.option", { rate: percentFromBasisPoints(rate) }),
          })),
          { value: CUSTOM, label: t("catalog.vat.customRate") },
        ]}
        onValueChange={(next) => {
          setSelection(next);
          if (next === NONE) onChange(null);
          else if (next === CUSTOM) {
            if (customValue && VAT_PATTERN.test(customValue)) {
              onChange(Math.round(Number(customValue) * 100));
            }
          } else onChange(Number(next));
        }}
        {...(error ? { error } : {})}
        disabled={disabled}
        required
      />
      {selected === CUSTOM ? (
        <Input
          label={t("catalog.form.vatRate")}
          value={customValue}
          onChange={(event) => emitCustom(event.target.value)}
          {...(error ? { error } : {})}
          disabled={disabled}
          inputMode="decimal"
          required
        />
      ) : null}
      <span className="catalog-field-hint">
        {value === null ? t("catalog.vat.without") : t("catalog.vat.includedHint")}
      </span>
    </div>
  );
}

export const catalogVatPresets = VAT_PRESETS;
