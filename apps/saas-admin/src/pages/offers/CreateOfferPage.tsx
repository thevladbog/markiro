import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, SectionHeader, Spinner } from "@markiro/ui";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router";

import { ApiRequestError } from "../../api/client.js";
import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
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
  const { requestId } = useParams();
  const [search] = useSearchParams();
  const [termsMarkdown, setTermsMarkdown] = useState<string | null>(null);
  const request = useQuery({
    queryKey: ["platform", "billing", "requests", requestId],
    queryFn: () => getBillingRequest(requestId!),
    enabled: requestId !== undefined,
  });
  const requestAttempt = useRef<{
    input: Parameters<typeof createBillingRequestOffer>[1];
  } | null>(null);
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
  const create = useMutation({
    mutationFn: async (draft: DocumentDraft) => {
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
        const retained = requestAttempt.current;
        const requestInput =
          retained?.input ??
          (() => {
            const offerInput = {
              lines: input.lines,
              ...(input.sellerBankAccountId !== undefined
                ? { sellerBankAccountId: input.sellerBankAccountId }
                : {}),
              ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
              ...(input.termsMarkdown !== undefined ? { termsMarkdown: input.termsMarkdown } : {}),
            };
            return {
              ...offerInput,
              ...(termsMarkdown ? { termsMarkdown } : {}),
              idempotencyKey: crypto.randomUUID(),
            };
          })();
        requestAttempt.current = { input: requestInput };
        try {
          const result = await createBillingRequestOffer(requestId, requestInput);
          requestAttempt.current = null;
          await Promise.all([
            client.invalidateQueries({ queryKey: ["platform", "billing", "requests"] }),
            client.invalidateQueries({
              queryKey: ["platform", "billing", "requests", requestId],
            }),
          ]);
          return result.offerId;
        } catch (error) {
          if (!retryable(error)) requestAttempt.current = null;
          throw error;
        }
      }
      const offer = await createOffer(termsMarkdown ? { ...input, termsMarkdown } : input);
      return offer.id;
    },
  });

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
          await create.mutateAsync(draft);
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
