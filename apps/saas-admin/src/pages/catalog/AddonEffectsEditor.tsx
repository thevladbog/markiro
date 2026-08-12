import { useTranslation } from "react-i18next";

import { Alert, Button, Input, Select } from "@markiro/ui";

import type { AddonEffect } from "./api.js";

export type EditableAddonEffect = {
  rowId: string;
  key: AddonEffect["key"];
  value: string;
};

const EFFECT_KEYS = [
  "lines",
  "stations",
  "kiosks",
  "cabinetUsers",
  "labelEditor",
  "publicApi",
  "pallets",
] as const satisfies readonly AddonEffect["key"][];

const QUOTA_EFFECT_KEYS = new Set<AddonEffect["key"]>([
  "lines",
  "stations",
  "kiosks",
  "cabinetUsers",
]);
const MAX_INTEGER = 2_147_483_647;

export function newAddonEffect(key: AddonEffect["key"] = "stations"): EditableAddonEffect {
  return { rowId: crypto.randomUUID(), key, value: QUOTA_EFFECT_KEYS.has(key) ? "1" : "" };
}

export function fromAddonEffects(effects: AddonEffect[]): EditableAddonEffect[] {
  return effects.map((effect) => ({
    rowId: crypto.randomUUID(),
    key: effect.key,
    value: "quotaIncrement" in effect ? String(effect.quotaIncrement) : "",
  }));
}

export function toAddonEffects(editable: EditableAddonEffect[]): AddonEffect[] {
  if (editable.length < 1 || editable.length > 7) throw new Error("effectRequired");
  const seen = new Set<AddonEffect["key"]>();
  return editable.map((effect) => {
    if (seen.has(effect.key)) throw new Error("effectDuplicate");
    seen.add(effect.key);
    if (!QUOTA_EFFECT_KEYS.has(effect.key)) {
      return {
        key: effect.key as "labelEditor" | "publicApi" | "pallets",
        featureEnabled: true as const,
      };
    }
    if (!/^[1-9]\d*$/.test(effect.value) || Number(effect.value) > MAX_INTEGER) {
      throw new Error("positive");
    }
    return {
      key: effect.key as "lines" | "stations" | "kiosks" | "cabinetUsers",
      quotaIncrement: Number(effect.value),
    };
  });
}

export function AddonEffectsEditor({
  effects,
  onChange,
  errors,
  listError,
  disabled = false,
}: {
  effects: EditableAddonEffect[];
  onChange: (effects: EditableAddonEffect[]) => void;
  errors?: Array<{ key?: string; value?: string }>;
  listError?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <fieldset className="addon-effects" aria-label={t("catalog.form.addonEffectGroup")}>
      <legend>{t("catalog.form.addonEffect")}</legend>
      {effects.map((effect, index) => {
        const quota = QUOTA_EFFECT_KEYS.has(effect.key);
        return (
          <div className="addon-effect-row" key={effect.rowId}>
            <Select
              label={t("catalog.form.effectKeyIndexed", { index: index + 1 })}
              value={effect.key}
              options={EFFECT_KEYS.map((key) => ({
                value: key,
                label: t(`catalog.effectNames.${key}`),
              }))}
              onValueChange={(key) =>
                onChange(
                  effects.map((entry) =>
                    entry.rowId === effect.rowId
                      ? {
                          ...entry,
                          key,
                          value: QUOTA_EFFECT_KEYS.has(key) ? entry.value || "1" : "",
                        }
                      : entry,
                  ),
                )
              }
              {...(errors?.[index]?.key ? { error: errors[index]?.key } : {})}
              disabled={disabled}
            />
            {quota ? (
              <Input
                label={t("catalog.form.effectValueIndexed", { index: index + 1 })}
                value={effect.value}
                onChange={(event) =>
                  onChange(
                    effects.map((entry) =>
                      entry.rowId === effect.rowId
                        ? { ...entry, value: event.target.value }
                        : entry,
                    ),
                  )
                }
                inputMode="numeric"
                {...(errors?.[index]?.value ? { error: errors[index]?.value } : {})}
                disabled={disabled}
              />
            ) : (
              <div className="feature-effect" role="status">
                {t("catalog.form.featureEnabled")}
              </div>
            )}
            <Button
              type="button"
              variant="secondary"
              disabled={disabled || effects.length === 1}
              aria-label={t("catalog.form.removeEffect", { index: index + 1 })}
              onClick={() => onChange(effects.filter((entry) => entry.rowId !== effect.rowId))}
            >
              {t("catalog.form.remove")}
            </Button>
          </div>
        );
      })}
      {listError ? <Alert tone="error">{listError}</Alert> : null}
      <Button
        type="button"
        variant="secondary"
        disabled={disabled || effects.length >= 7}
        onClick={() => onChange([...effects, newAddonEffect()])}
      >
        {t("catalog.form.addEffect")}
      </Button>
    </fieldset>
  );
}
