import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Button,
  Card,
  Combobox,
  ConfirmDialog,
  Input,
  Select,
  StatusChip,
  type ComboboxOption,
} from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import {
  assignTenantAddon,
  assignTenantPlan,
  getTenant,
  listAssignableCatalogVersions,
  type AssignableCatalogVersion,
  type AssignAddonInput,
  type AssignPlanInput,
  type DetailPlanVersion,
  type TenantDetail,
  type TenantSubscription,
  type TenantSubscriptionAddon,
} from "./api.js";
import { tenantErrorMessageKey } from "./errorMessages.js";
import { useUnsavedChanges } from "./useUnsavedChanges.js";

type QuotaKey = "lines" | "stations" | "kiosks" | "cabinetUsers";
type FeatureKey = "labelEditor" | "publicApi" | "pallets";
type AssignmentKind = "plan" | "addon";
type ActivationPolicy = "immediate" | "after_current";

interface AssignmentFormValues {
  kind: AssignmentKind;
  catalogVersionId: string;
  activationPolicy: ActivationPolicy;
  quantity: string;
  endsAt: string;
  reason: string;
}

interface ConfirmationState {
  kind: AssignmentKind;
  version: AssignableCatalogVersion;
  quantity: number;
  activationPolicy: ActivationPolicy;
  reason: string;
  summaries: string[];
  endsAt?: string;
  targetSubscription?: { id: string; planVersion: DetailPlanVersion };
  currentEndsAt?: string;
  planInput?: AssignPlanInput;
  addonInput?: AssignAddonInput;
}

const QUOTA_KEYS: readonly QuotaKey[] = ["lines", "stations", "kiosks", "cabinetUsers"];
const FEATURE_KEYS: readonly FeatureKey[] = ["labelEditor", "publicApi", "pallets"];
const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_MANUAL_TERM_MS = 10 * 366 * DAY_MS;

function versionLabel(
  version: { nameRu: string; nameEn: string; catalogItemCode: string | null; version: number },
  language: "ru" | "en",
) {
  return `${language === "en" ? version.nameEn : version.nameRu} · ${version.catalogItemCode ?? "—"} · ${language === "en" ? "version" : "версия"} ${version.version}`;
}

function formatDate(value: string | null, language: "ru" | "en") {
  if (!value) return "—";
  return new Intl.DateTimeFormat(language === "en" ? "en-GB" : "ru-RU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Moscow",
  }).format(new Date(value));
}

function quotaFromPlan(plan: DetailPlanVersion | null): Record<QuotaKey, number | null> {
  const effect = plan?.entitlements;
  return {
    lines: effect?.maxLines ?? null,
    stations: effect?.maxStations ?? null,
    kiosks: effect?.maxKiosks ?? null,
    cabinetUsers: effect?.maxCabinetUsers ?? null,
  };
}

function featuresFromPlan(plan: DetailPlanVersion | null): Record<FeatureKey, boolean> {
  const effect = plan?.entitlements;
  return {
    labelEditor: effect?.labelEditorEnabled ?? false,
    publicApi: effect?.publicApiEnabled ?? false,
    pallets: effect?.palletsEnabled ?? false,
  };
}

function applyAddons(
  quotas: Record<QuotaKey, number | null>,
  features: Record<FeatureKey, boolean>,
  addons: TenantSubscriptionAddon[],
) {
  const nextQuotas = { ...quotas };
  const nextFeatures = { ...features };
  for (const addon of addons) {
    for (const effect of addon.addonVersion.effects) {
      if (
        effect.entitlementKey === "lines" ||
        effect.entitlementKey === "stations" ||
        effect.entitlementKey === "kiosks" ||
        effect.entitlementKey === "cabinetUsers"
      ) {
        const currentQuota = nextQuotas[effect.entitlementKey];
        if (currentQuota !== null && effect.quotaIncrement !== null) {
          nextQuotas[effect.entitlementKey] = currentQuota + effect.quotaIncrement * addon.quantity;
        }
      } else if (effect.featureEnabled) {
        nextFeatures[effect.entitlementKey] = true;
      }
    }
  }
  return { quotas: nextQuotas, features: nextFeatures };
}

