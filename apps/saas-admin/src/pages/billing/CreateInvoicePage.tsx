import { useMutation, useQuery } from "@tanstack/react-query";
import { Alert, PageHeader, Spinner } from "@markiro/ui";
import { useTranslation } from "react-i18next";
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router";
import { z } from "zod";

import { ApiRequestError } from "../../api/client.js";
import { listCatalogVersions } from "../catalog/api.js";
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
import { getOffer } from "../offers/api.js";

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

function copyOfferLines(
  lines: readonly {
    id: string;
    kind: "plan" | "addon" | "service";
    catalogVersionId: string | null;
    nameRu: string;
    nameEn: string;
    quantity: number;
    unit: string;
    agreedUnitPrice: string;
    vatRate: string | null;
    vatIncluded: boolean;
    activationPolicy: "immediately" | "after_current" | null;
  }[],
): DocumentLineDraft[] {
  return lines.map((line) => {
    const catalogBacked = line.catalogVersionId !== null;
    return {
      id: `offer-line-${line.id}`,
      kind: catalogBacked ? line.kind : "custom",
      catalogVersionId: line.catalogVersionId,
      catalogItemCode: "",
      version: 0,
      nameRu: line.nameRu,
      nameEn: line.nameEn,
      quantity: line.quantity,
      unit: line.unit,
      agreedUnitPrice: line.agreedUnitPrice,
      vatRateBps: vatRateBps(line.vatRate),
      vatIncluded: line.vatIncluded,
      activationPolicy: catalogBacked
        ? line.activationPolicy === "immediately"
          ? "immediate"
          : line.activationPolicy
        : null,
    };
  });
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
    catalog.error ||
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
  const initialDraft: DocumentDraft = {
    tenantId: selectedTenantId ?? "",
    applicationMode: "automatic",
    date: "",
    lines: sourceOffer.data ? copyOfferLines(sourceOffer.data.lines) : [],
  };

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
