import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, SectionHeader, Spinner } from "@markiro/ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router";
import { z } from "zod";

import { ApiRequestError } from "../../api/client.js";
import { listCatalogVersions } from "../catalog/api.js";
import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import { DocumentComposer } from "../documents/DocumentComposer.js";
import { toInvoiceCreateInput, type DocumentDraft } from "../documents/documentDraft.js";
import {
  getTenant,
  listTenants,
  tenantIdSchema,
  type TenantDetail,
  type TenantListItem,
} from "../tenants/api.js";
import { createInvoice } from "./api.js";
import { getOffer } from "../offers/api.js";
import { sourceOfferDraft } from "./sourceOfferDraft.js";
import { listOperatorBankAccounts } from "../settings/api.js";
import { getBillingRequest } from "../billing-requests/api.js";

export { sourceOfferDraft } from "./sourceOfferDraft.js";

function toTenantListItem(detail: TenantDetail): TenantListItem {
  return {
    id: detail.tenant.id,
    name: detail.tenant.name,
    slug: detail.tenant.slug,
    createdAt: detail.tenant.createdAt,
    subscriptionStatus: detail.subscriptionStatus,
  };
}

export function CreateInvoicePage() {
  const principal = usePlatformPrincipal();
  if (!principal.capabilities.includes("billing.write")) {
    return <Navigate to="/invoices" replace />;
  }
  return <InvoiceEditor />;
}

