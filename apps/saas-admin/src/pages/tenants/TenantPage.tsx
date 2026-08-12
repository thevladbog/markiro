import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useParams } from "react-router";

import { Alert, Button, Card, ConfirmDialog, PageHeader, Spinner, StatusChip } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import { getTenant, renewOwnerActivation, tenantIdSchema } from "./api.js";
import { tenantErrorMessageKey } from "./errorMessages.js";
import { SubscriptionPanel } from "./SubscriptionPanel.js";
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
      const code = error instanceof ApiRequestError ? error.code : null;
      setRenewMessage({
        tone: "error",
        key: tenantErrorMessageKey("renew", code),
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
        <div className="tenant-list-state" role="status">
          <Spinner label={t("tenants.detail.loading")} />
          <span>{t("tenants.detail.loading")}</span>
        </div>
      </section>
    );
  }

  if (tenant.error || !tenant.data) {
    return (
      <section className="tenant-detail-page">
        <PageHeader title={t("tenants.detail.loadErrorTitle")} />
        <Alert tone="error">{t("tenants.detail.loadError")}</Alert>
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

      <Card className="tenant-overview-card" title={t("tenants.detail.overviewTitle")} titleAs="h2">
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
