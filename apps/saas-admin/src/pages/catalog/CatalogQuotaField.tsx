import { Input, Select } from "@markiro/ui";
import { useTranslation } from "react-i18next";

/** Empty is unlimited; the explicit sentinel preserves an unfilled finite quota. */
export function CatalogQuotaField({
  label,
  value,
  onChange,
  error,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
}) {
  const { t } = useTranslation();
  const mode = value === "" ? "unlimited" : value === "0" ? "none" : "limited";
  return (
    <div className="catalog-quota-field">
      <Select
        label={t("catalog.quota.mode", { label })}
        value={mode}
        options={(["none", "limited", "unlimited"] as const).map((value) => ({
          value,
          label: t(`catalog.quota.${value}`),
        }))}
        onValueChange={(next) =>
          onChange(next === "none" ? "0" : next === "unlimited" ? "" : "__limited__")
        }
      />
      {mode === "limited" ? (
        <Input
          label={label}
          inputMode="numeric"
          value={value === "__limited__" ? "" : value}
          onChange={(event) => onChange(event.target.value || "__limited__")}
          {...(error ? { error } : {})}
        />
      ) : null}
    </div>
  );
}
