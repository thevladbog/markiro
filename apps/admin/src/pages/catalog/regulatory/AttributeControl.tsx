import { Input, Select, Button } from "@markiro/ui";
import { useTranslation } from "react-i18next";
import type { CategoryAttributeDefinition, ProductAttributeValue } from "@markiro/domain";
import { valueText } from "./value.js";
export function AttributeControl({
  definition: d,
  value,
  onChange,
  disabled,
  error,
}: {
  definition: CategoryAttributeDefinition;
  value: ProductAttributeValue | null;
  onChange: (value: ProductAttributeValue | null) => void;
  disabled: boolean;
  error?: string;
}) {
  const { t } = useTranslation();
  const p = "pages.catalog.regulatory.";
  const common = { label: d.label, disabled, ...(error ? { error } : {}) };
  const scalar = value && !Array.isArray(value.value) ? String(value.value) : "";
  switch (d.valueType) {
    case "boolean":
      return (
        <Select
          {...common}
          native
          value={scalar}
          options={[
            { value: "", label: t(p + "notSet") },
            { value: "true", label: t(p + "yes") },
            { value: "false", label: t(p + "no") },
          ]}
          onValueChange={(v) =>
            onChange(v === "" ? null : { type: "boolean", value: v === "true" })
          }
        />
      );
    case "enum":
      if (d.presetMode === "none")
        return (
          <Input
            {...common}
            value={scalar}
            onChange={(event) =>
              onChange(event.target.value ? { type: "enum", value: event.target.value } : null)
            }
          />
        );
      return (
        <div className="mk-regulatory-control">
          <Select
            {...common}
            native
            value={scalar}
            options={[
              { value: "", label: t(p + "notSet") },
              ...d.presets,
              ...(scalar && !d.presets.some((item) => item.value === scalar)
                ? [{ value: scalar, label: scalar }]
                : []),
            ]}
            onValueChange={(v) => onChange(v ? { type: "enum", value: v } : null)}
          />
          {d.presetMode === "suggested" && (
            <Input
              disabled={disabled}
              label={t(p + "customValue", { field: d.label })}
              value={scalar}
              onChange={(e) =>
                onChange(e.target.value ? { type: "enum", value: e.target.value } : null)
              }
            />
          )}
        </div>
      );
    case "decimal":
      return (
        <div className="mk-regulatory-quantity">
          <Input
            {...common}
            inputMode="decimal"
            value={scalar}
            onChange={(e) =>
              onChange({
                type: "decimal",
                value: e.target.value,
                unit: value?.type === "decimal" ? value.unit : null,
              })
            }
          />
          {d.unit && (
            <Select
              native
              disabled={disabled}
              label={t(p + "unit", { field: d.label })}
              value={value?.type === "decimal" ? (value.unit ?? "") : ""}
              options={[{ value: "", label: t(p + "notSet") }, ...d.unit.allowed]}
              onValueChange={(unit) =>
                onChange({ type: "decimal", value: scalar, unit: unit || null })
              }
            />
          )}
        </div>
      );
    case "date":
      return (
        <Input
          {...common}
          type="date"
          value={scalar}
          onChange={(e) =>
            onChange(e.target.value ? { type: "date", value: e.target.value } : null)
          }
        />
      );
    case "string":
      return (
        <Input
          {...common}
          value={scalar}
          onChange={(e) =>
            onChange(e.target.value ? { type: "string", value: e.target.value } : null)
          }
        />
      );
    case "string_list":
    case "enum_list": {
      const type = d.valueType;
      const items = value && Array.isArray(value.value) ? value.value : [];
      const displayed = items.length ? items : [""];
      const update = (next: string[]) => onChange(next.length ? { type, value: next } : null);
      return (
        <fieldset className="mk-regulatory-list" disabled={disabled}>
          <legend>{d.label}</legend>
          {error && <p role="alert">{error}</p>}
          {displayed.map((item, index) => (
            <div className="mk-regulatory-list-row" key={index}>
              {type === "enum_list" && d.presetMode === "restricted" ? (
                <Select
                  native
                  label={`${d.label} ${index + 1}`}
                  value={item}
                  options={[{ value: "", label: t(p + "notSet") }, ...d.presets]}
                  onValueChange={(v) => update(displayed.map((old, i) => (i === index ? v : old)))}
                />
              ) : (
                <Input
                  label={`${d.label} ${index + 1}`}
                  value={item}
                  onChange={(e) =>
                    update(displayed.map((old, i) => (i === index ? e.target.value : old)))
                  }
                />
              )}
              <Button
                type="button"
                variant="secondary"
                onClick={() => update(displayed.filter((_, i) => i !== index))}
              >
                {t(p + "removeValue", { index: index + 1 })}
              </Button>
            </div>
          ))}
          <Button type="button" variant="secondary" onClick={() => update([...displayed, ""])}>
            {t(p + "addValue")}
          </Button>
        </fieldset>
      );
    }
    default: {
      const exhaustive: never = d.valueType;
      return (
        <p>
          {exhaustive}
          {valueText(value, t)}
        </p>
      );
    }
  }
}
