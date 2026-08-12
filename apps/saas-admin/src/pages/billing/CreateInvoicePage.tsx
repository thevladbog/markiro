import { useMutation, useQuery } from "@tanstack/react-query";
import { Alert, PageHeader, Spinner } from "@markiro/ui";
import { useTranslation } from "react-i18next";
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router";
import { z } from "zod";

import { ApiRequestError } from "../../api/client.js";
import { listCatalogVersions, type CatalogVersionDto } from "../catalog/api.js";
import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import { DocumentComposer } from "../documents/DocumentComposer.js";
import {
  toInvoiceCreateInput,
  type DocumentDraft,
  type DocumentLineDraft,
} from "../documents/documentDraft.js";
import {
  getTenant,
  listTenants,
  tenantIdSchema,
  type TenantDetail,
  type TenantListItem,
} from "../tenants/api.js";
import { createInvoice } from "./api.js";
import { getOffer, type OfferDetail } from "../offers/api.js";

function toTenantListItem(detail: TenantDetail): TenantListItem {
  return {
    id: detail.tenant.id,
    name: detail.tenant.name,
    slug: detail.tenant.slug,
    createdAt: detail.tenant.createdAt,
    subscriptionStatus: detail.subscriptionStatus,
  };
}

function vatRateBps(value: string | null): number | null {
  if (value === null) return null;
  const match = /^(\d{1,3})\.(\d{2})$/.exec(value);
  if (!match) throw new Error("offer_vat_rate_invalid");
  const bps = BigInt(match[1]!) * 100n + BigInt(match[2]!);
  if (bps > 10_000n) throw new Error("offer_vat_rate_invalid");
  return Number(bps);
}

export function sourceOfferDraft(
  source: Pick<OfferDetail, "tenantId" | "lines">,
  catalog: readonly CatalogVersionDto[],
): DocumentDraft {
  const lines: DocumentLineDraft[] = source.lines.map((line) => {
    const version = catalog.find((candidate) => candidate.id === line.catalogVersionId);
    const sourceVatRateBps = vatRateBps(line.vatRate);
    const catalogBacked =
      version !== undefined &&
      version.kind === line.kind &&
      version.nameRu === line.nameRu &&
      version.nameEn === line.nameEn &&
      version.descriptionRu === (line.descriptionRu ?? null) &&
      version.descriptionEn === (line.descriptionEn ?? null) &&
      version.unit === line.unit &&
      (version.unitPrice ?? null) === (line.catalogUnitPrice ?? null) &&
      (version.vatRateBps ?? null) === sourceVatRateBps &&
      (version.vatIncluded ?? false) === line.vatIncluded;
    return {
      id: `offer-line-${line.id}`,
      kind: catalogBacked ? line.kind : "custom",
      catalogVersionId: catalogBacked ? line.catalogVersionId : null,
      catalogItemCode: catalogBacked ? version.catalogItemCode : "",
      version: catalogBacked ? version.version : 0,
      nameRu: line.nameRu,
      nameEn: line.nameEn,
      descriptionRu: line.descriptionRu ?? null,
      descriptionEn: line.descriptionEn ?? null,
      quantity: line.quantity,
      unit: line.unit,
      catalogUnitPrice: catalogBacked
        ? (version.unitPrice ?? null)
        : (line.catalogUnitPrice ?? null),
      agreedUnitPrice: line.agreedUnitPrice,
      vatRateBps: sourceVatRateBps,
      vatIncluded: line.vatIncluded,
      activationPolicy: catalogBacked
        ? line.activationPolicy === "immediately"
          ? "immediate"
          : line.activationPolicy
        : null,
    };
  });
  return { tenantId: source.tenantId, applicationMode: "automatic", date: "", lines };
}

export function CreateInvoicePage() {
  const principal = usePlatformPrincipal();
  if (!principal.capabilities.includes("billing.write")) {
    return <Navigate to="/billing" replace />;
  }
  return <InvoiceEditor />;
}

function InvoiceEditor() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const requestedTenant = tenantIdSchema.safeParse(search.get("tenantId")).data;
  const rawSourceOfferId = (location.state as { sourceOfferId?: unknown } | null)?.sourceOfferId;
  const sourceOfferId = z.uuid().safeParse(rawSourceOfferId).data;
  const sourceOffer = useQuery({
    queryKey: ["platform", "offers", sourceOfferId],
    queryFn: () => getOffer(sourceOfferId!),
    enabled: sourceOfferId !== undefined,
  });
  const tenants = useQuery({
    queryKey: ["platform", "tenants", "document-picker"],
    queryFn: () => listTenants({ page: 1, limit: 100 }),
  });
  const catalog = useQuery({
    queryKey: ["platform", "catalog", "document-picker"],
    queryFn: listCatalogVersions,
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
        if (error instanceof ApiRequestError && error.code === "invoice_catalog_version_invalid") {
          await catalog.refetch();
          throw new ApiRequestError(409, "Catalog version unavailable", "catalog_version_stale");
        }
        throw error;
      }
    },
  });

  if (
    tenants.isPending ||
    catalog.isPending ||
    (sourceOfferId !== undefined && sourceOffer.isPending) ||
    (needsTenantPrefetch && prefetchedTenant.isPending)
  ) {
    return (
      <section className="catalog-page">
        <PageHeader title="" />
        <Spinner label={t("shell.routeLoading")} />
      </section>
    );
  }
  if (
    tenants.error ||
    (catalog.error && !catalog.data) ||
    (sourceOfferId !== undefined && sourceOffer.error) ||
    (needsTenantPrefetch && prefetchedTenant.error)
  ) {
    return (
      <section className="catalog-page">
        <PageHeader title="" />
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
  const initialDraft: DocumentDraft = sourceOffer.data
    ? sourceOfferDraft(sourceOffer.data, catalog.data?.items ?? [])
    : { tenantId: selectedTenantId ?? "", applicationMode: "automatic", date: "", lines: [] };

  return (
    <DocumentComposer
      kind="invoice"
      initialDraft={initialDraft}
      tenants={pickerTenants}
      catalog={(catalog.data?.items ?? []).filter((version) => version.status === "published")}
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
        await create.mutateAsync(draft);
      }}
      onSuccess={() => void navigate("/billing", { state: { createdDocument: "invoice" } })}
      onCancel={() => void navigate("/billing")}
    />
  );
}
