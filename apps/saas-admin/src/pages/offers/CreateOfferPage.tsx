import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, SectionHeader, Spinner } from "@markiro/ui";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router";

import { ApiRequestError } from "../../api/client.js";
import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import { useNavigationGuard } from "../../layout/NavigationGuard.js";
import { listCatalogVersions } from "../catalog/api.js";
import { DocumentComposer } from "../documents/DocumentComposer.js";
import { toOfferCreateInput, type DocumentDraft } from "../documents/documentDraft.js";
import {
  getTenant,
  listTenants,
  tenantIdSchema,
  type TenantDetail,
  type TenantListItem,
} from "../tenants/api.js";
import { createOffer } from "./api.js";
import { OfferTermsEditor } from "./OfferTermsEditor.js";
import { listOperatorBankAccounts } from "../settings/api.js";
import { createBillingRequestOffer, getBillingRequest } from "../billing-requests/api.js";

function toTenantListItem(detail: TenantDetail): TenantListItem {
  return {
    id: detail.tenant.id,
    name: detail.tenant.name,
    slug: detail.tenant.slug,
    createdAt: detail.tenant.createdAt,
    subscriptionStatus: detail.subscriptionStatus,
  };
}

export function CreateOfferPage() {
  const principal = usePlatformPrincipal();
  if (!principal.capabilities.includes("billing.write")) {
    return <Navigate to="/offers" replace />;
  }
  return <OfferEditor />;
}