function InvoiceEditor() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [search] = useSearchParams();
  const [mutationForbidden, setMutationForbidden] = useState(false);
  const requestedTenant = tenantIdSchema.safeParse(search.get("tenantId")).data;
  const rawSourceOfferId = (location.state as { sourceOfferId?: unknown } | null)?.sourceOfferId;
  const rawSourceRequestId = (location.state as { sourceRequestId?: unknown } | null)
    ?.sourceRequestId;
  const createdInvoiceId = useRef<string | null>(null);
  const sourceOfferId = z.uuid().safeParse(rawSourceOfferId).data;
  const sourceRequestId = z.uuid().safeParse(rawSourceRequestId).data;
  const hasSourceNavigation = rawSourceOfferId !== undefined || rawSourceRequestId !== undefined;
  const invalidSourceNavigation =
    hasSourceNavigation && (sourceOfferId === undefined || sourceRequestId === undefined);
  const requestAuthority = useQuery({
    queryKey: ["platform", "billing", "requests", sourceRequestId],
    queryFn: () => getBillingRequest(sourceRequestId!),
    enabled: sourceOfferId !== undefined && sourceRequestId !== undefined,
    refetchOnMount: "always",
  });
  const authorityValid =
    requestAuthority.isFetchedAfterMount &&
    !requestAuthority.isFetching &&
    requestAuthority.data?.offerAction?.canCreateInvoice === true &&
    requestAuthority.data.offerAction.offerId === sourceOfferId &&
    requestAuthority.data.offerAction.currentOfferId === sourceOfferId;
  const staleSourceNavigation =
    sourceOfferId !== undefined &&
    sourceRequestId !== undefined &&
    requestAuthority.isFetchedAfterMount &&
    !requestAuthority.isFetching &&
    requestAuthority.isSuccess
      ? !authorityValid
      : false;
  const sourceOffer = useQuery({
    queryKey: ["platform", "offers", sourceOfferId],
    queryFn: () => getOffer(sourceOfferId!),
    enabled: sourceOfferId !== undefined && authorityValid,
  });
  useEffect(() => {
    if (
      requestAuthority.error instanceof ApiRequestError &&
      requestAuthority.error.status === 403
    ) {
      void client.invalidateQueries({ queryKey: ["platform", "me"] });
    }
  }, [client, requestAuthority.error]);
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
  const selectedTenantId = sourceOffer.data?.tenantId ?? requestedTenant;
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
      try {
        return await createInvoice(toInvoiceCreateInput(draft));
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 403) {
          setMutationForbidden(true);
          await Promise.all([
            client.invalidateQueries({ queryKey: ["platform", "me"] }),
            sourceRequestId
              ? client.invalidateQueries({ queryKey: ["platform", "billing", "requests"] })
              : Promise.resolve(),
            sourceRequestId
              ? client.invalidateQueries({
                  queryKey: ["platform", "billing", "requests", sourceRequestId],
                })
              : Promise.resolve(),
            sourceOfferId
              ? client.invalidateQueries({ queryKey: ["platform", "offers", sourceOfferId] })
              : Promise.resolve(),
          ]);
          throw error;
        }
        if (error instanceof ApiRequestError && error.code === "invoice_catalog_version_invalid") {
          await catalog.refetch();
          throw new ApiRequestError(409, "Catalog version unavailable", "catalog_version_stale");
        }
        throw error;
      }
    },
  });

  if (mutationForbidden) {
    return (
      <section className="catalog-page">
        <h1>{t("billingRequests.forbiddenTitle")}</h1>
        <Alert tone="error">{t("billingRequests.forbiddenBody")}</Alert>
      </section>
    );
  }

  if (
    tenants.isPending ||
    catalog.isPending ||
    sellerAccounts.isPending ||
    (sourceOfferId !== undefined &&
      sourceRequestId !== undefined &&
      (requestAuthority.isPending || requestAuthority.isFetching)) ||
    (authorityValid && sourceOffer.isPending) ||
    (needsTenantPrefetch && prefetchedTenant.isPending)
  ) {
    return (
      <section className="catalog-page">
        <SectionHeader
          eyebrow="COMMERCE / INVOICES / NEW"
          title={t("billing.newTitle")}
          description={t("billing.newDescription")}
        />
        <Spinner label={t("shell.routeLoading")} />
      </section>
    );
  }
  if (invalidSourceNavigation || staleSourceNavigation) {
    return (
      <section className="catalog-page">
        <SectionHeader
          eyebrow="COMMERCE / INVOICES / NEW"
          title={t("billing.newTitle")}
          description={t("billing.newDescription")}
        />
        <Alert tone="error">{t("billing.sourceUnavailable")}</Alert>
      </section>
    );
  }
  if (requestAuthority.error instanceof ApiRequestError && requestAuthority.error.status === 403) {
    return (
      <section className="catalog-page">
        <h1>{t("billingRequests.forbiddenTitle")}</h1>
        <Alert tone="error">{t("billingRequests.forbiddenBody")}</Alert>
      </section>
    );
  }
  if (
    tenants.error ||
    sellerAccounts.error ||
    (catalog.error && !catalog.data) ||
    (sourceRequestId !== undefined && requestAuthority.error) ||
    (authorityValid && sourceOffer.error) ||
    (needsTenantPrefetch && prefetchedTenant.error)
  ) {
    return (
      <section className="catalog-page">
        <SectionHeader
          eyebrow="COMMERCE / INVOICES / NEW"
          title={t("billing.newTitle")}
          description={t("billing.newDescription")}
        />
        <Alert tone="error">{t("documents.errors.loadInvoiceEditor")}</Alert>
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
  const initialDraft: DocumentDraft =
    sourceOffer.data && sourceRequestId
      ? sourceOfferDraft({ ...sourceOffer.data, sourceRequestId }, catalog.data?.items ?? [])
      : { tenantId: selectedTenantId ?? "", applicationMode: "automatic", date: "", lines: [] };

  return (
    <DocumentComposer
      kind="invoice"
      initialDraft={initialDraft}
      tenants={pickerTenants}
      catalog={(catalog.data?.items ?? []).filter((version) => version.status === "published")}
      sellerAccounts={sellerAccounts.data ?? []}
      loadingSellerAccounts={sellerAccounts.isPending}
      loadingSources={false}
      submitting={create.isPending}
      {...(create.error
        ? {
            submitError:
              create.error instanceof ApiRequestError &&
              create.error.code === "catalog_version_stale"
                ? t("documents.errors.catalogVersionStale")
                : t("documents.errors.createInvoice"),
          }
        : {})}
      onSubmit={async (draft) => {
        const invoice = await create.mutateAsync(draft);
        createdInvoiceId.current = invoice.id;
      }}
      onSuccess={() => {
        const invoiceId = createdInvoiceId.current;
        if (invoiceId) void navigate(`/invoices/${invoiceId}`);
      }}
      onCancel={() => void navigate("/invoices")}
    />
  );
}