function SubscriptionCard({
  title,
  subscription,
  financialVisible,
}: {
  title: string;
  subscription: TenantSubscription | null;
  financialVisible: boolean;
}) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage?.startsWith("en") ? "en" : "ru";
  if (!subscription) {
    return (
      <Card className="subscription-card" title={title} titleAs="h2">
        <p className="tenant-muted">{t("tenants.detail.subscription.none")}</p>
      </Card>
    );
  }
  const version = subscription.planVersion;
  return (
    <Card className="subscription-card" title={title} titleAs="h2">
      <div className="subscription-card__heading">
        <strong>{versionLabel(version, language)}</strong>
        <StatusChip
          status={subscription.status === "active" ? "ok" : "info"}
          label={t(`tenants.status.${subscription.status}`)}
        />
      </div>
      <dl className="tenant-facts">
        <div>
          <dt>{t("tenants.detail.subscription.source")}</dt>
          <dd>{t(`tenants.sources.${subscription.source}`)}</dd>
        </div>
        <div>
          <dt>{t("tenants.detail.subscription.startsAt")}</dt>
          <dd>{formatDate(subscription.startsAt, language)}</dd>
        </div>
        <div>
          <dt>{t("tenants.detail.subscription.endsAt")}</dt>
          <dd>{formatDate(subscription.endsAt, language)}</dd>
        </div>
        {financialVisible && version.unitPrice ? (
          <div>
            <dt>{t("tenants.detail.subscription.price")}</dt>
            <dd className="mono">{t("catalog.money", { value: version.unitPrice })}</dd>
          </div>
        ) : null}
      </dl>
    </Card>
  );
}