function OfferEditor() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const retryNavigation = useNavigationGuard(false, false);
  const { requestId } = useParams();
  const [search] = useSearchParams();
  const [termsMarkdown, setTermsMarkdown] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const retryPending = useRef(false);
  const request = useQuery({
    queryKey: ["platform", "billing", "requests", requestId],
    queryFn: () => getBillingRequest(requestId!),
    enabled: requestId !== undefined,
  });
  const [requestAttempt, setRequestAttempt] = useState<{
    input: Parameters<typeof createBillingRequestOffer>[1];
  } | null>(null);
  const [requestAttemptUncertain, setRequestAttemptUncertain] = useState(false);
  const selectedTenantId =
    request.data?.tenantId ?? tenantIdSchema.safeParse(search.get("tenantId")).data;
  const tenants = useQuery({
    queryKey: ["platform", "tenants", "document-picker"],
    queryFn: () => listTenants({ page: 1, limit: 100 }),
  });
  const catalog = useQuery({
    queryKey: ["platform", "catalog", "document-picker"],
    queryFn: listCatalogVersions,
  });
  const sellerAccounts = useQuery({
    queryKey: ["platform", "billing", "operator", "accounts"],
    queryFn: listOperatorBankAccounts,
  });
  const selectedTenantOnPage =
    tenants.data?.items.some((tenant) => tenant.id === selectedTenantId) ?? false;
  const needsTenantPrefetch =
    selectedTenantId !== undefined && tenants.isSuccess && !selectedTenantOnPage;
  const prefetchedTenant = useQuery({
    queryKey: ["platform", "tenants", selectedTenantId],
    queryFn: () => getTenant(selectedTenantId!),
    enabled: needsTenantPrefetch,
  });
  const invalidateRequestAuthority = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["platform", "billing", "requests"] }),
      requestId
        ? client.invalidateQueries({
            queryKey: ["platform", "billing", "requests", requestId],
          })
        : Promise.resolve(),
    ]);
  };
  const create = useMutation({
    mutationFn: async (
      attempt:
        | { kind: "draft"; draft: DocumentDraft }
        | {
            kind: "request-retry";
            input: Parameters<typeof createBillingRequestOffer>[1];
          },
    ) => {
      if (attempt.kind === "request-retry") {
        if (!requestId) throw new Error("Request offer retry requires request identity");
        setRequestAttemptUncertain(false);
        try {
          const result = await createBillingRequestOffer(requestId, attempt.input);
          setRequestAttempt(null);
          await invalidateRequestAuthority();
          return result.offerId;
        } catch (error) {
          if (isForbidden(error)) {
            setForbidden(true);
            await Promise.all([
              client.invalidateQueries({ queryKey: ["platform", "me"] }),
              invalidateRequestAuthority(),
            ]);
          } else if (!retryable(error)) {
            setRequestAttempt(null);
            await invalidateRequestAuthority();
          } else {
            setRequestAttemptUncertain(true);
          }
          throw error;
        }
      }
      const { draft } = attempt;
      const refreshedCatalog = await catalog.refetch();
      if (refreshedCatalog.isError) {
        throw new ApiRequestError(503, "Catalog refresh failed", "catalog_refresh_failed");
      }
      const publishedIds = new Set(
        (refreshedCatalog.data?.items ?? [])
          .filter((version) => version.status === "published")
          .map((version) => version.id),
      );
      if (
        draft.lines.some(
          (line) => line.catalogVersionId !== null && !publishedIds.has(line.catalogVersionId),
        )
      ) {
        throw new ApiRequestError(409, "Catalog version unavailable", "catalog_version_stale");
      }
      const input = toOfferCreateInput(draft);
      if (requestId) {
        const offerInput = {
          lines: input.lines,
          ...(input.sellerBankAccountId !== undefined
            ? { sellerBankAccountId: input.sellerBankAccountId }
            : {}),
          ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
          ...(input.termsMarkdown !== undefined ? { termsMarkdown: input.termsMarkdown } : {}),
        };
        const requestInput = {
          ...offerInput,
          ...(termsMarkdown ? { termsMarkdown } : {}),
          idempotencyKey: crypto.randomUUID(),
        };
        setRequestAttempt({ input: requestInput });
        setRequestAttemptUncertain(false);
        try {
          const result = await createBillingRequestOffer(requestId, requestInput);
          setRequestAttempt(null);
          await invalidateRequestAuthority();
          return result.offerId;
        } catch (error) {
          if (isForbidden(error)) {
            setForbidden(true);
            await Promise.all([
              client.invalidateQueries({ queryKey: ["platform", "me"] }),
              invalidateRequestAuthority(),
            ]);
          } else if (!retryable(error)) {
            setRequestAttempt(null);
            await invalidateRequestAuthority();
          } else {
            setRequestAttemptUncertain(true);
          }
          throw error;
        }
      }
      const offer = await createOffer(termsMarkdown ? { ...input, termsMarkdown } : input);
      return offer.id;
    },
  });

  if (forbidden) {
    return (
      <section className="catalog-page">
        <h1>{t("billingRequests.forbiddenTitle")}</h1>
        <Alert tone="error">{t("billingRequests.forbiddenBody")}</Alert>
      </section>
    );
  }

  if (
    tenants.isPending ||
    (requestId !== undefined && request.isPending) ||
    catalog.isPending ||
    sellerAccounts.isPending ||
    (needsTenantPrefetch && prefetchedTenant.isPending)
  ) {
    return (
      <section className="catalog-page">
        <SectionHeader
          eyebrow="COMMERCE / OFFERS / NEW"
          title={t("offers.newTitle")}
          description={t("offers.newDescription")}
        />
        <Spinner label={t("shell.routeLoading")} />
      </section>
    );
  }
  if (request.error instanceof ApiRequestError && request.error.status === 403) {
    return (
      <section className="catalog-page">
        <h1>{t("billingRequests.forbiddenTitle")}</h1>
        <Alert tone="error">{t("billingRequests.forbiddenBody")}</Alert>
      </section>
    );
  }
  if (
    tenants.error ||
    (requestId !== undefined && request.error) ||
    sellerAccounts.error ||
    (catalog.error && !catalog.data) ||
    (needsTenantPrefetch && prefetchedTenant.error)
  ) {
    return (
      <section className="catalog-page">
        <SectionHeader
          eyebrow="COMMERCE / OFFERS / NEW"
          title={t("offers.newTitle")}
          description={t("offers.newDescription")}
        />
        <Alert tone="error">{t("documents.errors.loadOfferEditor")}</Alert>
      </section>
    );
  }

  const pickerTenants = [...(tenants.data?.items ?? [])];
  if (
    prefetchedTenant.data &&
    !pickerTenants.some((tenant) => tenant.id === prefetchedTenant.data.tenant.id)
  ) {
    pickerTenants.push(toTenantListItem(prefetchedTenant.data));
  }
  const initialDraft: DocumentDraft = {
    tenantId: selectedTenantId ?? "",
    applicationMode: "automatic",
    date: "",
    lines: [],
  };

  if (requestId && requestAttempt) {
    return (
      <section className="catalog-page">
        <SectionHeader
          eyebrow="COMMERCE / OFFERS / RETRY"
          title={t("offers.newTitle")}
          description={t("offers.requestRetry.frozen")}
        />
        <Alert tone={requestAttemptUncertain ? "error" : "info"}>
          {t(
            requestAttemptUncertain
              ? "offers.requestRetry.ambiguous"
              : "offers.requestRetry.sending",
          )}
        </Alert>
        <p>{t("offers.requestRetry.lines", { count: requestAttempt.input.lines.length })}</p>
        {requestAttemptUncertain ? (
          <div className="commerce-actions">
            <Button
              type="button"
              loading={create.isPending}
              disabled={create.isPending}
              onClick={() => {
                if (retryPending.current) return;
                retryPending.current = true;
                void create
                  .mutateAsync({ kind: "request-retry", input: requestAttempt.input })
                  .then((offerId) => {
                    retryNavigation.allowNextNavigation();
                    return navigate(`/offers?selected=${offerId}`);
                  })
                  .catch(() => undefined)
                  .finally(() => {
                    retryPending.current = false;
                  });
              }}
            >
              {t("offers.requestRetry.retry")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={create.isPending}
              onClick={() => {
                void invalidateRequestAuthority().then(() => {
                  retryNavigation.allowNextNavigation();
                  return navigate(`/billing-requests/${requestId}`);
                });
              }}
            >
              {t("offers.requestRetry.reconcile")}
            </Button>
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <div className="offer-editor">
      <OfferTermsEditor
        value={termsMarkdown}
        onChange={setTermsMarkdown}
        label={t("offers.terms.label")}
      />
      <DocumentComposer
        kind="offer"
        initialDraft={initialDraft}
        tenants={pickerTenants}
        catalog={(catalog.data?.items ?? []).filter((version) => version.status === "published")}
        sellerAccounts={sellerAccounts.data ?? []}
        loadingSellerAccounts={sellerAccounts.isPending}
        loadingSources={false}
        {...(requestId && selectedTenantId ? { lockedTenantId: selectedTenantId } : {})}
        submitting={create.isPending}
        {...(create.error
          ? {
              submitError:
                create.error instanceof ApiRequestError &&
                create.error.code === "catalog_version_stale"
                  ? t("documents.errors.catalogVersionStale")
                  : t("documents.errors.createOffer"),
            }
          : {})}
        onSubmit={async (draft) => {
          await create.mutateAsync({ kind: "draft", draft });
        }}
        onSuccess={() => {
          const offerId = create.data;
          if (requestId && offerId) void navigate(`/offers?selected=${offerId}`);
          else void navigate("/offers", { state: { createdDocument: "offer" } });
        }}
        onCancel={() => void navigate("/offers")}
      />
    </div>
  );
}

function retryable(error: unknown): boolean {
  return error instanceof ApiRequestError && (error.status === null || error.status >= 500);
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 403;
}
