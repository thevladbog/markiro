import { CatalogPayablePreview } from "./CatalogPayablePreview.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useForm, type FieldError } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { zodResolver } from "@hookform/resolvers/zod";

import { Alert, Button, Checkbox, ConfirmDialog, Input, Select, StatusChip } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import {
  getCatalogEditorContext,
  getCatalogVersion,
  reviewCatalogVersion,
  publishCatalogVersion,
  retireCatalogVersion,
  archiveCatalogItem,
  setDefaultDemoPlan,
  updateCatalogVersion,
  catalogVersionToCreateInput,
  createCatalogVersion,
  type AddonEffect,
  type CatalogVersionDto,
  type CatalogVersionPatch,
  type PlanEntitlements,
} from "./api.js";
import type { CatalogPublicationReview } from "@markiro/platform-contracts";
import { CatalogQuotaField } from "./CatalogQuotaField.js";
import { CatalogUnitField } from "./CatalogUnitField.js";
import { CatalogVatField, formatVat } from "./CatalogVatField.js";
import {
  AddonEffectsEditor,
  fromAddonEffects,
  type EditableAddonEffect,
} from "./AddonEffectsEditor.js";
import { useCatalogDrawerClose } from "./CatalogDrawer.js";

interface CatalogFormValues {
  kind: CatalogVersionDto["kind"];
  financialVisible: boolean;
  documentNameRu: string;
  documentNameEn: string;
  subject: "software_license" | "service" | "development_work";
  nameRu: string;
  nameEn: string;
  descriptionRu: string;
  descriptionEn: string;
  unit: string;
  unitPrice: string;
  vatRateBps: number | null;
  vatIncluded: boolean;
  maxLines: string;
  maxStations: string;
  maxKiosks: string;
  maxCabinetUsers: string;
  demoDurationDays: string;
  labelEditorEnabled: boolean;
  publicApiEnabled: boolean;
  palletsEnabled: boolean;
  addonEffects: EditableAddonEffect[];
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
    documentNameRu: z.string().max(300),
    documentNameEn: z.string().max(300),
    subject: z.enum(["software_license", "service", "development_work"]),
    nameRu: z.string().trim().min(1, "required").max(300, "nameTooLong"),
    nameEn: z.string().trim().min(1, "required").max(300, "nameTooLong"),
    descriptionRu: z.string().max(2000, "descriptionTooLong"),
    descriptionEn: z.string().max(2000, "descriptionTooLong"),
    unit: z.string().trim().min(1, "required").max(100, "unitTooLong"),
    unitPrice: z.string(),
    vatRateBps: z.number().nullable(),
    vatIncluded: z.boolean(),
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
          rowId: z.string(),
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
        const issue =
          field !== "demoDurationDays"
            ? value === "0" || value === ""
              ? null
              : value === "__limited__"
                ? "quota"
                : positiveIntegerIssue(value, false)
            : positiveIntegerIssue(value, true);
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
  const savedAddonEffects = item.addon ? fromAddonEffects(item.addon.effects) : [];
  return {
    kind: item.kind,
    financialVisible: item.unitPrice !== undefined,
    documentNameRu: item.documentNameRu ?? "",
    documentNameEn: item.documentNameEn ?? "",
    subject: item.subject ?? (item.kind === "service" ? "service" : "software_license"),
    nameRu: item.nameRu,
    nameEn: item.nameEn,
    descriptionRu: item.descriptionRu ?? "",
    descriptionEn: item.descriptionEn ?? "",
    unit: item.kind === "service" ? item.unit : (item.billingPeriod ?? "month"),
    unitPrice: item.unitPrice ?? "",
    vatRateBps: item.vatRateBps ?? null,
    vatIncluded: item.vatIncluded ?? false,
    maxLines: String(item.plan?.maxLines ?? ""),
    maxStations: String(item.plan?.maxStations ?? ""),
    maxKiosks: String(item.plan?.maxKiosks ?? ""),
    maxCabinetUsers: String(item.plan?.maxCabinetUsers ?? ""),
    demoDurationDays: String(item.plan?.demoDurationDays ?? ""),
    labelEditorEnabled: item.plan?.labelEditorEnabled ?? false,
    publicApiEnabled: item.plan?.publicApiEnabled ?? false,
    palletsEnabled: item.plan?.palletsEnabled ?? false,
    addonEffects:
      savedAddonEffects.length > 0
        ? savedAddonEffects
        : [{ rowId: crypto.randomUUID(), key: "stations", value: "1" }],
  };
}