function AddonList({
  title,
  addons,
  financialVisible,
}: {
  title: string;
  addons: TenantSubscriptionAddon[];
  financialVisible: boolean;
}) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage?.startsWith("en") ? "en" : "ru";
  return (
    <section className="tenant-section" aria-label={title}>
      <h2>{title}</h2>
      {addons.length === 0 ? (
        <p className="tenant-muted">{t("tenants.detail.addons.empty")}</p>
      ) : (
        <ul className="addon-timeline">
          {addons.map((addon) => (
            <li key={addon.id}>
              <div>
                <strong>{versionLabel(addon.addonVersion, language)}</strong>
                <span>{t("tenants.detail.addons.quantity", { quantity: addon.quantity })}</span>
              </div>
              <div className="addon-timeline__term">
                <StatusChip
                  status={addon.status === "active" ? "ok" : "info"}
                  label={t(`tenants.addonStatus.${addon.status}`)}
                />
                <span>
                  {formatDate(addon.startsAt, language)} — {formatDate(addon.endsAt, language)}
                </span>
                <span>{t(`tenants.sources.${addon.source}`)}</span>
                {financialVisible && addon.addonVersion.unitPrice ? (
                  <span className="mono">
                    {t("catalog.money", { value: addon.addonVersion.unitPrice })}
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function SubscriptionPanel({
  detail,
  canDirectAssign,
  financialVisible,
  accountant,
}: {
  detail: TenantDetail;
  canDirectAssign: boolean;
  financialVisible: boolean;
  accountant: boolean;
}) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage?.startsWith("en") ? "en" : "ru";
  const queryClient = useQueryClient();
  const [confirmation, setConfirmation] = useState<ConfirmationState | null>(null);
  const [mutationMessage, setMutationMessage] = useState<{
    tone: "ok" | "error";
    key: string;
  } | null>(null);
  const form = useForm<AssignmentFormValues>({
    defaultValues: {
      kind: "plan",
      catalogVersionId: "",
      activationPolicy: "immediate",
      quantity: "1",
      endsAt: "",
      reason: "",
    },
  });
  const kind = form.watch("kind");
  const catalog = useQuery({
    queryKey: ["platform", "catalog", "assignable"],
    queryFn: listAssignableCatalogVersions,
    enabled: canDirectAssign,
  });
  const planMutation = useMutation({
    mutationFn: (input: AssignPlanInput) => assignTenantPlan(detail.tenant.id, input),
  });
  const addonMutation = useMutation({
    mutationFn: (input: AssignAddonInput) => assignTenantAddon(detail.tenant.id, input),
  });
  const mutationPending = planMutation.isPending || addonMutation.isPending;
  useUnsavedChanges(form.formState.isDirty, mutationPending);

  const effective = useMemo(
    () =>
      applyAddons(
        quotaFromPlan(detail.currentSubscription?.planVersion ?? null),
        featuresFromPlan(detail.currentSubscription?.planVersion ?? null),
        detail.activeAddons,
      ),
    [detail.activeAddons, detail.currentSubscription?.planVersion],
  );
  const currentTermEnded = Boolean(
    detail.currentSubscription?.endsAt &&
    new Date(detail.currentSubscription.endsAt).getTime() <= Date.now(),
  );
  const planSuccessorExists = detail.scheduledSubscription !== null;
  const publishedVersions = catalog.data?.items.filter((item) => item.status === "published") ?? [];
  const choices = publishedVersions.filter((item) => item.kind === kind);
  const versionOptions: ComboboxOption[] = choices.map((version) => ({
    value: version.id,
    label: versionLabel(version, language),
    keywords: [
      version.nameRu,
      version.nameEn,
      version.catalogItemCode ?? "",
      `v${version.version}`,
    ],
  }));

  const prepareConfirmation = form.handleSubmit(async (values) => {
    form.clearErrors();
    setMutationMessage(null);
    const reason = values.reason.trim();
    if (!reason) {
      form.setError("reason", { message: t("tenants.assignment.validation.reason") });
      return;
    }
    if (reason.length > 1_000) {
      form.setError("reason", { message: t("tenants.assignment.validation.reasonLong") });
      return;
    }
    const version = choices.find((item) => item.id === values.catalogVersionId);
    if (!version) {
      form.setError("catalogVersionId", {
        message: t("tenants.assignment.validation.version"),
      });
      return;
    }
    const quantity = Number(values.quantity);
    if (
      values.kind === "addon" &&
      (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 2_147_483_647)
    ) {
      form.setError("quantity", { message: t("tenants.assignment.validation.quantity") });
      return;
    }
    let endsAt: string | undefined;
    if (values.endsAt) {
      const date = new Date(values.endsAt);
      if (Number.isNaN(date.getTime())) {
        form.setError("endsAt", { message: t("tenants.assignment.validation.date") });
        return;
      }
      endsAt = date.toISOString();
    }

    let effectiveDetail = detail;
    if (values.activationPolicy === "after_current") {
      try {
        effectiveDetail = await getTenant(detail.tenant.id);
        queryClient.setQueryData(["platform", "tenants", detail.tenant.id], effectiveDetail);
      } catch {
        setMutationMessage({ tone: "error", key: "tenants.errors.assignment_failed" });
        return;
      }
    }

    const operationAt = new Date();
    let targetStart = operationAt;
    let targetSubscription: TenantSubscription | null = null;
    let currentEndsAt: string | undefined;
    if (values.activationPolicy === "after_current" && values.kind === "plan") {
      if (effectiveDetail.scheduledSubscription) {
        form.setError("activationPolicy", {
          message: t("tenants.assignment.validation.afterCurrentScheduled"),
        });
        return;
      }
      const currentEnd = effectiveDetail.currentSubscription?.endsAt;
      if (!currentEnd) {
        form.setError("activationPolicy", {
          message: t("tenants.assignment.validation.afterCurrent"),
        });
        return;
      }
      if (new Date(currentEnd).getTime() <= operationAt.getTime()) {
        form.setError("activationPolicy", {
          message: t("tenants.assignment.validation.afterCurrentEnded"),
        });
        return;
      }
      targetStart = new Date(currentEnd);
      currentEndsAt = currentEnd;
    } else if (values.kind === "addon") {
      targetSubscription =
        values.activationPolicy === "after_current"
          ? effectiveDetail.scheduledSubscription
          : effectiveDetail.currentSubscription;
      if (
        !targetSubscription ||
        !targetSubscription.startsAt ||
        (values.activationPolicy === "immediate" &&
          (targetSubscription.status === "pending_activation" ||
            new Date(targetSubscription.startsAt) > operationAt ||
            (targetSubscription.endsAt !== null &&
              new Date(targetSubscription.endsAt) <= operationAt)))
      ) {
        form.setError("activationPolicy", {
          message: t("tenants.assignment.validation.afterCurrent"),
        });
        return;
      }
      if (values.activationPolicy === "after_current") {
        targetStart = new Date(targetSubscription.startsAt);
      }
    }

    if (endsAt) {
      const end = new Date(endsAt);
      if (end <= targetStart) {
        form.setError("endsAt", { message: t("tenants.assignment.validation.term") });
        return;
      }
      if (end.getTime() - targetStart.getTime() > MAX_MANUAL_TERM_MS) {
        form.setError("endsAt", { message: t("tenants.assignment.validation.termLong") });
        return;
      }
      if (
        targetSubscription?.endsAt &&
        end.getTime() > new Date(targetSubscription.endsAt).getTime()
      ) {
        form.setError("endsAt", { message: t("tenants.assignment.validation.addonTerm") });
        return;
      }
    }

    const common = {
      catalogVersionId: version.id,
      activationPolicy: values.activationPolicy,
      ...(endsAt ? { endsAt } : {}),
      reason,
    };
    if (values.kind === "plan" && version.plan) {
      const summaries = [
        ...QUOTA_KEYS.map((key) =>
          t("tenants.assignment.confirm.quota", {
            name: t(`tenants.usage.${key}`),
            value:
              version.plan?.[
                key === "cabinetUsers"
                  ? "maxCabinetUsers"
                  : key === "lines"
                    ? "maxLines"
                    : key === "stations"
                      ? "maxStations"
                      : "maxKiosks"
              ] ?? t("tenants.usage.unlimited"),
          }),
        ),
        ...FEATURE_KEYS.map((key) =>
          t("tenants.assignment.confirm.feature", {
            name: t(`tenants.features.${key}`),
            value: t(
              `tenants.features.${
                version.plan?.[
                  key === "labelEditor"
                    ? "labelEditorEnabled"
                    : key === "publicApi"
                      ? "publicApiEnabled"
                      : "palletsEnabled"
                ]
                  ? "enabled"
                  : "disabled"
              }`,
            ),
          }),
        ),
      ];
      setConfirmation({
        kind: "plan",
        version,
        quantity: 1,
        activationPolicy: values.activationPolicy,
        reason,
        summaries,
        ...(endsAt ? { endsAt } : {}),
        ...(currentEndsAt ? { currentEndsAt } : {}),
        planInput: common,
      });
      return;
    }
    if (values.kind === "addon" && version.addon) {
      if (!targetSubscription) return;
      const targetAddons =
        values.activationPolicy === "after_current"
          ? effectiveDetail.scheduledAddons.filter(
              (addon) => addon.subscriptionId === targetSubscription.id,
            )
          : effectiveDetail.activeAddons.filter(
              (addon) => addon.subscriptionId === targetSubscription.id,
            );
      const targetEffective = applyAddons(
        quotaFromPlan(targetSubscription.planVersion),
        featuresFromPlan(targetSubscription.planVersion),
        targetAddons,
      );
      const resultingQuotas = { ...targetEffective.quotas };
      const resultingFeatures = { ...targetEffective.features };
      for (const effect of version.addon.effects) {
        if ("quotaIncrement" in effect) {
          const currentQuota = resultingQuotas[effect.key];
          if (currentQuota !== null) {
            resultingQuotas[effect.key] = currentQuota + effect.quotaIncrement * quantity;
          }
        } else {
          resultingFeatures[effect.key] = true;
        }
      }
      const summaries = [
        ...version.addon.effects.map((effect) =>
          "quotaIncrement" in effect
            ? t("tenants.assignment.confirm.resultingQuota", {
                name: t(`tenants.usage.${effect.key}`),
                value: resultingQuotas[effect.key] ?? t("tenants.usage.unlimited"),
              })
            : t("tenants.assignment.confirm.resultingFeature", {
                name: t(`tenants.features.${effect.key}`),
              }),
        ),
      ];
      setConfirmation({
        kind: "addon",
        version,
        quantity,
        activationPolicy: values.activationPolicy,
        reason,
        summaries,
        ...(endsAt ? { endsAt } : {}),
        targetSubscription: {
          id: targetSubscription.id,
          planVersion: targetSubscription.planVersion,
        },
        addonInput: {
          ...common,
          expectedSubscriptionId: targetSubscription.id,
          quantity,
        },
      });
    }
  });

  const confirmAssignment = async () => {
    if (!confirmation) return;
    setMutationMessage(null);
    if (
      confirmation.kind === "plan" &&
      confirmation.activationPolicy === "after_current" &&
      confirmation.currentEndsAt &&
      new Date(confirmation.currentEndsAt).getTime() <= Date.now()
    ) {
      setConfirmation(null);
      setMutationMessage({
        tone: "error",
        key: "tenants.assignment.validation.afterCurrentEnded",
      });
      await queryClient.invalidateQueries({
        queryKey: ["platform", "tenants", detail.tenant.id],
      });
      return;
    }
    try {
      if (confirmation.kind === "plan" && confirmation.planInput) {
        await planMutation.mutateAsync(confirmation.planInput);
      } else if (confirmation.kind === "addon" && confirmation.addonInput) {
        await addonMutation.mutateAsync(confirmation.addonInput);
      } else {
        return;
      }
      setConfirmation(null);
      form.reset();
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["platform", "tenants", detail.tenant.id],
        }),
        queryClient.invalidateQueries({ queryKey: ["platform", "tenants"] }),
      ]);
      setMutationMessage({ tone: "ok", key: "tenants.assignment.success" });
    } catch (error) {
      const code = error instanceof ApiRequestError ? error.code : null;
      setMutationMessage({
        tone: "error",
        key: tenantErrorMessageKey(confirmation.kind, code),
      });
    }
  };

  return (
    <div className="subscription-panel">
      <section className="subscription-grid" aria-label={t("tenants.detail.subscription.title")}>
        <SubscriptionCard
          title={t("tenants.detail.subscription.current")}
          subscription={detail.currentSubscription}
          financialVisible={financialVisible}
        />
        <SubscriptionCard
          title={t("tenants.detail.subscription.scheduled")}
          subscription={detail.scheduledSubscription}
          financialVisible={financialVisible}
        />
      </section>

      <Card className="usage-card" title={t("tenants.detail.usageTitle")} titleAs="h2">
        <div className="usage-grid">
          {QUOTA_KEYS.map((key) => {
            const used = detail.usage[key];
            const limit = effective.quotas[key];
            const over = limit !== null && used > limit;
            const text =
              limit === null
                ? t("tenants.usage.textUnlimited", { used })
                : over
                  ? t("tenants.usage.textOver", { used, limit, over: used - limit })
                  : t("tenants.usage.text", { used, limit });
            return (
              <article key={key} className="usage-item" data-over={over || undefined}>
                <div className="usage-item__label">
                  <strong>{t(`tenants.usage.${key}`)}</strong>
                  <span>{text}</span>
                </div>
                {limit === null ? (
                  <div className="usage-unlimited" aria-hidden="true" />
                ) : (
                  <meter
                    aria-label={`${t(`tenants.usage.${key}`)}: ${text}`}
                    min={0}
                    max={Math.max(limit, used, 1)}
                    value={Math.min(used, Math.max(limit, used, 1))}
                  />
                )}
                <StatusChip
                  status={over ? "error" : "neutral"}
                  label={over ? t("tenants.usage.over") : t("tenants.usage.within")}
                />
              </article>
            );
          })}
        </div>
        <div className="feature-summary" aria-label={t("tenants.detail.featuresTitle")}>
          {FEATURE_KEYS.map((key) => (
            <span key={key}>
              {t(`tenants.features.${key}`)}:{" "}
              {t(`tenants.features.${effective.features[key] ? "enabled" : "disabled"}`)}
            </span>
          ))}
        </div>
      </Card>

      <div className="addon-grid">
        <AddonList
          title={t("tenants.detail.addons.active")}
          addons={detail.activeAddons}
          financialVisible={financialVisible}
        />
        <AddonList
          title={t("tenants.detail.addons.scheduled")}
          addons={detail.scheduledAddons}
          financialVisible={financialVisible}
        />
      </div>

      {accountant ? <Alert tone="info">{t("tenants.assignment.accountantNotice")}</Alert> : null}

      {canDirectAssign ? (
        <Card className="assignment-card" title={t("tenants.assignment.title")} titleAs="h2">
          {catalog.isPending ? (
            <p role="status">{t("tenants.assignment.loading")}</p>
          ) : catalog.error ? (
            <Alert tone="error">{t("tenants.assignment.catalogError")}</Alert>
          ) : (
            <form
              className="assignment-form"
              noValidate
              onSubmit={(event) => void prepareConfirmation(event)}
            >
              <Select<AssignmentKind>
                label={t("tenants.assignment.kind")}
                options={[
                  { value: "plan", label: t("tenants.assignment.plan") },
                  { value: "addon", label: t("tenants.assignment.addon") },
                ]}
                value={kind}
                onValueChange={(value) => {
                  form.setValue("kind", value, { shouldDirty: true });
                  form.setValue("catalogVersionId", "", { shouldDirty: true });
                  form.clearErrors();
                }}
              />
              <Combobox
                label={t(`tenants.assignment.${kind}Version`)}
                options={versionOptions}
                value={form.watch("catalogVersionId")}
                {...(form.formState.errors.catalogVersionId?.message
                  ? { error: form.formState.errors.catalogVersionId.message }
                  : {})}
                onValueChange={(value) =>
                  form.setValue("catalogVersionId", value, {
                    shouldDirty: true,
                    shouldValidate: true,
                  })
                }
                placeholder={t("tenants.assignment.selectVersion")}
                searchPlaceholder={t("tenants.assignment.selectVersion")}
                emptyText={t("tenants.assignment.selectVersion")}
                loadingText={t("tenants.assignment.loading")}
              />
              <Select<ActivationPolicy>
                label={t("tenants.assignment.policy")}
                options={[
                  { value: "immediate", label: t("tenants.assignment.immediate") },
                  {
                    value: "after_current",
                    label: t("tenants.assignment.afterCurrent"),
                    disabled: kind === "plan" && (currentTermEnded || planSuccessorExists),
                  },
                ]}
                value={form.watch("activationPolicy")}
                {...(form.formState.errors.activationPolicy?.message
                  ? { error: form.formState.errors.activationPolicy.message }
                  : {})}
                onValueChange={(value) =>
                  form.setValue("activationPolicy", value, { shouldDirty: true })
                }
              />
              {kind === "plan" && (currentTermEnded || planSuccessorExists) ? (
                <p className="tenant-policy-note">
                  {t(
                    currentTermEnded
                      ? "tenants.assignment.validation.afterCurrentEnded"
                      : "tenants.assignment.validation.afterCurrentScheduled",
                  )}
                </p>
              ) : null}
              {kind === "addon" ? (
                <Input
                  label={t("tenants.assignment.quantity")}
                  inputMode="numeric"
                  mono
                  {...(form.formState.errors.quantity?.message
                    ? { error: form.formState.errors.quantity.message }
                    : {})}
                  {...form.register("quantity")}
                />
              ) : null}
              <Input
                label={t("tenants.assignment.endsAt")}
                type="datetime-local"
                {...(form.formState.errors.endsAt?.message
                  ? { error: form.formState.errors.endsAt.message }
                  : {})}
                {...form.register("endsAt")}
              />
              <div className="tenant-textarea-field">
                <label htmlFor="tenant-assignment-reason">{t("tenants.assignment.reason")}</label>
                <textarea
                  id="tenant-assignment-reason"
                  maxLength={1_000}
                  aria-invalid={form.formState.errors.reason ? true : undefined}
                  aria-describedby={
                    form.formState.errors.reason ? "assignment-reason-error" : undefined
                  }
                  {...form.register("reason")}
                />
                {form.formState.errors.reason ? (
                  <span id="assignment-reason-error" className="native-field__error">
                    {form.formState.errors.reason.message}
                  </span>
                ) : null}
              </div>
              <Button type="submit">{t("tenants.assignment.review")}</Button>
            </form>
          )}
          <div className="tenant-operation-status" role="status" aria-live="polite">
            {mutationMessage ? (
              <span data-tone={mutationMessage.tone}>{t(mutationMessage.key)}</span>
            ) : null}
          </div>
        </Card>
      ) : null}

      <Card className="history-card" title={t("tenants.detail.historyTitle")} titleAs="h2">
        {detail.events.length === 0 ? (
          <p className="tenant-muted">{t("tenants.detail.historyEmpty")}</p>
        ) : (
          <ol className="history-timeline">
            {detail.events.map((event) => (
              <li key={event.id}>
                <div>
                  <strong>
                    {t(`tenants.events.${event.eventKind}`, { defaultValue: event.eventKind })}
                  </strong>
                  <time dateTime={event.effectiveAt}>
                    {formatDate(event.effectiveAt, language)}
                  </time>
                </div>
                <code>{event.source}</code>
                {event.reason ? <p>{event.reason}</p> : null}
              </li>
            ))}
          </ol>
        )}
      </Card>

      <ConfirmDialog
        open={confirmation !== null}
        title={t("tenants.assignment.confirm.title")}
        description={
          confirmation ? (
            <div className="assignment-confirmation">
              <strong>{versionLabel(confirmation.version, language)}</strong>
              <span>
                {confirmation.activationPolicy === "immediate"
                  ? t("tenants.assignment.immediate")
                  : t("tenants.assignment.afterCurrent")}
              </span>
              {confirmation.kind === "addon" ? (
                <>
                  <span>
                    {t("tenants.assignment.confirm.quantity", {
                      quantity: confirmation.quantity,
                    })}
                  </span>
                  {confirmation.targetSubscription ? (
                    <>
                      <span>
                        {t("tenants.assignment.confirm.targetPlan", {
                          plan: versionLabel(confirmation.targetSubscription.planVersion, language),
                        })}
                      </span>
                      <span>
                        {t("tenants.assignment.confirm.targetSubscription", {
                          id: confirmation.targetSubscription.id,
                        })}
                      </span>
                    </>
                  ) : null}
                </>
              ) : null}
              {confirmation.endsAt ? (
                <span>
                  {t("tenants.assignment.confirm.endsAt", {
                    value: formatDate(confirmation.endsAt, language),
                  })}
                </span>
              ) : null}
              <ul>
                {confirmation.summaries.map((summary) => (
                  <li key={summary}>{summary}</li>
                ))}
              </ul>
              <span>{t("tenants.assignment.confirm.reason", { reason: confirmation.reason })}</span>
            </div>
          ) : null
        }
        entity={confirmation?.version.id}
        confirmLabel={t("tenants.assignment.confirm.submit")}
        cancelLabel={t("tenants.cancel")}
        busy={mutationPending}
        error={mutationMessage?.tone === "error" ? t(mutationMessage.key) : undefined}
        onCancel={() => setConfirmation(null)}
        onConfirm={() => void confirmAssignment()}
      />
    </div>
  );
}
