import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useFieldArray, useForm, type FieldError } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { zodResolver } from "@hookform/resolvers/zod";

import { Alert, Button, Checkbox, ConfirmDialog, Input, StatusChip } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import {
  publishCatalogVersion,
  retireCatalogVersion,
  archiveCatalogItem,
  setDefaultDemoPlan,
  updateCatalogVersion,
  type AddonEffect,
  type CatalogVersionDto,
  type CatalogVersionPatch,
  type PlanEntitlements,
} from "./api.js";

interface CatalogFormValues {
  kind: CatalogVersionDto["kind"];
  financialVisible: boolean;
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
  addonEffects: Array<{ key: AddonEffect["key"]; value: string }>;
}

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

const MONEY_PATTERN = /^\d{1,12}\.\d{2}$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;
const POSTGRES_INTEGER_MAX = 2_147_483_647;

function isSafePositiveInteger(value: string): boolean {
  const numericValue = Number(value);
  return (
    POSITIVE_INTEGER_PATTERN.test(value) &&
    Number.isSafeInteger(numericValue) &&
    numericValue <= POSTGRES_INTEGER_MAX
  );
}

function positiveIntegerIssue(value: string, emptyAllowed: boolean): string | null {
  if (emptyAllowed && value === "") return null;
  if (isSafePositiveInteger(value)) return null;
  if (POSITIVE_INTEGER_PATTERN.test(value) && Number(value) > POSTGRES_INTEGER_MAX) {
    return emptyAllowed ? "integer32OrEmpty" : "integer32";
  }
  return emptyAllowed ? "positiveOrEmpty" : "positive";
}

const catalogFormSchema = z
  .object({
    kind: z.enum(["plan", "addon", "service"]),
    financialVisible: z.boolean(),
    nameRu: z.string().trim().min(1, "required").max(300, "nameTooLong"),
    nameEn: z.string().trim().min(1, "required").max(300, "nameTooLong"),
    unit: z.string().trim().min(1, "required").max(100, "unitTooLong"),
    unitPrice: z.string(),
    maxLines: z.string(),
    maxStations: z.string(),
    maxKiosks: z.string(),
    maxCabinetUsers: z.string(),
    demoDurationDays: z.string(),
    labelEditorEnabled: z.boolean(),
    publicApiEnabled: z.boolean(),
    palletsEnabled: z.boolean(),
    addonEffects: z
      .array(
        z.object({
          key: z.enum(EFFECT_KEYS),
          value: z.string(),
        }),
      )
      .max(7),
  })
  .superRefine((values, context) => {
    if (values.financialVisible && !MONEY_PATTERN.test(values.unitPrice)) {
      context.addIssue({ code: "custom", path: ["unitPrice"], message: "money" });
    }
    if (values.kind === "plan") {
      for (const field of [
        "maxLines",
        "maxStations",
        "maxKiosks",
        "maxCabinetUsers",
        "demoDurationDays",
      ] as const) {
        const value = values[field];
        const issue = positiveIntegerIssue(value, true);
        if (issue) {
          context.addIssue({ code: "custom", path: [field], message: issue });
        }
      }
    }
    if (values.kind === "addon") {
      if (values.addonEffects.length === 0) {
        context.addIssue({ code: "custom", path: ["addonEffects"], message: "effectRequired" });
      }
      const seen = new Set<AddonEffect["key"]>();
      values.addonEffects.forEach((effect, index) => {
        if (seen.has(effect.key)) {
          context.addIssue({
            code: "custom",
            path: ["addonEffects", index, "key"],
            message: "effectDuplicate",
          });
        }
        seen.add(effect.key);
        const issue = positiveIntegerIssue(effect.value, false);
        if (QUOTA_EFFECT_KEYS.has(effect.key) && issue) {
          context.addIssue({
            code: "custom",
            path: ["addonEffects", index, "value"],
            message: issue,
          });
        }
      });
    }
  });

function fieldError(error: FieldError | undefined, t: (key: string) => string): string | undefined {
  if (!error?.message) return undefined;
  return t(`catalog.validation.${error.message}`);
}

function inputErrorProps(error: FieldError | undefined, t: (key: string) => string) {
  const message = fieldError(error, t);
  return message ? { error: message } : {};
}

function numericOrNull(value: string): number | null {
  return value.trim() === "" ? null : Number(value);
}