function patchForKind(item: CatalogVersionDto, values: CatalogFormValues): CatalogVersionPatch {
  const common: CatalogVersionPatch = {
    documentNameRu: values.documentNameRu.trim() || null,
    documentNameEn: values.documentNameEn.trim() || null,
    subject: values.subject,
    billingPeriod: item.kind === "service" ? null : values.unit === "year" ? "year" : "month",
    nameRu: values.nameRu,
    nameEn: values.nameEn,
    descriptionRu: values.descriptionRu.trim() || null,
    descriptionEn: values.descriptionEn.trim() || null,
    unit: values.unit,
  };
  if (item.unitPrice !== undefined) {
    common.unitPrice = values.unitPrice;
    common.vatRateBps = values.vatRateBps;
    common.vatIncluded = values.vatRateBps !== null && values.vatIncluded;
  }
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
  onVersionCreated,
  onDirtyChange,
}: {
  item: CatalogVersionDto;
  canWrite: boolean;
  isSupport: boolean;
  defaultDemoId: string | null;
  onClose: () => void;
  onVersionCreated?: (created: CatalogVersionDto) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useTranslation();
  const requestClose = useCatalogDrawerClose(onClose);
  const queryClient = useQueryClient();
  const context = useQuery({
    queryKey: ["platform", "catalog", "editor-context"],
    queryFn: getCatalogEditorContext,
    enabled: canWrite,
  });
  const [reviewedVersion, setReviewedVersion] = useState<CatalogVersionDto | null>(null);
  const [review, setReview] = useState<CatalogPublicationReview | null>(null);
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
      updateCatalogVersion(item.catalogItemCode, item.id, {
        ...patchForKind(item, values),
        sellerPolicyRevision: context.data?.sellerPolicyRevision || null,
      }),
    onSuccess: (updated) => {
      replaceCatalogItem(updated);
      form.reset(formDefaults(updated));
      setReview(null);
      setStatusMessage({ tone: "ok", text: t("catalog.saved") });
    },
    onError: (error) => {
      setStatusMessage({
        tone: "error",
        text:
          error instanceof ApiRequestError && error.kind === "domain" && error.status === 409
            ? t("catalog.saveConflict")
            : t("catalog.saveError"),
      });
    },
  });
  const clone = useMutation({
    mutationFn: () => createCatalogVersion(item.catalogItemCode, catalogVersionToCreateInput(item)),
    onSuccess: (created) => {
      queryClient.setQueryData<{ items: CatalogVersionDto[] }>(
        ["platform", "catalog"],
        (current) => (current ? { items: [...current.items, created] } : { items: [created] }),
      );
      onVersionCreated?.(created);
    },
    onError: () => setStatusMessage({ tone: "error", text: t("catalog.cloneError") }),
  });
  const prepareReview = useMutation({
    mutationFn: async () => {
      if (form.formState.isDirty) await save.mutateAsync(form.getValues());
      await context.refetch();
      const before = await reviewCatalogVersion(item.catalogItemCode, item.id);
      const version = await getCatalogVersion(item.catalogItemCode, item.id);
      const after = await reviewCatalogVersion(item.catalogItemCode, item.id);
      if (JSON.stringify(before.identity) !== JSON.stringify(after.identity))
        throw new ApiRequestError(409, "Review changed", "commercial_review_stale");
      return { review: after, version };
    },
    onSuccess: (result) => {
      setReview(result.review);
      setReviewedVersion(result.version);
      replaceCatalogItem(result.version);
      if (!form.formState.isDirty) form.reset(formDefaults(result.version));
      setPublishOpen(true);
    },
    onError: () => setStatusMessage({ tone: "error", text: t("catalog.reviewError") }),
  });
  const publish = useMutation({
    mutationFn: () => {
      if (!review || review.errors.length) throw new Error("commercial_review_invalid");
      return publishCatalogVersion(item.catalogItemCode, item.id, review.identity);
    },
    onError: async (error) => {
      if (error instanceof ApiRequestError && error.code === "commercial_review_stale") {
        setPublishOpen(false);
        setReview(null);
        setStatusMessage({ tone: "error", text: t("catalog.reviewStale") });
        await context.refetch();
        prepareReview.mutate();
      }
    },
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
          error instanceof ApiRequestError && error.kind === "domain" && error.status === 409
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

  const watched = form.watch();
  const summaries =
    canEdit && item.kind === "plan"
      ? ["maxLines", "maxStations", "maxKiosks", "maxCabinetUsers"].map((key) => {
          const field = key as "maxLines" | "maxStations" | "maxKiosks" | "maxCabinetUsers";
          const value = watched[field];
          return `${t(`catalog.form.${key === "maxCabinetUsers" ? "maxUsers" : key}`)}: ${value === "" ? t("catalog.quota.unlimited") : value === "0" ? t("catalog.quota.none") : value === "__limited__" ? t("catalog.quota.required") : value}`;
        })
      : canEdit && item.kind === "addon"
        ? watched.addonEffects.map((effect) =>
            ["lines", "stations", "kiosks", "cabinetUsers"].includes(effect.key)
              ? /^[1-9]\d*$/.test(effect.value)
                ? t(`catalog.effects.${effect.key}`, { count: Number(effect.value) })
                : `${t(`catalog.effectNames.${effect.key}`)}: ${t("catalog.quota.required")}`
              : t(`catalog.effects.${effect.key}`),
          )
        : quotaSummary(item, (key, options = {}) => t(key, options));
  const addonFormErrors = form.formState.errors.addonEffects;
  const addonErrorEntries = Array.isArray(addonFormErrors)
    ? (addonFormErrors as unknown as Array<{ key?: FieldError; value?: FieldError }>)
    : undefined;
  const addonErrors = addonErrorEntries
    ? addonErrorEntries.map((entry) => {
        const key = entry?.key ? fieldError(entry.key, t) : undefined;
        const value = entry?.value ? fieldError(entry.value, t) : undefined;
        return { ...(key ? { key } : {}), ...(value ? { value } : {}) };
      })
    : undefined;
  const addonRootError =
    !addonErrorEntries && addonFormErrors && "root" in addonFormErrors && addonFormErrors.root
      ? fieldError(addonFormErrors.root, t)
      : undefined;
  useEffect(() => {
    onDirtyChange?.(form.formState.isDirty);
  }, [form.formState.isDirty, onDirtyChange]);
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
          {canWrite && item.status !== "draft" ? (
            <Button
              variant="primary"
              loading={clone.isPending}
              disabled={clone.isPending}
              onClick={() => clone.mutate()}
            >
              {t("catalog.clone")}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={requestClose} aria-label={t("catalog.closePanel")}>
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
                    if (!save.isPending) save.mutate(values);
                  },
                  () => setStatusMessage(null),
                )(event)
              }
            >
              <input type="hidden" {...form.register("kind")} />
              <input type="hidden" {...form.register("financialVisible")} />
              <fieldset disabled={save.isPending || prepareReview.isPending || publish.isPending}>
                <legend>{t("catalog.form.identity")}</legend>
                <div className="form-grid form-grid--two">
                  <Input
                    label={t("catalog.form.documentNameRu")}
                    {...form.register("documentNameRu")}
                  />
                  <Input
                    label={t("catalog.form.documentNameEn")}
                    {...form.register("documentNameEn")}
                  />
                  {item.kind === "service" ? (
                    <Select
                      label={t("catalog.form.subject")}
                      value={form.watch("subject")}
                      onValueChange={(value) =>
                        form.setValue("subject", value, { shouldDirty: true })
                      }
                      options={[
                        { value: "service", label: t("commercial.subject.service") },
                        {
                          value: "development_work",
                          label: t("commercial.subject.development_work"),
                        },
                      ]}
                    />
                  ) : (
                    <p>{t("commercial.subject.software_license")}</p>
                  )}
                  {form.watch("vatRateBps") !== null ? (
                    <Checkbox
                      label={t("catalog.vat.includedHint")}
                      checked={form.watch("vatIncluded")}
                      onCheckedChange={(value) =>
                        form.setValue("vatIncluded", value, { shouldDirty: true })
                      }
                    />
                  ) : null}
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
                  <label className="native-field">
                    <span>{t("catalog.form.descriptionRu")}</span>
                    <textarea rows={3} {...form.register("descriptionRu")} />
                  </label>
                  <label className="native-field">
                    <span>{t("catalog.form.descriptionEn")}</span>
                    <textarea rows={3} {...form.register("descriptionEn")} />
                  </label>
                  <CatalogUnitField
                    kind={item.kind}
                    value={form.watch("unit")}
                    onChange={(value) =>
                      form.setValue("unit", value, { shouldDirty: true, shouldValidate: true })
                    }
                    {...(() => {
                      const error = fieldError(form.formState.errors.unit, t);
                      return error ? { error } : {};
                    })()}
                  />
                  {!isSupport && item.unitPrice !== undefined ? (
                    <>
                      <Input
                        label={t("catalog.form.unitPrice")}
                        inputMode="decimal"
                        mono
                        required
                        {...inputErrorProps(form.formState.errors.unitPrice, t)}
                        {...form.register("unitPrice")}
                      />
                      <CatalogVatField
                        policy={context.data?.taxPolicy}
                        value={form.watch("vatRateBps")}
                        onChange={(value) => {
                          form.setValue("vatRateBps", value, {
                            shouldDirty: true,
                            shouldValidate: true,
                          });
                          if (value === null)
                            form.setValue("vatIncluded", false, { shouldDirty: true });
                        }}
                        {...(() => {
                          const error = fieldError(form.formState.errors.vatRateBps, t);
                          return error ? { error } : {};
                        })()}
                      />
                    </>
                  ) : null}
                </div>
              </fieldset>
              {item.kind === "plan" ? (
                <fieldset disabled={save.isPending || prepareReview.isPending || publish.isPending}>
                  <legend>{t("catalog.form.planLimits")}</legend>
                  <div className="form-grid form-grid--four">
                    <CatalogQuotaField
                      label={t("catalog.form.maxLines")}
                      value={form.watch("maxLines")}
                      onChange={(value) =>
                        form.setValue("maxLines", value, {
                          shouldDirty: true,
                          shouldValidate: true,
                        })
                      }
                      {...inputErrorProps(form.formState.errors.maxLines, t)}
                    />
                    <CatalogQuotaField
                      label={t("catalog.form.maxStations")}
                      value={form.watch("maxStations")}
                      onChange={(value) =>
                        form.setValue("maxStations", value, {
                          shouldDirty: true,
                          shouldValidate: true,
                        })
                      }
                      {...inputErrorProps(form.formState.errors.maxStations, t)}
                    />
                    <CatalogQuotaField
                      label={t("catalog.form.maxKiosks")}
                      value={form.watch("maxKiosks")}
                      onChange={(value) =>
                        form.setValue("maxKiosks", value, {
                          shouldDirty: true,
                          shouldValidate: true,
                        })
                      }
                      {...inputErrorProps(form.formState.errors.maxKiosks, t)}
                    />
                    <CatalogQuotaField
                      label={t("catalog.form.maxUsers")}
                      value={form.watch("maxCabinetUsers")}
                      onChange={(value) =>
                        form.setValue("maxCabinetUsers", value, {
                          shouldDirty: true,
                          shouldValidate: true,
                        })
                      }
                      {...inputErrorProps(form.formState.errors.maxCabinetUsers, t)}
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
                      onCheckedChange={(value) =>
                        form.setValue("labelEditorEnabled", value, { shouldDirty: true })
                      }
                    />
                    <Checkbox
                      label={t("catalog.form.publicApi")}
                      checked={form.watch("publicApiEnabled")}
                      onCheckedChange={(value) =>
                        form.setValue("publicApiEnabled", value, { shouldDirty: true })
                      }
                    />
                    <Checkbox
                      label={t("catalog.form.pallets")}
                      checked={form.watch("palletsEnabled")}
                      onCheckedChange={(value) =>
                        form.setValue("palletsEnabled", value, { shouldDirty: true })
                      }
                    />
                  </div>
                </fieldset>
              ) : null}
              {item.kind === "addon" ? (
                <AddonEffectsEditor
                  disabled={save.isPending || prepareReview.isPending || publish.isPending}
                  effects={form.watch("addonEffects")}
                  onChange={(next) =>
                    form.setValue("addonEffects", next, {
                      shouldDirty: true,
                      shouldValidate: true,
                    })
                  }
                  {...(addonErrors ? { errors: addonErrors } : {})}
                  {...(addonRootError ? { listError: addonRootError } : {})}
                />
              ) : null}
              {item.kind === "service" ? (
                <Alert tone="info">{t("catalog.form.serviceNotice")}</Alert>
              ) : null}
              <div className="form-actions">
                <Button
                  type="submit"
                  loading={save.isPending}
                  disabled={save.isPending || prepareReview.isPending}
                >
                  {t("catalog.save")}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={save.isPending || prepareReview.isPending || !context.data?.taxPolicy}
                  loading={prepareReview.isPending}
                  onClick={() => {
                    void form.handleSubmit(() => {
                      setStatusMessage(null);
                      prepareReview.mutate();
                    })();
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
                  <dt>{t("catalog.form.documentNameRu")}</dt>
                  <dd>{item.documentNameRu ?? "—"}</dd>
                </div>
                <div>
                  <dt>{t("catalog.form.documentNameEn")}</dt>
                  <dd>{item.documentNameEn ?? "—"}</dd>
                </div>
                <div>
                  <dt>{t("catalog.form.subject")}</dt>
                  <dd>{item.subject ? t(`commercial.subject.${item.subject}`) : "—"}</dd>
                </div>
                {item.billingPeriod ? (
                  <div>
                    <dt>{t("catalog.form.period")}</dt>
                    <dd>{t(`catalog.units.${item.billingPeriod}`)}</dd>
                  </div>
                ) : null}
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
                  <dd>
                    {item.kind !== "service" && item.billingPeriod
                      ? t(`catalog.units.${item.billingPeriod}`)
                      : item.unit}
                  </dd>
                </div>
                {!isSupport && item.unitPrice !== undefined ? (
                  <div>
                    <dt>{t("catalog.form.unitPrice")}</dt>
                    <dd className="mono">{t("catalog.money", { value: item.unitPrice })}</dd>
                  </div>
                ) : null}
                {!isSupport && item.unitPrice !== undefined ? (
                  <div>
                    <dt>{t("catalog.form.vat")}</dt>
                    <dd>
                      {formatVat(
                        item.vatRateBps ?? null,
                        item.vatIncluded ?? false,
                        (key, options) => (options ? t(key, options) : t(key)),
                      )}
                    </dd>
                  </div>
                ) : null}
              </dl>
            </div>
          )}
        </div>
        <aside className="effect-rail" aria-label={t("catalog.effectsLabel")}>
          <span className="effect-rail__label">{t("catalog.effectsLabel")}</span>
          {item.kind !== "service" ? (
            <p>{t(`catalog.units.${canEdit ? watched.unit : item.billingPeriod}`)}</p>
          ) : null}
          {!isSupport && item.unitPrice !== undefined ? (
            <CatalogPayablePreview
              price={canEdit ? watched.unitPrice : item.unitPrice}
              vatRateBps={canEdit ? watched.vatRateBps : (item.vatRateBps ?? null)}
              vatIncluded={canEdit ? watched.vatIncluded : (item.vatIncluded ?? false)}
            />
          ) : null}
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
        description={
          review?.errors.length ? (
            <ul>
              {review.errors.map((error) => (
                <li key={`${error.path}:${error.code}`}>
                  {t(`commercial.errors.${error.code}`, { defaultValue: t("catalog.reviewError") })}
                </li>
              ))}
            </ul>
          ) : reviewedVersion ? (
            <>
              <p>{t("catalog.publishWarning", { version: item.version })}</p>
              <p>
                {reviewedVersion.documentNameRu} · {reviewedVersion.documentNameEn}
              </p>
              <p>
                {reviewedVersion.subject ? t(`commercial.subject.${reviewedVersion.subject}`) : "—"}{" "}
                ·{" "}
                {reviewedVersion.billingPeriod
                  ? t(`catalog.units.${reviewedVersion.billingPeriod}`)
                  : reviewedVersion.unit}{" "}
              </p>
              {reviewedVersion.unitPrice !== undefined ? (
                <CatalogPayablePreview
                  price={reviewedVersion.unitPrice}
                  vatRateBps={reviewedVersion.vatRateBps ?? null}
                  vatIncluded={reviewedVersion.vatIncluded ?? false}
                />
              ) : null}
              <ul>
                {quotaSummary(reviewedVersion, (key, options = {}) => t(key, options)).map(
                  (summary) => (
                    <li key={summary}>{summary}</li>
                  ),
                )}
              </ul>
              {reviewedVersion.plan ? (
                <p>
                  {t("catalog.form.maxUsers")}:{" "}
                  {reviewedVersion.plan.maxCabinetUsers ?? t("catalog.quota.unlimited")} ·{" "}
                  {t("catalog.form.demoDays")}: {reviewedVersion.plan.demoDurationDays ?? "—"}
                </p>
              ) : null}
            </>
          ) : (
            t("catalog.reviewError")
          )
        }
        entity={`${item.catalogItemCode} · v${item.version}`}
        confirmLabel={t("catalog.publishVersion", { version: item.version })}
        cancelLabel={t("catalog.cancel")}
        busy={publish.isPending}
        confirmDisabled={!review || review.errors.length > 0}
        error={publish.error ? t("catalog.publishError") : undefined}
        onCancel={() => setPublishOpen(false)}
        onConfirm={() => {
          if (review && !review.errors.length && !publish.isPending) publish.mutate();
        }}
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
