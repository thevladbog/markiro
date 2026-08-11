import { useTranslation } from "react-i18next";

import { Input, Select } from "@markiro/ui";

import type { CatalogVersionDto } from "./api.js";

const RECURRING_UNITS = ["month", "year"] as const;
const SERVICE_UNITS = [
  "unit",
  "hour",
  "person",
  "person_day",
  "day",
  "project",
  "session",
  "package",
] as const;
const OTHER = "__other__";

export function CatalogUnitField({
  kind,
  value,
  onChange,
  error,
  disabled = false,
}: {
  kind: CatalogVersionDto["kind"];
  value: string;
  onChange: (unit: string) => void;
  error?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const presets = kind === "service" ? SERVICE_UNITS : RECURRING_UNITS;
  const isPreset = (presets as readonly string[]).includes(value);
  const selected = isPreset ? value : OTHER;

  return (
    <div className="catalog-unit-field">
      <Select
        label={t("catalog.form.unit")}
        native
        value={selected}
        options={[
          ...presets.map((unit) => ({ value: unit, label: t(`catalog.units.${unit}`) })),
          { value: OTHER, label: t("catalog.units.other") },
        ]}
        onValueChange={(next) => onChange(next === OTHER ? (isPreset ? "" : value) : next)}
        {...(error ? { error } : {})}
        disabled={disabled}
        required
      />
      {selected === OTHER ? (
        <Input
          label={t("catalog.form.customUnit")}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          {...(error ? { error } : {})}
          disabled={disabled}
          required
        />
      ) : null}
    </div>
  );
}

export const catalogUnitPresets = {
  recurring: RECURRING_UNITS,
  service: SERVICE_UNITS,
} as const;