function formDefaults(item: CatalogVersionDto): CatalogFormValues {
  const savedAddonEffects =
    item.addon?.effects.map((effect) => ({
      key: effect.key,
      value: "quotaIncrement" in effect ? String(effect.quotaIncrement) : "",
    })) ?? [];
  return {
    kind: item.kind,
    financialVisible: item.unitPrice !== undefined,
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
    addonEffects:
      savedAddonEffects.length > 0 ? savedAddonEffects : [{ key: "stations", value: "1" }],
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
    const effects = values.addonEffects.map((effect): AddonEffect =>
      QUOTA_EFFECT_KEYS.has(effect.key)
        ? {
            key: effect.key as "lines" | "stations" | "kiosks" | "cabinetUsers",
            quotaIncrement: Number(effect.value),
          }
        : {
            key: effect.key as "labelEditor" | "publicApi" | "pallets",
            featureEnabled: true,
          },
    );
    return { ...common, addon: { effects } };
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
  const [retireOpen, setRetireOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{
    tone: "ok" | "error";
    text: string;
  } | null>(null);
  const form = useForm<CatalogFormValues>({
    resolver: zodResolver(catalogFormSchema),
    defaultValues: formDefaults(item),
  });
  const addonEffects = useFieldArray({ control: form.control, name: "addonEffects" });
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
      setStatusMessage({ tone: "ok", text: t("catalog.saved") });
    },
    onError: (error) => {
      setStatusMessage({
        tone: "error",
        text:
          error instanceof ApiRequestError && error.status === 409
            ? t("catalog.saveConflict")
            : t("catalog.saveError"),
      });
    },
  });
  const publish = useMutation({
    mutationFn: () => publishCatalogVersion(item.catalogItemCode, item.id),
    onSuccess: (updated) => {
      replaceCatalogItem(updated);
      setPublishOpen(false);
      setStatusMessage({
        tone: "ok",
        text: t("catalog.published", { version: item.version }),
      });
    },
  });
  const makeDefault = useMutation({
    mutationFn: () => setDefaultDemoPlan(item.id),
    onSuccess: ({ catalogVersionId }) => {
      queryClient.setQueryData(["platform", "settings", "demo-plan"], { catalogVersionId });
      setStatusMessage({ tone: "ok", text: t("catalog.defaultUpdated") });
    },
    onError: (error) => {
      setStatusMessage({
        tone: "error",
        text:
          error instanceof ApiRequestError && error.status === 409
            ? t("catalog.defaultConflict")
            : t("catalog.defaultError"),
      });
    },
  });
  const retire = useMutation({
    mutationFn: () => retireCatalogVersion(item.catalogItemCode, item.id),
    onSuccess: (updated) => {
      replaceCatalogItem(updated);
      setRetireOpen(false);
      setStatusMessage({ tone: "ok", text: t("catalog.retired", { version: item.version }) });
    },
    onError: () => setStatusMessage({ tone: "error", text: t("catalog.retireError") }),
  });
  const archive = useMutation({
    mutationFn: () => archiveCatalogItem(item.catalogItemCode),
    onSuccess: () => {
      setArchiveOpen(false);
      queryClient.setQueryData<{ items: CatalogVersionDto[] }>(
        ["platform", "catalog"],
        (current) =>
          current
            ? {
                items: current.items.filter(
                  (entry) => entry.catalogItemCode !== item.catalogItemCode,
                ),
              }
            : current,
      );
      onClose();
    },
    onError: () => setStatusMessage({ tone: "error", text: t("catalog.archiveError") }),
  });

  const summaries = quotaSummary(item, (key, options = {}) => t(key, options));
  const isDefaultDemo = defaultDemoId === item.id;
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
          {canWrite && item.status === "published" ? (
            <Button variant="secondary" onClick={() => setRetireOpen(true)}>
              {t("catalog.retire")}
            </Button>
          ) : null}
          {canWrite && item.status === "retired" ? (
            <Button variant="secondary" onClick={() => setArchiveOpen(true)}>
              {t("catalog.archive")}
            </Button>
          ) : null}
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
              onSubmit={(event) =>
                void form.handleSubmit(
                  (values) => {
                    setStatusMessage(null);
                    save.mutate(values);
                  },
                  () => setStatusMessage(null),
                )(event)
              }
            >
              <input type="hidden" {...form.register("kind")} />
              <input type="hidden" {...form.register("financialVisible")} />
              <fieldset>
                <legend>{t("catalog.form.identity")}</legend>
                <div className="form-grid form-grid--two">
                  <Input
                    label={t("catalog.form.nameRu")}
                    required
                    {...inputErrorProps(form.formState.errors.nameRu, t)}
                    {...form.register("nameRu")}
                  />
                  <Input
                    label={t("catalog.form.nameEn")}
                    required
                    {...inputErrorProps(form.formState.errors.nameEn, t)}
                    {...form.register("nameEn")}
                  />
                  <Input
                    label={t("catalog.form.unit")}
                    required
                    {...inputErrorProps(form.formState.errors.unit, t)}
                    {...form.register("unit")}
                  />
                  {!isSupport && item.unitPrice !== undefined ? (
                    <Input
                      label={t("catalog.form.unitPrice")}
                      inputMode="decimal"
                      mono
                      required
                      {...inputErrorProps(form.formState.errors.unitPrice, t)}
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
                      {...inputErrorProps(form.formState.errors.maxLines, t)}
                      {...form.register("maxLines")}
                    />
                    <Input
                      label={t("catalog.form.maxStations")}
                      inputMode="numeric"
                      mono
                      {...inputErrorProps(form.formState.errors.maxStations, t)}
                      {...form.register("maxStations")}
                    />
                    <Input
                      label={t("catalog.form.maxKiosks")}
                      inputMode="numeric"
                      mono
                      {...inputErrorProps(form.formState.errors.maxKiosks, t)}
                      {...form.register("maxKiosks")}
                    />
                    <Input
                      label={t("catalog.form.maxUsers")}
                      inputMode="numeric"
                      mono
                      {...inputErrorProps(form.formState.errors.maxCabinetUsers, t)}
                      {...form.register("maxCabinetUsers")}
                    />
                    <Input
                      label={t("catalog.form.demoDays")}
                      inputMode="numeric"
                      mono
                      {...inputErrorProps(form.formState.errors.demoDurationDays, t)}
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
                  <div className="addon-effects">
                    {addonEffects.fields.map((field, index) => {
                      const key = form.watch(`addonEffects.${index}.key`);
                      const keyError = form.formState.errors.addonEffects?.[index]?.key;
                      const keyErrorId = keyError ? `addon-effect-${field.id}-error` : undefined;
                      return (
                        <div className="addon-effect-row" key={field.id}>
                          <label className="native-field">
                            <span>{t("catalog.form.effectKeyIndexed", { index: index + 1 })}</span>
                            <select
                              aria-label={t("catalog.form.effectKeyIndexed", { index: index + 1 })}
                              aria-invalid={keyError ? true : undefined}
                              aria-describedby={keyErrorId}
                              {...form.register(`addonEffects.${index}.key`)}
                            >
                              {EFFECT_KEYS.map((effectKey) => (
                                <option key={effectKey} value={effectKey}>
                                  {t(`catalog.effectNames.${effectKey}`)}
                                </option>
                              ))}
                            </select>
                            {keyError ? (
                              <span className="native-field__error" id={keyErrorId}>
                                {fieldError(keyError, t)}
                              </span>
                            ) : null}
                          </label>
                          {QUOTA_EFFECT_KEYS.has(key) ? (
                            <Input
                              label={t("catalog.form.effectValueIndexed", { index: index + 1 })}
                              inputMode="numeric"
                              mono
                              {...inputErrorProps(
                                form.formState.errors.addonEffects?.[index]?.value,
                                t,
                              )}
                              {...form.register(`addonEffects.${index}.value`)}
                            />
                          ) : (
                            <div className="feature-effect" role="status">
                              {t("catalog.form.featureEnabled")}
                            </div>
                          )}
                          <Button
                            type="button"
                            variant="secondary"
                            disabled={addonEffects.fields.length === 1}
                            aria-label={t("catalog.form.removeEffect", { index: index + 1 })}
                            onClick={() => addonEffects.remove(index)}
                          >
                            {t("catalog.form.remove")}
                          </Button>
                        </div>
                      );
                    })}
                    {form.formState.errors.addonEffects?.root ? (
                      <Alert tone="error">
                        {fieldError(form.formState.errors.addonEffects.root, t)}
                      </Alert>
                    ) : null}
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={addonEffects.fields.length >= 7}
                      onClick={() => addonEffects.append({ key: "stations", value: "1" })}
                    >
                      {t("catalog.form.addEffect")}
                    </Button>
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
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setStatusMessage(null);
                    setPublishOpen(true);
                  }}
                >
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
                onClick={() => {
                  setStatusMessage(null);
                  makeDefault.mutate();
                }}
                aria-label={t("catalog.makeDefault", { version: item.version })}
              >
                {t("catalog.makeDefaultShort")}
              </Button>
            ) : null
          ) : null}
        </aside>
      </div>
      <div
        className="panel-live"
        data-tone={statusMessage?.tone}
        role="status"
        aria-label={t("catalog.mutationStatus")}
        aria-live="polite"
      >
        {statusMessage?.text}
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
      <ConfirmDialog
        open={retireOpen}
        title={t("catalog.retireTitle", { version: item.version })}
        description={t("catalog.retireWarning")}
        entity={`${item.catalogItemCode} · v${item.version}`}
        confirmLabel={t("catalog.retire")}
        cancelLabel={t("catalog.cancel")}
        busy={retire.isPending}
        onCancel={() => setRetireOpen(false)}
        onConfirm={() => retire.mutate()}
      />
      <ConfirmDialog
        open={archiveOpen}
        title={t("catalog.archiveTitle")}
        description={t("catalog.archiveWarning")}
        entity={item.catalogItemCode}
        confirmLabel={t("catalog.archive")}
        cancelLabel={t("catalog.cancel")}
        busy={archive.isPending}
        onCancel={() => setArchiveOpen(false)}
        onConfirm={() => archive.mutate()}
      />
    </section>
  );
}
