import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Alert, Button, Checkbox, ConfirmDialog, Input, StatusChip } from "@markiro/ui";

import {
  publishCatalogVersion,
  setDefaultDemoPlan,
  updateCatalogVersion,
  type AddonEffect,
  type CatalogVersionDto,
  type CatalogVersionPatch,
  type PlanEntitlements,
} from "./api.js";

interface CatalogFormValues {
  nameRu: string;
  nameEn: string;
  unit: string;
  unitPrice: string;
  maxLines: string;
  maxStations: string;
  maxKiosks: string;
  maxCabinetUsers: string;
  demoDurationDays: string;
  labelEditorEnabled: boolean;
  publicApiEnabled: boolean;
  palletsEnabled: boolean;
  addonEffectKey: AddonEffect["key"];
  addonEffectValue: string;
}

const QUOTA_EFFECT_KEYS = new Set<AddonEffect["key"]>([
  "lines",
  "stations",
  "kiosks",
  "cabinetUsers",
]);

function numericOrNull(value: string): number | null {
  return value.trim() === "" ? null : Number(value);
}

function formDefaults(item: CatalogVersionDto): CatalogFormValues {
  const firstEffect = item.addon?.effects[0];
  return {
    nameRu: item.nameRu,
    nameEn: item.nameEn,
    unit: item.unit,
    unitPrice: item.unitPrice ?? "",
    maxLines: String(item.plan?.maxLines ?? ""),
    maxStations: String(item.plan?.maxStations ?? ""),
    maxKiosks: String(item.plan?.maxKiosks ?? ""),
    maxCabinetUsers: String(item.plan?.maxCabinetUsers ?? ""),
    demoDurationDays: String(item.plan?.demoDurationDays ?? ""),
    labelEditorEnabled: item.plan?.labelEditorEnabled ?? false,
    publicApiEnabled: item.plan?.publicApiEnabled ?? false,
    palletsEnabled: item.plan?.palletsEnabled ?? false,
    addonEffectKey: firstEffect?.key ?? "stations",
    addonEffectValue:
      firstEffect && "quotaIncrement" in firstEffect ? String(firstEffect.quotaIncrement) : "1",
  };
}

function patchForKind(item: CatalogVersionDto, values: CatalogFormValues): CatalogVersionPatch {
  const common: CatalogVersionPatch = {
    nameRu: values.nameRu,
    nameEn: values.nameEn,
    unit: values.unit,
  };
  if (item.unitPrice !== undefined) common.unitPrice = values.unitPrice;
  if (item.kind === "plan") {
    const plan: PlanEntitlements = {
      maxLines: numericOrNull(values.maxLines),
      maxStations: numericOrNull(values.maxStations),
      maxKiosks: numericOrNull(values.maxKiosks),
      maxCabinetUsers: numericOrNull(values.maxCabinetUsers),
      demoDurationDays: numericOrNull(values.demoDurationDays),
      labelEditorEnabled: values.labelEditorEnabled,
      publicApiEnabled: values.publicApiEnabled,
      palletsEnabled: values.palletsEnabled,
    };
    return { ...common, plan };
  }
  if (item.kind === "addon") {
    const effect: AddonEffect = QUOTA_EFFECT_KEYS.has(values.addonEffectKey)
      ? {
          key: values.addonEffectKey as "lines" | "stations" | "kiosks" | "cabinetUsers",
          quotaIncrement: Number(values.addonEffectValue),
        }
      : {
          key: values.addonEffectKey as "labelEditor" | "publicApi" | "pallets",
          featureEnabled: true,
        };
    return { ...common, addon: { effects: [effect] } };
  }
  return { ...common, service: {} };
}

function quotaSummary(
  item: CatalogVersionDto,
  t: (key: string, options?: Record<string, unknown>) => string,
) {
  if (item.plan) {
    return [
      item.plan.maxLines === null
        ? t("catalog.unlimitedLines")
        : t("catalog.lines", { count: item.plan.maxLines }),
      item.plan.maxStations === null
        ? t("catalog.unlimitedStations")
        : t("catalog.stations", { count: item.plan.maxStations }),
      item.plan.maxKiosks === null
        ? t("catalog.unlimitedKiosks")
        : t("catalog.kiosks", { count: item.plan.maxKiosks }),
    ];
  }
  if (item.addon) {
    return item.addon.effects.map((effect) =>
      "quotaIncrement" in effect
        ? t(`catalog.effects.${effect.key}`, { count: effect.quotaIncrement })
        : t(`catalog.effects.${effect.key}`),
    );
  }
  return [t("catalog.serviceEffect")];
}

