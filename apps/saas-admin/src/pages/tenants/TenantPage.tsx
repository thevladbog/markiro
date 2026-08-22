import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useParams, useSearchParams } from "react-router";

import { Alert, Button, Card, ConfirmDialog, PageHeader, StatusChip } from "@markiro/ui";

import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import { PanelState } from "../../components/PanelState.js";
import { getTenant, renewOwnerActivation, tenantIdSchema } from "./api.js";
import { tenantErrorMessageKey } from "./errorMessages.js";
import { SubscriptionPanel } from "./SubscriptionPanel.js";
import { TenantLegalPanel } from "./TenantLegalPanel.js";
import { useUnsavedChanges } from "./useUnsavedChanges.js";

const STATUS_TONE = {
  pending_activation: "warn",
  scheduled: "info",
  trial: "info",
  active: "ok",
  expired: "error",
  superseded: "neutral",
  cancelled: "neutral",
  unmanaged: "warn",
} as const;

export function TenantPage() {
  const { t, i18n } = useTranslation();
  const principal = usePlatformPrincipal();
  const queryClient = useQueryClient();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { tenantId = "" } = useParams();
  const validTenantId = tenantIdSchema.safeParse(tenantId);
  const tenant = useQuery({
    queryKey: ["platform", "tenants", tenantId],
    queryFn: () => getTenant(tenantId),
    enabled: validTenantId.success,
  });
  const [renewOpen, setRenewOpen] = useState(false);
  const [renewMessage, setRenewMessage] = useState<{
    tone: "ok" | "error";
    key: string;
  } | null>(null);
  const renew = useMutation({
    mutationFn: () => renewOwnerActivation(tenantId),
    onSuccess: async () => {
      setRenewOpen(false);
      setRenewMessage({ tone: "ok", key: "tenants.detail.activation.renewed" });
      await queryClient.invalidateQueries({ queryKey: ["platform", "tenants", tenantId] });
    },
    onError: (error) => {
      setRenewMessage({
        tone: "error",
        key: tenantErrorMessageKey("renew", error),
      });
    },
  });
  useUnsavedChanges(false, renew.isPending);

  if (!validTenantId.success) {
    return (
      <section className="tenant-detail-page">
        <PageHeader title={t("tenants.detail.invalidTitle")} />
        <Alert tone="error">{t("tenants.detail.invalidId")}</Alert>
      </section>
    );
  }

  if (tenant.isPending) {
    return (
      <section className="tenant-detail-page">
        <PageHeader title={t("tenants.detail.loadingTitle")} />
        <PanelState loading empty={false} error={null} loadingText={t("tenants.detail.loading")}>
          {null}
        </PanelState>
      </section>
    );
  }

  if (tenant.error || !tenant.data) {
    return (
      <section className="tenant-detail-page">
        <PageHeader title={t("tenants.detail.loadErrorTitle")} />
        <PanelState
          loading={false}
          empty={false}
          error={tenant.error ?? new Error("tenant_detail_unavailable")}
          onRetry={() => void tenant.refetch()}
        >
          {null}
        </PanelState>
      </section>
    );
  }

  const detail = tenant.data;
  const canRenew =
    principal.role !== "accountant" &&
    principal.capabilities.includes("tenants.write") &&
    detail.ownerActivation !== null &&
    !detail.ownerActivation.emailVerified;
  const renewSending = detail.ownerActivation?.status === "sending";
  const canDirectAssign = principal.role === "platform_admin";
  const financialVisible = principal.role !== "support";
  const activeTab = searchParams.get("tab") === "legal" && financialVisible ? "legal" : "overview";
  const language = i18n.resolvedLanguage?.startsWith("en") ? "en" : "ru";
  const createdNotice =
    (location.state as { tenantCreated?: unknown } | null)?.tenantCreated === true;

  return (
    <section className="tenant-detail-page">
      <div className="tenant-detail-backline">
        <Link to="/tenants">{t("tenants.detail.back")}</Link>
      </div>
      <PageHeader
        title={detail.tenant.name}
        actions={
          <>
            <StatusChip
              status={STATUS_TONE[detail.subscriptionStatus]}
              label={t(`tenants.status.${detail.subscriptionStatus}`)}
            />
            {principal.capabilities.includes("billing.write") ? (
              <>
                <Link to={`/billing/new?tenantId=${detail.tenant.id}`}>
                  {t("tenants.detail.createInvoice")}
                </Link>
                <Link to={`/offers/new?tenantId=${detail.tenant.id}`}>
                  {t("tenants.detail.createOffer")}
                </Link>
              </>
            ) : null}
          </>
        }
      />
      <div className="tenant-detail-coordinate" aria-hidden="true">
        TENANT / {detail.tenant.slug.toUpperCase()}
      </div>
      {createdNotice ? <Alert tone="ok">{t("tenants.detail.createdPending")}</Alert> : null}
      {detail.subscriptionStatus === "pending_activation" ? (
        <Alert tone="warn">{t("tenants.detail.pendingActivation")}</Alert>
      ) : null}

      <div
        className="tenant-detail-tabs"
        role="tablist"
        aria-label={t("tenants.detail.tabs.label")}
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "overview"}
          onClick={() => setSearchParams({})}
        >
          <span aria-hidden="true">01</span>
          {t("tenants.detail.tabs.overview")}
        </button>
        {financialVisible ? (
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "legal"}
            onClick={() => setSearchParams({ tab: "legal" })}
          >
            <span aria-hidden="true">02</span>
            {t("tenants.detail.tabs.legal")}
          </button>
        ) : null}
      </div>

      {activeTab === "overview" ? (
        <>
          <Card
            className="tenant-overview-card"
            title={t("tenants.detail.overviewTitle")}
            titleAs="h2"
          >
            <div className="tenant-overview-grid">
              <dl className="tenant-facts">
                <div>
                  <dt>{t("tenants.detail.slug")}</dt>
                  <dd className="mono">{detail.tenant.slug}</dd>
                </div>
                <div>
                  <dt>{t("tenants.detail.createdAt")}</dt>
                  <dd>
                    {new Intl.DateTimeFormat(language === "en" ? "en-GB" : "ru-RU", {
                      dateStyle: "medium",
                      timeZone: "Europe/Moscow",
                    }).format(new Date(detail.tenant.createdAt))}
                  </dd>
                </div>
              </dl>
              <section className="owner-activation" aria-labelledby="owner-activation-title">
                <h3 id="owner-activation-title">{t("tenants.detail.activation.title")}</h3>
                {detail.ownerActivation ? (
                  <>
                    <strong>{detail.ownerActivation.ownerEmail}</strong>
                    <span>
                      {detail.ownerActivation.emailVerified
                        ? t("tenants.detail.activation.activated")
                        : t(`tenants.detail.activation.status.${detail.ownerActivation.status}`, {
                            defaultValue: detail.ownerActivation.status,
                          })}
                    </span>
                    {canRenew ? (
                      <Button
                        variant="secondary"
                        disabled={renewSending}
                        onClick={() => setRenewOpen(true)}
                      >
                        {t("tenants.detail.activation.renew")}
                      </Button>
                    ) : null}
                    {canRenew && renewSending ? (
                      <span>{t("tenants.detail.activation.sendingBlocked")}</span>
                    ) : null}
                  </>
                ) : (
                  <span>{t("tenants.detail.activation.missing")}</span>
                )}
                <div className="tenant-operation-status" role="status" aria-live="polite">
                  {renewMessage ? (
                    <span data-tone={renewMessage.tone}>{t(renewMessage.key)}</span>
                  ) : null}
                </div>
              </section>
            </div>
          </Card>

          <SubscriptionPanel
            detail={detail}
            canDirectAssign={canDirectAssign}
            financialVisible={financialVisible}
            accountant={principal.role === "accountant"}
          />
        </>
      ) : (
        <TenantLegalPanel
          tenantId={detail.tenant.id}
          canWrite={principal.capabilities.includes("billing.write")}
        />
      )}

      <ConfirmDialog
        open={renewOpen}
        title={t("tenants.detail.activation.confirmTitle")}
        description={
          <div className="renew-confirmation">
            <span>{t("tenants.detail.activation.confirmBody")}</span>
            <strong>{detail.ownerActivation?.ownerEmail}</strong>
          </div>
        }
        confirmLabel={t("tenants.detail.activation.confirm")}
        cancelLabel={t("tenants.cancel")}
        busy={renew.isPending}
        error={renewMessage?.tone === "error" ? t(renewMessage.key) : undefined}
        onCancel={() => setRenewOpen(false)}
        onConfirm={() => renew.mutate()}
      />
    </section>
  );
}