export function CatalogVersionPanel({
  item,
  canWrite,
  isSupport,
  defaultDemoId,
  onClose,
}: {
  item: CatalogVersionDto;
  canWrite: boolean;
  isSupport: boolean;
  defaultDemoId: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [publishOpen, setPublishOpen] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const form = useForm<CatalogFormValues>({ defaultValues: formDefaults(item) });
  const isDraft = item.status === "draft";
  const canEdit = isDraft && canWrite;

  const replaceCatalogItem = (updated: CatalogVersionDto) => {
    queryClient.setQueryData<{ items: CatalogVersionDto[] }>(["platform", "catalog"], (current) =>
      current
        ? { items: current.items.map((entry) => (entry.id === updated.id ? updated : entry)) }
        : current,
    );
  };

  const save = useMutation({
    mutationFn: (values: CatalogFormValues) =>
      updateCatalogVersion(item.catalogItemCode, item.id, patchForKind(item, values)),
    onSuccess: (updated) => {
      replaceCatalogItem(updated);
      setStatusMessage(t("catalog.saved"));
    },
  });
  const publish = useMutation({
    mutationFn: () => publishCatalogVersion(item.catalogItemCode, item.id),
    onSuccess: (updated) => {
      replaceCatalogItem(updated);
      setPublishOpen(false);
      setStatusMessage(t("catalog.published", { version: item.version }));
    },
  });
  const makeDefault = useMutation({
    mutationFn: () => setDefaultDemoPlan(item.id),
    onSuccess: ({ catalogVersionId }) => {
      queryClient.setQueryData(["platform", "settings", "demo-plan"], { catalogVersionId });
      setStatusMessage(t("catalog.defaultUpdated"));
    },
  });

  const summaries = quotaSummary(item, (key, options = {}) => t(key, options));
  const isDefaultDemo = defaultDemoId === item.id || makeDefault.isSuccess;
  const regionLabel = t("catalog.panelLabel", { version: item.version, name: item.nameRu });

  return (
    <section className="version-panel" role="region" aria-label={regionLabel}>
      <header className="version-panel__header">
        <div>
          <span className="panel-coordinate">VER · {String(item.version).padStart(3, "0")}</span>
          <h2>{regionLabel}</h2>
        </div>
        <div className="version-panel__header-actions">
          <StatusChip
            status={
              item.status === "published" ? "ok" : item.status === "draft" ? "warn" : "neutral"
            }
            label={t(`catalog.status.${item.status}`)}
          />
          <Button variant="secondary" onClick={onClose} aria-label={t("catalog.closePanel")}>
            {t("catalog.close")}
          </Button>
        </div>
      </header>
      <div className="version-panel__grid">
        <div className="version-panel__content">
          {canEdit ? (
            <form
              className="catalog-form"
              onSubmit={(event) => void form.handleSubmit((values) => save.mutate(values))(event)}
            >
              <fieldset>
                <legend>{t("catalog.form.identity")}</legend>
                <div className="form-grid form-grid--two">
                  <Input label={t("catalog.form.nameRu")} required {...form.register("nameRu")} />
                  <Input label={t("catalog.form.nameEn")} required {...form.register("nameEn")} />
                  <Input label={t("catalog.form.unit")} required {...form.register("unit")} />
                  {!isSupport && item.unitPrice !== undefined ? (
                    <Input
                      label={t("catalog.form.unitPrice")}
                      inputMode="decimal"
                      mono
                      required
                      {...form.register("unitPrice")}
                    />
                  ) : null}
                </div>
              </fieldset>
              {item.kind === "plan" ? (
                <fieldset>
                  <legend>{t("catalog.form.planLimits")}</legend>
                  <div className="form-grid form-grid--four">
                    <Input
                      label={t("catalog.form.maxLines")}
                      inputMode="numeric"
                      mono
                      {...form.register("maxLines")}
                    />
                    <Input
                      label={t("catalog.form.maxStations")}
                      inputMode="numeric"
                      mono
                      {...form.register("maxStations")}
                    />
                    <Input
                      label={t("catalog.form.maxKiosks")}
                      inputMode="numeric"
                      mono
                      {...form.register("maxKiosks")}
                    />
                    <Input
                      label={t("catalog.form.maxUsers")}
                      inputMode="numeric"
                      mono
                      {...form.register("maxCabinetUsers")}
                    />
                    <Input
                      label={t("catalog.form.demoDays")}
                      inputMode="numeric"
                      mono
                      {...form.register("demoDurationDays")}
                    />
                  </div>
                  <div className="feature-grid">
                    <Checkbox
                      label={t("catalog.form.labelEditor")}
                      checked={form.watch("labelEditorEnabled")}
                      onCheckedChange={(value) => form.setValue("labelEditorEnabled", value)}
                    />
                    <Checkbox
                      label={t("catalog.form.publicApi")}
                      checked={form.watch("publicApiEnabled")}
                      onCheckedChange={(value) => form.setValue("publicApiEnabled", value)}
                    />
                    <Checkbox
                      label={t("catalog.form.pallets")}
                      checked={form.watch("palletsEnabled")}
                      onCheckedChange={(value) => form.setValue("palletsEnabled", value)}
                    />
                  </div>
                </fieldset>
              ) : null}
              {item.kind === "addon" ? (
                <fieldset>
                  <legend>{t("catalog.form.addonEffect")}</legend>
                  <div className="form-grid form-grid--two">
                    <label className="native-field">
                      <span>{t("catalog.form.effectKey")}</span>
                      <select {...form.register("addonEffectKey")}>
                        {[
                          "lines",
                          "stations",
                          "kiosks",
                          "cabinetUsers",
                          "labelEditor",
                          "publicApi",
                          "pallets",
                        ].map((key) => (
                          <option key={key} value={key}>
                            {t(`catalog.effects.${key}`)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <Input
                      label={t("catalog.form.effectValue")}
                      inputMode="numeric"
                      mono
                      {...form.register("addonEffectValue")}
                    />
                  </div>
                </fieldset>
              ) : null}
              {item.kind === "service" ? (
                <Alert tone="info">{t("catalog.form.serviceNotice")}</Alert>
              ) : null}
              <div className="form-actions">
                <Button type="submit" loading={save.isPending}>
                  {t("catalog.save")}
                </Button>
                <Button type="button" variant="secondary" onClick={() => setPublishOpen(true)}>
                  {t("catalog.publishVersion", { version: item.version })}
                </Button>
              </div>
            </form>
          ) : (
            <div className="immutable-version">
              {item.status === "published" ? (
                <Alert tone="info">{t("catalog.immutable")}</Alert>
              ) : null}
              <dl className="version-data">
                <div>
                  <dt>{t("catalog.form.nameRu")}</dt>
                  <dd>{item.nameRu}</dd>
                </div>
                <div>
                  <dt>{t("catalog.form.nameEn")}</dt>
                  <dd>{item.nameEn}</dd>
                </div>
                <div>
                  <dt>{t("catalog.form.unit")}</dt>
                  <dd>{item.unit}</dd>
                </div>
                {!isSupport && item.unitPrice !== undefined ? (
                  <div>
                    <dt>{t("catalog.form.unitPrice")}</dt>
                    <dd className="mono">{t("catalog.money", { value: item.unitPrice })}</dd>
                  </div>
                ) : null}
              </dl>
            </div>
          )}
        </div>
        <aside className="effect-rail" aria-label={t("catalog.effectsLabel")}>
          <span className="effect-rail__label">{t("catalog.effectsLabel")}</span>
          <ol>
            {summaries.map((summary, index) => (
              <li key={summary}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                {summary}
              </li>
            ))}
          </ol>
          {item.kind === "plan" && item.status === "published" && item.plan?.demoDurationDays ? (
            isDefaultDemo ? (
              <StatusChip status="ok" label={t("catalog.defaultDemo")} />
            ) : canWrite ? (
              <Button
                variant="secondary"
                loading={makeDefault.isPending}
                onClick={() => makeDefault.mutate()}
                aria-label={t("catalog.makeDefault", { version: item.version })}
              >
                {t("catalog.makeDefaultShort")}
              </Button>
            ) : null
          ) : null}
        </aside>
      </div>
      <div className="panel-live" aria-live="polite">
        {statusMessage}
      </div>
      <ConfirmDialog
        open={publishOpen}
        title={t("catalog.publishTitle", { version: item.version })}
        description={t("catalog.publishWarning", { version: item.version })}
        entity={`${item.catalogItemCode} · v${item.version}`}
        confirmLabel={t("catalog.publishVersion", { version: item.version })}
        cancelLabel={t("catalog.cancel")}
        busy={publish.isPending}
        error={publish.error ? t("catalog.publishError") : undefined}
        onCancel={() => setPublishOpen(false)}
        onConfirm={() => publish.mutate()}
      />
    </section>
  );
}
